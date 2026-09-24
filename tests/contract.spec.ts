/**
 * The contract suite catches the mistakes a hand-written store makes: each broken store
 * below fails the case named, and passes the rest of the suite's basics.
 */
import { ManualLockClock } from '../lib/testing/manual-lock-clock.js';
import type { LockAcquireResult, LockStore } from '../lib/interfaces/lock-store.interface.js';
import { InMemoryLockStore } from '../lib/stores/in-memory-lock.store.js';
import { lockStoreContract } from '../lib/testing/index.js';

interface Row {
  owner: string;
  token: number;
  expiresAt: number;
}

/** A store that "works" in a demo: a map read, then written, with a round trip in between. */
class ReadThenWriteStore implements LockStore {
  rows = new Map<string, Row>();
  counter = 0;
  constructor(protected readonly clock: ManualLockClock) {}
  protected roundTrip() {
    return new Promise<void>((resolve) => setImmediate(resolve));
  }
  protected live(key: string) {
    const row = this.rows.get(key);
    return row && row.expiresAt > this.clock.now() ? row : undefined;
  }
  async acquire(key: string, owner: string, ttl: number): Promise<LockAcquireResult> {
    const existing = this.live(key); // SELECT
    await this.roundTrip();
    if (existing) {
      return { acquired: false };
    }

    const token = ++this.counter;
    this.rows.set(key, { owner, token, expiresAt: this.clock.now() + ttl }); // INSERT ... ON CONFLICT DO UPDATE

    return { acquired: true, fencingToken: token };
  }
  async renew(key: string, owner: string, ttl: number) {
    const row = this.live(key);
    if (row?.owner !== owner) {
      return false;
    }
    row.expiresAt = this.clock.now() + ttl;
    return true;
  }
  async release(key: string, owner: string) {
    const row = this.live(key);
    if (row?.owner !== owner) {
      return false;
    }
    this.rows.delete(key);
    return true;
  }
}

/** Atomic, but the counter lives in the row: releasing deletes it, and tokens start over. */
class PerRowCounterStore extends InMemoryLockStore {
  private readonly tokens = new Map<string, number>();
  override async acquire(key: string, owner: string, ttl: number): Promise<LockAcquireResult> {
    const result = await super.acquire(key, owner, ttl);
    if (!result.acquired) {
      return result;
    }
    const token = (this.tokens.get(key) ?? 0) + 1;
    this.tokens.set(key, token);
    return { acquired: true, fencingToken: token };
  }
  override async release(key: string, owner: string) {
    const released = await super.release(key, owner);
    if (released) {
      this.tokens.delete(key); // DELETE FROM locks WHERE ...
    }
    return released;
  }
}

/** Renews by owner alone: `UPDATE locks SET expires_at = ... WHERE key = ? AND owner = ?`. */
class RevivingRenewStore extends ReadThenWriteStore {
  override async acquire(key: string, owner: string, ttl: number): Promise<LockAcquireResult> {
    if (this.live(key)) {
      return { acquired: false };
    }
    const token = ++this.counter;
    this.rows.set(key, { owner, token, expiresAt: this.clock.now() + ttl });
    return { acquired: true, fencingToken: token };
  }
  override async renew(key: string, owner: string, ttl: number) {
    const row = this.rows.get(key); // no expiry check
    if (row?.owner !== owner) {
      return false;
    }
    row.expiresAt = this.clock.now() + ttl;
    return true;
  }
}

/** Rounds ttl up to whole seconds (`SET ... EX`), so a 2.5s lock lives three seconds. */
class SecondsStore extends InMemoryLockStore {
  override acquire(key: string, owner: string, ttl: number) {
    return super.acquire(key, owner, Math.ceil(ttl / 1000) * 1000);
  }
  override renew(key: string, owner: string, ttl: number) {
    return super.renew(key, owner, Math.ceil(ttl / 1000) * 1000);
  }
}

function failures(create: (clock: ManualLockClock) => LockStore, name: RegExp) {
  let clock!: ManualLockClock;
  const cases = lockStoreContract(
    () => create((clock = new ManualLockClock())),
    { advanceTime: (ms) => clock.advance(ms), concurrent: true },
  ).filter((c) => name.test(c.name));
  expect(cases.length).toBeGreaterThan(0);
  return cases;
}

describe('lockStoreContract() catches', () => {
  it('a read followed by a separate write: several callers win a free key', async () => {
    for (const c of failures((clock) => new ReadThenWriteStore(clock), /acquiring a free key at once/)) {
      await expect(c.run()).rejects.toThrow(/16 of 16 concurrent callers acquired the key/);
    }
  });

  it('a fencing counter kept in the lock row: tokens start over after a release', async () => {
    const [c] = failures((clock) => new PerRowCounterStore({ clock }), /next token is greater/);
    await expect(c!.run()).rejects.toThrow('fencing tokens must grow: 1 after 1');
  });

  it('a renewal that checks the owner but not the expiry: a stale holder revives its lock', async () => {
    const [c] = failures((clock) => new RevivingRenewStore(clock), /^renew\(\) extends the lock/);
    await expect(c!.run()).rejects.toThrow('renew() of an expired lock (it must not come back)');
  });

  it('expiry rounded to seconds', async () => {
    const [c] = failures((clock) => new SecondsStore({ clock }), /measured from the call, in milliseconds/);
    await expect(c!.run()).rejects.toThrow('acquire() 2916ms in (a 2500ms lock)');
  });

  it('a token that is not a number', async () => {
    const [c] = failures(
      (clock) =>
        new (class extends InMemoryLockStore {
          override async acquire(key: string, owner: string, ttl: number) {
            const result = await super.acquire(key, owner, ttl);
            return (result.acquired ? { acquired: true, fencingToken: String(result.fencingToken) } : result) as LockAcquireResult;
          }
        })({ clock }),
      /takes a free key once/,
    );
    await expect(c!.run()).rejects.toThrow('fencingToken must be a positive safe integer (a number, not a string), got "1" (string)');
  });

  it('nothing in the in-memory store', async () => {
    for (const c of failures((clock) => new InMemoryLockStore({ clock }), /./)) {
      await c.run();
    }
  });
});
