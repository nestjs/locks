/**
 * `@nestjs/locks/testing`: the `LockStore` contract as test cases, for any test runner.
 * Every store the package documents passes it (the in-memory default, the Drizzle and Redis
 * recipes); run it against yours:
 *
 * ```ts
 * import { lockStoreContract } from '@nestjs/locks/testing';
 *
 * describe('DrizzleLockStore', () => {
 *   const cases = lockStoreContract(() => new DrizzleLockStore(db, new LocksStorage()), { concurrent: true });
 *   for (const c of cases) it(c.name, c.run);
 * });
 * ```
 *
 * Each case throws (an `AssertionError`) on failure. The cases use their own random keys, so
 * they may share one store and one table.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { LockAcquireResult, LockStore } from '../interfaces/lock-store.interface.js';

export interface LockStoreContractOptions {
  /**
   * Moves the store's clock forward by `ms`, for the expiry cases. For the in-memory store
   * on a `ManualLockClock`: `(ms) => clock.advance(ms)`. Default: wait in real time (the
   * expiry cases then take about twenty-five seconds in total), for a store on a server's clock
   * (Redis, PostgreSQL).
   */
  advanceTime?: (ms: number) => unknown;
  /**
   * The locks' time to live in the expiry cases, in ms (default `2500`). A case checks that a
   * lock is still held halfway through its ttl, leaving the other half for the round trips,
   * and that it is free a sixth past it (the default also catches a store that rounds
   * expiry to whole seconds). Raise it for a store whose calls take longer (a remote
   * server), or the expiry cases turn flaky; they then take proportionally longer in real
   * time. Irrelevant with `advanceTime`.
   */
  ttl?: number;
  /**
   * Also run the concurrency cases: many callers race for one key (a free one, an expired
   * lock), `acquire()` races `release()` and `renew()`, and rounds of races hand out growing
   * tokens. A store that reads and then writes in two steps fails them. `true` uses 16
   * callers per race. Run them where calls really overlap: a connection pool, not one
   * connection that serializes every statement (though that is a valid run too).
   */
  concurrent?: boolean | { callers?: number };
}

export interface LockStoreContractCase {
  name: string;
  run: () => Promise<void>;
}

/** 30 days in ms: past a 32-bit integer (2,147,483,647). */
const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

/**
 * The `LockStore` contract as runner-agnostic cases. `createStore` is called once per case;
 * it may return the same store every time.
 */
export function lockStoreContract(
  createStore: () => LockStore | Promise<LockStore>,
  options: LockStoreContractOptions = {},
): LockStoreContractCase[] {
  const advanceTime = options.advanceTime ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const advance = async (ms: number) => {
    await advanceTime(ms);
  };
  const callers = options.concurrent === true ? 16 : options.concurrent ? (options.concurrent.callers ?? 16) : 0;
  if (options.concurrent && (!Number.isInteger(callers) || callers < 2)) {
    throw new RangeError(`lockStoreContract(): concurrent.callers must be an integer of at least 2, got ${callers}`);
  }

  /** The locks' time to live in the expiry cases. */
  const TTL = options.ttl ?? 2_500;
  if (!Number.isInteger(TTL) || TTL < 100) {
    throw new RangeError(`lockStoreContract(): ttl must be a whole number of milliseconds, at least 100, got ${TTL}`);
  }

  /** When a lock is checked to be still held: halfway, so half the ttl is left for the round trips. */
  const HELD_AT = Math.floor(TTL / 2);
  /** When a lock is checked to have expired: a sixth past its ttl (before a store that rounds to seconds lets it go). */
  const FREE_AT = TTL + Math.floor(TTL / 6);
  /** The ttl where expiry isn't the point: long enough that a slow round trip can't expire the lock. */
  const LONG = 60_000;

  const cases: LockStoreContractCase[] = [];
  /** A case gets a fresh store and a key prefix of its own. */
  const test = (name: string, body: (store: LockStore, key: (name: string) => string) => Promise<void>) => {
    cases.push({
      name,
      run: async () => {
        const prefix = `contract-${randomUUID()}:`;
        await body(await createStore(), (name) => prefix + name);
      },
    });
  };

  test('acquire() takes a free key once: nobody else, not even the same owner, takes it again', async (store, key) => {
    const k = key('k');
    const first = expectAcquired(await store.acquire(k, 'a', LONG), 'acquire() of a free key');
    expectRefused(await store.acquire(k, 'b', LONG), 'acquire() by another owner');
    expectRefused(await store.acquire(k, 'a', LONG), 'acquire() by the owner itself (a lock is taken once)');
    assert.ok(first >= 1, `the first fencing token must be at least 1, got ${first}`);
  });

  test('release() frees the key for its owner only, and the next token is greater', async (store, key) => {
    const k = key('k');
    const first = expectAcquired(await store.acquire(k, 'a', LONG), 'acquire()');
    assert.equal(await store.release(k, 'b'), false, 'release() by another owner');
    expectRefused(await store.acquire(k, 'b', LONG), 'acquire() after another owner\'s release()');
    assert.equal(await store.release(k, 'a'), true, 'release() by the owner');
    assert.equal(await store.release(k, 'a'), false, 'release() of a released lock');
    const second = expectAcquired(await store.acquire(k, 'b', LONG), 'acquire() after release()');
    assert.ok(second > first, `fencing tokens must grow: ${second} after ${first}`);
  });

  test('renew(), release() and acquire() of a key without a lock', async (store, key) => {
    const k = key('missing');
    assert.equal(await store.renew(k, 'a', LONG), false, 'renew() of a missing key');
    assert.equal(await store.release(k, 'a'), false, 'release() of a missing key');
    expectAcquired(await store.acquire(k, 'a', LONG), 'acquire() afterwards');
  });

  test('renew() extends the lock for its owner only', async (store, key) => {
    const k = key('k');
    expectAcquired(await store.acquire(k, 'a', TTL), 'acquire()');
    await advance(HELD_AT);
    assert.equal(await store.renew(k, 'a', TTL), true, 'renew() by the owner');
    assert.equal(await store.renew(k, 'b', TTL), false, 'renew() by another owner');
    await advance(HELD_AT); // past the first expiry, before the renewed one
    expectRefused(await store.acquire(k, 'b', TTL), 'acquire() after the renewal, before the renewed expiry');
    await advance(FREE_AT - HELD_AT); // past the renewed expiry
    assert.equal(await store.renew(k, 'a', TTL), false, 'renew() of an expired lock (it must not come back)');
    expectAcquired(await store.acquire(k, 'b', LONG), 'acquire() once it expired');
  });

  test('a lock expires after ttl, measured from the call, in milliseconds', async (store, key) => {
    const k = key('k');
    expectAcquired(await store.acquire(k, 'a', TTL), 'acquire()');
    await advance(HELD_AT);
    expectRefused(await store.acquire(k, 'b', TTL), `acquire() ${HELD_AT}ms in (a ${TTL}ms lock)`);
    await advance(FREE_AT - HELD_AT);
    expectAcquired(await store.acquire(k, 'b', LONG), `acquire() ${FREE_AT}ms in (a ${TTL}ms lock)`);
  });

  test('an expired lock is taken over with a greater token, and its owner is fenced off', async (store, key) => {
    const k = key('k');
    const stale = expectAcquired(await store.acquire(k, 'paused', TTL), 'acquire()');
    await advance(FREE_AT);
    const next = expectAcquired(await store.acquire(k, 'next', LONG), 'acquire() of an expired lock');
    assert.ok(next > stale, `the new holder's token must be greater than the stale one's: ${next} after ${stale}`);
    assert.equal(await store.renew(k, 'paused', TTL), false, 'renew() by the stale owner');
    assert.equal(await store.release(k, 'paused'), false, 'release() by the stale owner');
    expectRefused(await store.acquire(k, 'other', LONG), 'acquire() of the new holder\'s lock');
    assert.equal(await store.release(k, 'next'), true, 'release() by the new holder');
  });

  test('an owner whose lock expired can no longer release it', async (store, key) => {
    const k = key('k');
    expectAcquired(await store.acquire(k, 'a', TTL), 'acquire()');
    await advance(FREE_AT);
    assert.equal(await store.release(k, 'a'), false, 'release() of an expired lock');
    expectAcquired(await store.acquire(k, 'b', LONG), 'acquire() afterwards');
  });

  test('fencing tokens grow with every acquisition of a key, however it was freed', async (store, key) => {
    const k = key('k');
    const tokens: number[] = [];

    for (let i = 0; i < 5; i++) {
      tokens.push(expectAcquired(await store.acquire(k, `release-${i}`, LONG), `acquire() #${i + 1}`));
      assert.equal(await store.release(k, `release-${i}`), true, `release() #${i + 1}`);
    }

    tokens.push(expectAcquired(await store.acquire(k, 'expires', TTL), 'acquire() of a lock that will expire'));
    await advance(FREE_AT);
    tokens.push(expectAcquired(await store.acquire(k, 'after-expiry', LONG), 'acquire() after the expiry'));
    for (let i = 1; i < tokens.length; i++) {
      assert.ok(tokens[i]! > tokens[i - 1]!, `fencing tokens must grow with every acquisition: ${tokens.join(', ')}`);
    }
  });

  test('keeps keys apart exactly, however similar or long', async (store, key) => {
    // Hundreds of characters, multibyte ones among them: under the 2,704-byte limit of a
    // PostgreSQL btree entry, a primary key on the raw key works.
    const long = printable(500);
    const names = [
      'k', 'K', 'k ', ' k', 'k\t', 'jobs:export', 'jobs%3Aexport', 'jobs:export:owner', 'ключ', 'klucz-ż', '🔒',
      '\u00e9', 'e\u0301', '__proto__', 'constructor', 'toString', `${long}x`, `${long}y`, `y${long}`,
    ];
    for (const [i, name] of names.entries()) {
      expectAcquired(await store.acquire(key(name), `owner-${i}`, LONG), `acquire() of key #${i}`);
    }

    for (const [i, name] of names.entries()) {
      expectRefused(
        await store.acquire(key(name), 'other', LONG),
        `acquire() of key #${i} again (${JSON.stringify(name.slice(0, 20))})`,
      );
      assert.equal(await store.release(key(name), `owner-${i}`), true, `release() of key #${i} by its own owner`);
    }
  });

  test('takes durations of weeks, past a 32-bit integer', async (store, key) => {
    const k = key('k');
    expectAcquired(await store.acquire(k, 'a', THIRTY_DAYS), 'acquire() with a 30-day ttl');
    assert.equal(await store.renew(k, 'a', THIRTY_DAYS), true, 'renew() with a 30-day ttl');
    await advance(FREE_AT);
    expectRefused(await store.acquire(k, 'b', LONG), 'acquire() of a lock with a 30-day ttl');
    assert.equal(await store.release(k, 'a'), true, 'release() of a lock with a 30-day ttl');
  });

  if (!callers) {
    return cases;
  }

  const owners = Array.from({ length: callers }, (_, i) => `owner-${i}`);
  const race = (store: LockStore, k: string) => Promise.all(owners.map((owner) => store.acquire(k, owner, LONG)));

  test(`concurrency: of ${callers} callers acquiring a free key at once, exactly one wins`, async (store, key) => {
    expectOneWinner(await race(store, key('race')), 'acquire() of a free key');
  });

  test(`concurrency: of ${callers} callers acquiring an expired lock at once, exactly one takes it over`, async (store, key) => {
    const k = key('race');
    const stale = expectAcquired(await store.acquire(k, 'paused', TTL), 'acquire()');
    await advance(FREE_AT);
    const { token } = expectOneWinner(await race(store, k), 'acquire() of an expired lock');
    assert.ok(token > stale, `the winner's token must be greater than the stale one's: ${token} after ${stale}`);
    assert.equal(await store.renew(k, 'paused', TTL), false, 'renew() by the stale owner');
  });

  test(`concurrency: an expired lock's renew() racing ${callers} acquire() calls doesn't revive it`, async (store, key) => {
    const k = key('race');
    expectAcquired(await store.acquire(k, 'paused', TTL), 'acquire()');
    await advance(FREE_AT);
    const [renewed, ...results] = await Promise.all([store.renew(k, 'paused', TTL), ...owners.map((o) => store.acquire(k, o, LONG))]);
    assert.equal(renewed, false, 'renew() of an expired lock, racing acquire()');
    expectOneWinner(results, 'acquire() racing a stale renew()');
  });

  test(`concurrency: ${callers} callers on ${Math.ceil(callers / 2)} keys at once: one winner per key`, async (store, key) => {
    const keys = Array.from({ length: Math.ceil(callers / 2) }, (_, i) => key(`key-${i}`));
    const results = await Promise.all(keys.flatMap((k, i) => [store.acquire(k, `a-${i}`, LONG), store.acquire(k, `b-${i}`, LONG)]));
    keys.forEach((_, i) => expectOneWinner(results.slice(2 * i, 2 * i + 2), `acquire() of key #${i}`));
  });

  test(`concurrency: acquire() racing release() never fails, and at most one caller wins`, async (store, key) => {
    const k = key('race');
    expectAcquired(await store.acquire(k, 'holder', LONG), 'acquire()');
    const [released, ...results] = await Promise.all([store.release(k, 'holder'), ...owners.map((o) => store.acquire(k, o, LONG))]);
    assert.equal(released, true, 'release() by the holder');
    const winners = results.filter((r) => r?.acquired).length;
    assert.ok(winners <= 1, `acquire() racing release(): ${winners} callers acquired the key`);
    const after = await store.acquire(k, 'late', LONG);
    assert.equal(after.acquired, winners === 0, `acquire() once the race settled (${winners} winner(s) before it)`);
  });

  test(`concurrency: rounds of ${callers} racing callers hand out growing tokens`, async (store, key) => {
    const k = key('rounds');
    let previous = 0;

    for (let round = 0; round < 5; round++) {
      const { token, winner } = expectOneWinner(await race(store, k), `acquire() in round ${round + 1}`);
      assert.ok(token > previous, `round ${round + 1}: token ${token} after ${previous}`);
      previous = token;
      assert.equal(await store.release(k, owners[winner]!), true, `release() by round ${round + 1}'s winner`);
    }
  });

  return cases;
}

/** The token of an acquired lock, after checking its shape. */
function expectAcquired(result: LockAcquireResult, what: string): number {
  assert.ok(
    result !== null && typeof result === 'object' && result.acquired === true,
    `${what}: expected { acquired: true, fencingToken }, got ${JSON.stringify(result)}`,
  );
  assert.ok(
    Number.isSafeInteger(result.fencingToken) && result.fencingToken >= 1,
    `${what}: fencingToken must be a positive safe integer (a number, not a string), got ${JSON.stringify(result.fencingToken)} (${typeof result.fencingToken})`,
  );

  return result.fencingToken;
}

function expectRefused(result: LockAcquireResult, what: string) {
  assert.ok(
    result !== null && typeof result === 'object' && result.acquired === false,
    `${what}: expected { acquired: false }, got ${JSON.stringify(result)}`,
  );
}

/** Exactly one caller acquired, and every other one was refused. */
function expectOneWinner(results: LockAcquireResult[], what: string): { winner: number; token: number } {
  const winners = results.flatMap((r, i) => (r?.acquired ? [i] : []));
  assert.equal(winners.length, 1, `${what}: ${winners.length} of ${results.length} concurrent callers acquired the key`);

  for (const [i, r] of results.entries()) {
    if (i !== winners[0]) {
      expectRefused(r, `${what}: a losing caller`);
    }
  }

  return { winner: winners[0]!, token: expectAcquired(results[winners[0]!]!, `${what}: the winner`) };
}

/** A deterministic string of `length` varied characters (ASCII and beyond). */
function printable(length: number): string {
  let seed = 0x2545f491;
  let out = '';

  while (out.length < length) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const n = seed % 100;
    out += n < 94 ? String.fromCharCode(33 + n) : ['ą', 'ß', 'ж', '中', 'é', 'ø'][n - 94];
  }

  return out.slice(0, length);
}
