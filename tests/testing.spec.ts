import { ManualLockClock } from '../lib/testing/manual-lock-clock.js';
import type { LockAcquireResult, LockStore } from '../lib/interfaces/lock-store.interface.js';
import { InMemoryLockStore } from '../lib/stores/in-memory-lock.store.js';
import { lockStoreContract } from '../lib/testing/index.js';
import * as testing from '../lib/testing/index.js';
import { ManualLockClock as PublicManualLockClock } from '../lib/index.js';

describe('ManualLockClock', () => {
  it('is exported from the main entry', () => {
    expect(PublicManualLockClock).toBe(ManualLockClock);
    expect(Object.keys(testing)).toEqual(['lockStoreContract']);
  });

  it('fires timers due at the same time in the order they were set', async () => {
    const clock = new ManualLockClock(0);
    const fired: string[] = [];
    clock.setTimeout(() => fired.push('first'), 100);
    clock.setTimeout(() => fired.push('second'), 100);
    clock.setTimeout(() => fired.push('third'), 100);
    await clock.advance(100);
    expect(fired).toEqual(['first', 'second', 'third']);
  });

  it('fires a timer set with a negative delay at the next advance(0), without moving back', async () => {
    const clock = new ManualLockClock(1_000);
    const fired: number[] = [];
    clock.setTimeout(() => fired.push(clock.now()), -500);
    expect(fired).toEqual([]);
    await clock.advance(0);
    expect(fired).toEqual([1_000]);
    expect(clock.now()).toBe(1_000);
  });

  it('hands out a distinct handle per timer, and ignores clearing an unknown one', async () => {
    const clock = new ManualLockClock(0);
    const fired: string[] = [];
    const a = clock.setTimeout(() => fired.push('a'), 10);
    const b = clock.setTimeout(() => fired.push('b'), 10);
    expect(a).not.toBe(b);
    clock.clearTimeout('nope');
    clock.clearTimeout(undefined);
    expect(clock.pendingTimers).toBe(2);
    clock.clearTimeout(a);
    await clock.advance(10);
    expect(fired).toEqual(['b']);
    expect(clock.pendingTimers).toBe(0);
  });

  it('waits for the promise a timer returns before it fires the next one', async () => {
    // Resolves after more event loop turns than advance() lets pass between timers on its own.
    const clock = new ManualLockClock(0);
    const order: string[] = [];
    clock.setTimeout(async () => {
      for (let i = 0; i < 20; i++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      order.push('renewal landed');
    }, 10);
    clock.setTimeout(() => order.push('next timer'), 20);
    await clock.advance(30);
    expect(order).toEqual(['renewal landed', 'next timer']);
  });

  it('carries on past a timer whose promise rejects', async () => {
    const clock = new ManualLockClock(0);
    const fired: string[] = [];
    clock.setTimeout(() => Promise.reject(new Error('store down')), 10);
    clock.setTimeout(() => fired.push('after'), 20);
    await expect(clock.advance(30)).resolves.toBeUndefined();
    expect(fired).toEqual(['after']);
  });

  it('runs each timer at its own time, not at the end of the advance', async () => {
    const clock = new ManualLockClock(0);
    const seen: number[] = [];
    clock.setTimeout(() => seen.push(clock.now()), 250);
    await clock.advance('1s');
    expect(seen).toEqual([250]);
    expect(clock.now()).toBe(1_000);
  });
});

describe('lockStoreContract()', () => {
  const inMemory = () => {
    const clock = new ManualLockClock();
    return { clock, store: new InMemoryLockStore({ clock }) };
  };

  it('checks its options at once, naming the bad value', () => {
    const store = () => new InMemoryLockStore();
    expect(() => lockStoreContract(store, { concurrent: { callers: 1 } })).toThrow(
      new RangeError('lockStoreContract(): concurrent.callers must be an integer of at least 2, got 1'),
    );
    expect(() => lockStoreContract(store, { concurrent: { callers: 2.5 } })).toThrow('got 2.5');
    expect(() => lockStoreContract(store, { ttl: 99 })).toThrow(
      new RangeError('lockStoreContract(): ttl must be a whole number of milliseconds, at least 100, got 99'),
    );
    expect(() => lockStoreContract(store, { ttl: 150.5 })).toThrow('got 150.5');
    // Without `concurrent`, the callers count is not checked at all.
    expect(() => lockStoreContract(store, { concurrent: false })).not.toThrow();
  });

  it('adds the concurrency cases only when asked, with the number of callers in their names', () => {
    const store = () => new InMemoryLockStore();
    const basic = lockStoreContract(store).map((c) => c.name);
    const concurrent = lockStoreContract(store, { concurrent: { callers: 4 } }).map((c) => c.name);
    expect(basic.some((name) => name.startsWith('concurrency:'))).toBe(false);
    expect(concurrent.slice(0, basic.length)).toEqual(basic);
    expect(concurrent.slice(basic.length)).toEqual([
      'concurrency: of 4 callers acquiring a free key at once, exactly one wins',
      'concurrency: of 4 callers acquiring an expired lock at once, exactly one takes it over',
      "concurrency: an expired lock's renew() racing 4 acquire() calls doesn't revive it",
      'concurrency: 4 callers on 2 keys at once: one winner per key',
      'concurrency: acquire() racing release() never fails, and at most one caller wins',
      'concurrency: rounds of 4 racing callers hand out growing tokens',
    ]);
    expect(lockStoreContract(store, { concurrent: true }).at(-1)!.name).toBe('concurrency: rounds of 16 racing callers hand out growing tokens');
  });

  it('checks a lock halfway through its ttl and again a sixth past it', async () => {
    const { clock, store } = inMemory();
    const advanced: number[] = [];
    const [expiry] = lockStoreContract(() => store, {
      ttl: 600,
      advanceTime: (ms) => {
        advanced.push(ms);
        return clock.advance(ms);
      },
    }).filter((c) => c.name.startsWith('a lock expires after ttl'));
    await expiry!.run();
    expect(advanced).toEqual([300, 400]);
  });

  it('calls createStore once per case, awaiting it, and gives every case keys of its own', async () => {
    const { clock, store } = inMemory();
    const keys = new Set<string>();
    const spying: LockStore = {
      acquire: (key, owner, ttl) => {
        keys.add(key);
        return store.acquire(key, owner, ttl);
      },
      renew: (key, owner, ttl) => store.renew(key, owner, ttl),
      release: (key, owner) => store.release(key, owner),
    };
    const createStore = vi.fn(async () => spying);
    const cases = lockStoreContract(createStore, { advanceTime: (ms) => clock.advance(ms) });
    expect(createStore).not.toHaveBeenCalled();

    const first = cases.find((c) => c.name.startsWith('acquire() takes a free key once'))!;
    await first.run();
    await first.run(); // the same case twice, on one store: its keys don't collide
    expect(createStore).toHaveBeenCalledTimes(2);
    const prefixes = new Set([...keys].map((key) => key.slice(0, key.lastIndexOf(':'))));
    expect(prefixes.size).toBe(2);
  });

  it('catches a reentrant store: the owner itself takes its own lock again', async () => {
    class ReentrantStore extends InMemoryLockStore {
      override async acquire(key: string, owner: string, ttl: number): Promise<LockAcquireResult> {
        const held = this.peek(key);
        if (held?.owner === owner) {
          return { acquired: true, fencingToken: held.fencingToken };
        }
        return super.acquire(key, owner, ttl);
      }
    }
    const [c] = lockStoreContract(() => new ReentrantStore()).filter((c) => c.name.startsWith('acquire() takes a free key once'));
    await expect(c!.run()).rejects.toThrow('acquire() by the owner itself (a lock is taken once): expected { acquired: false }, got {"acquired":true,"fencingToken":1}');
  });

  it("catches a release that doesn't check the owner: a stale holder frees another's lock", async () => {
    class CarelessRelease extends InMemoryLockStore {
      override async release(key: string): Promise<boolean> {
        const held = this.peek(key);
        return held ? super.release(key, held.owner) : false;
      }
    }
    const [c] = lockStoreContract(() => new CarelessRelease()).filter((c) => c.name.startsWith('release() frees the key'));
    await expect(c!.run()).rejects.toThrow('release() by another owner');
  });

  it('catches a token of 0, and a lock that never expires', async () => {
    class ZeroFirst extends InMemoryLockStore {
      override async acquire(key: string, owner: string, ttl: number): Promise<LockAcquireResult> {
        const result = await super.acquire(key, owner, ttl);
        return result.acquired ? { acquired: true, fencingToken: result.fencingToken - 1 } : result;
      }
    }
    const [free] = lockStoreContract(() => new ZeroFirst()).filter((c) => c.name.startsWith('acquire() takes a free key once'));
    await expect(free!.run()).rejects.toThrow('fencingToken must be a positive safe integer (a number, not a string), got 0 (number)');

    const clock = new ManualLockClock();
    class Forever extends InMemoryLockStore {
      override acquire(key: string, owner: string) {
        return super.acquire(key, owner, Number.MAX_SAFE_INTEGER);
      }
    }
    const [expiry] = lockStoreContract(() => new Forever({ clock }), { advanceTime: (ms) => clock.advance(ms) }).filter((c) =>
      c.name.startsWith('a lock expires after ttl'),
    );
    await expect(expiry!.run()).rejects.toThrow('acquire() 2916ms in (a 2500ms lock): expected { acquired: true, fencingToken }, got {"acquired":false}');
  });

  it("catches a store that doesn't take durations past a 32-bit integer", async () => {
    // A column or a timer that wraps: 30 days overflows into the past, and the lock is free at once.
    class Int32Store extends InMemoryLockStore {
      override acquire(key: string, owner: string, ttl: number) {
        return super.acquire(key, owner, ttl | 0);
      }
    }
    const clock = new ManualLockClock();
    const [c] = lockStoreContract(() => new Int32Store({ clock }), { advanceTime: (ms) => clock.advance(ms) }).filter((c) =>
      c.name.startsWith('takes durations of weeks'),
    );
    await expect(c!.run()).rejects.toThrow('renew() with a 30-day ttl');
  });
});
