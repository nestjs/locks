import type { TestingModule } from '@nestjs/testing';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { LocksContext } from '../lib/context/locks.context.js';
import { LockLostError, LockNotAcquiredError, LocksError } from '../lib/errors/index.js';
import type { LocksEvent } from '../lib/events/locks-events.interface.js';
import { LocksEvents } from '../lib/events/locks-events.service.js';
import type { LockClock } from '../lib/interfaces/lock-clock.interface.js';
import type { LockAcquireResult } from '../lib/interfaces/lock-store.interface.js';
import { Locks } from '../lib/locks.service.js';
import { InMemoryLockStore } from '../lib/stores/in-memory-lock.store.js';
import { ManualLockClock } from '../lib/testing/manual-lock-clock.js';
import { CapturingLogger, startInstance } from './helpers.js';

/** Whether `promise` has settled, without waiting for it. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  promise.then(
    () => (done = true),
    () => (done = true),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  return done;
}

describe('Locks: edge cases', () => {
  let clock: ManualLockClock;
  let store: InMemoryLockStore;
  let apps: TestingModule[];
  let logger: CapturingLogger;

  async function instance(options: { clock?: LockClock; ttl?: number | `${number}s` } = {}) {
    const app = await startInstance({ store, locks: { clock: options.clock ?? clock, ttl: options.ttl }, logger });
    apps.push(app);
    return { app, locks: app.get(Locks) };
  }

  beforeEach(() => {
    clock = new ManualLockClock();
    store = new InMemoryLockStore({ clock });
    apps = [];
    logger = new CapturingLogger();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const app of apps) {
      await app.close();
    }
  });

  describe('waiting', () => {
    it('backs off exponentially from 50ms with equal jitter, capped at a second, and tries once more at the deadline', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0); // the shortest wait of each step: half of it
      const other = await instance();
      const { locks } = await instance();
      await other.locks.acquire('k');
      const attempts: number[] = [];
      const start = clock.now();
      const acquire = store.acquire.bind(store);
      vi.spyOn(store, 'acquire').mockImplementation((key, owner, ttl) => {
        attempts.push(clock.now() - start);
        return acquire(key, owner, ttl);
      });

      const waiting = locks.acquire('k', { wait: '3s' });
      await clock.advance('3s');
      expect(await waiting).toBeNull();
      expect(attempts).toEqual([0, 25, 75, 175, 375, 775, 1_275, 1_775, 2_275, 2_775, 3_000]);
    });

    it('with no wait, tries once and sets no timer', async () => {
      const other = await instance();
      const { locks } = await instance();
      await other.locks.acquire('k');
      const acquire = vi.spyOn(store, 'acquire');
      const timers = clock.pendingTimers;
      expect(await locks.acquire('k')).toBeNull();
      expect(acquire).toHaveBeenCalledTimes(1);
      expect(clock.pendingTimers).toBe(timers);
    });

    it('rejects with the AbortError of a signal aborted without a reason, and leaves no timer behind', async () => {
      const { locks } = await instance();
      await locks.acquire('k');
      const controller = new AbortController();
      const waiting = locks.acquire('k', { wait: '1m', signal: controller.signal });
      await clock.advance(0);
      expect(clock.pendingTimers).toBe(2); // the holder's renewal, and the wait
      controller.abort();
      await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
      expect(clock.pendingTimers).toBe(1);
    });

    it("doesn't touch the store when the signal has already aborted", async () => {
      const { locks } = await instance();
      const acquire = vi.spyOn(store, 'acquire');
      await expect(locks.acquire('k', { signal: AbortSignal.abort(new Error('gone')) })).rejects.toThrow('gone');
      await expect(locks.withLock('k', () => 1, { signal: AbortSignal.abort(new Error('gone')) })).rejects.toThrow('gone');
      expect(acquire).not.toHaveBeenCalled();
    });

    it('wakes every waiter in this process at a release: one takes the lock, the other waits on', async () => {
      const { locks } = await instance();
      const holder = (await locks.acquire('k'))!;
      const first = locks.acquire('k', { wait: '1m' });
      const second = locks.acquire('k', { wait: '1m' });
      await clock.advance(0);
      await holder.release();
      await clock.advance(0);
      const [firstDone, secondDone] = [await settled(first), await settled(second)];
      expect([firstDone, secondDone].filter(Boolean)).toHaveLength(1);

      const winner = (await (firstDone ? first : second))!;
      expect(winner.fencingToken).toBe(2);
      await winner.release();
      await clock.advance(0);
      expect((await (firstDone ? second : first))!.fencingToken).toBe(3);
    });

    it('is not woken by the release of another key', async () => {
      const { locks } = await instance();
      await locks.acquire('k');
      const other = (await locks.acquire('other'))!;
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const waiting = locks.acquire('k', { wait: '10s' });
      await clock.advance(0);
      const acquire = vi.spyOn(store, 'acquire');
      await other.release();
      await clock.advance(0);
      expect(acquire).not.toHaveBeenCalled();
      await clock.advance('10s');
      expect(await waiting).toBeNull();
    });
  });

  describe('withLock()', () => {
    it('fails at once without waiting, with a message that says so', async () => {
      const other = await instance();
      const { locks } = await instance();
      await other.locks.acquire('k');
      const error = await locks.withLock('k', () => 1).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(LockNotAcquiredError);
      expect(error).toMatchObject({ key: 'k', waitMs: 0, message: 'Could not acquire the lock "k": another holder has it' });
    });

    it("rejects a bad key or option before it calls the store or the callback", async () => {
      const { locks } = await instance();
      const acquire = vi.spyOn(store, 'acquire');
      const fn = vi.fn();
      await expect(locks.withLock('', fn)).rejects.toThrow(TypeError);
      await expect(locks.withLock('k', fn, { wait: 'forever' as never })).rejects.toThrow('Locks: `wait` of "k": Invalid duration "forever"');
      await expect(locks.withLock('k', fn, { ttl: -5 })).rejects.toThrow('Locks: `ttl` of "k": Invalid duration -5');
      expect(acquire).not.toHaveBeenCalled();
      expect(fn).not.toHaveBeenCalled();
    });

    it("takes the lock with the call's ttl, and the module's otherwise", async () => {
      const { locks } = await instance({ ttl: '12s' });
      const acquire = vi.spyOn(store, 'acquire');
      await locks.withLock('a', () => undefined);
      await locks.withLock('b', () => undefined, { ttl: '2s' });
      expect(acquire.mock.calls.map(([key, , ttl]) => [key, ttl])).toEqual([
        ['a', 12_000],
        ['b', 2_000],
      ]);
    });

    it('nests: an inner withLock() sees its own lock, and the outer one is back after it', async () => {
      const { app, locks } = await instance();
      const context = app.get(LocksContext);
      const seen: (string | undefined)[] = [];
      await locks.withLock('outer', async () => {
        seen.push(context.lock?.key);
        await locks.withLock('inner', async () => {
          await Promise.resolve();
          seen.push(context.lock?.key);
        });
        seen.push(context.lock?.key);
      });
      expect(seen).toEqual(['outer', 'inner', 'outer']);
    });

    it('is not reentrant: the same key inside its own callback is refused', async () => {
      const { locks } = await instance();
      await expect(locks.withLock('k', () => locks.withLock('k', () => 'inner'))).rejects.toThrow(LockNotAcquiredError);
      expect(store.peek('k')).toBeUndefined();
    });

    it('keeps the lock in LocksContext for work the callback schedules', async () => {
      const { app, locks } = await instance();
      const context = app.get(LocksContext);
      const token = await locks.withLock('k', () => new Promise<number | undefined>((resolve) => setImmediate(() => resolve(context.fencingToken))));
      expect(token).toBe(1);
    });

    it("hands the callback a signal that aborts once it's done, so work it left running stops", async () => {
      const { locks } = await instance();
      const signal = await locks.withLock('k', (lock) => lock.signal);
      expect(signal.aborted).toBe(true);
      expect(signal.reason).toMatchObject({ name: 'AbortError' });
    });
  });

  describe('a held lock', () => {
    it('renews every ttl / 3, moving its expiry in the store each time', async () => {
      const { locks } = await instance();
      const renew = vi.spyOn(store, 'renew');
      const lock = (await locks.acquire('k', { ttl: '9s' }))!;
      await clock.advance('3s');
      expect(renew).toHaveBeenCalledTimes(1);
      expect(renew).toHaveBeenCalledWith('k', lock.owner, 9_000);
      expect(store.peek('k')!.expiresAt).toBe(clock.now() + 9_000);
      await clock.advance('6s');
      expect(renew).toHaveBeenCalledTimes(3);
      await lock.release();
    });

    it('renews a 1ms lock every millisecond rather than never', async () => {
      const { locks } = await instance();
      const renew = vi.spyOn(store, 'renew');
      const lock = (await locks.acquire('k', { ttl: 2 }))!;
      await clock.advance(1);
      expect(renew).toHaveBeenCalledTimes(1);
      await lock.release();
    });

    it('stops counting as held at its deadline, even if no timer has fired', async () => {
      // A clock whose timers never fire: an event loop blocked past the lease.
      let now = 0;
      const frozen: LockClock = { now: () => now, setTimeout: () => 0, clearTimeout: () => {} };
      store = new InMemoryLockStore({ clock: frozen });
      const { locks } = await instance({ clock: frozen });
      const lock = (await locks.acquire('k', { ttl: 1_000 }))!;
      now = 999;
      expect(lock.held).toBe(true);
      now = 1_000;
      expect(lock.held).toBe(false);
      expect(lock.signal.aborted).toBe(false); // nothing noticed it yet: only `held` tells
    });

    it("doesn't log a renewal that failed after the lock was released", async () => {
      const { locks } = await instance();
      const lock = (await locks.acquire('k', { ttl: '3s' }))!;
      vi.spyOn(store, 'renew').mockImplementationOnce(async () => {
        await lock.release();
        throw new Error('ECONNRESET');
      });
      await clock.advance('1s');
      expect(logger.matching('Could not renew')).toEqual([]);
      expect(clock.pendingTimers).toBe(0);
    });

    it('releases once, however many callers ask at the same time', async () => {
      const { locks } = await instance();
      const lock = (await locks.acquire('k'))!;
      const release = vi.spyOn(store, 'release');
      expect(await Promise.all([lock.release(), lock.release(), lock.release()])).toEqual([true, false, false]);
      expect(release).toHaveBeenCalledTimes(1);
    });

    it('answers false from release() when the store no longer had it, and still aborts', async () => {
      const { locks } = await instance();
      const lock = (await locks.acquire('k'))!;
      await store.release('k', lock.owner); // gone from the store behind the holder's back
      expect(await lock.release()).toBe(false);
      expect(lock.signal.aborted).toBe(true);
    });
  });

  describe('a lost lock', () => {
    async function lose() {
      const { locks } = await instance();
      const lock = (await locks.acquire('k', { ttl: '3s' }))!;
      vi.spyOn(store, 'renew').mockResolvedValueOnce(false);
      await clock.advance('1s');
      expect(lock.signal.reason).toBeInstanceOf(LockLostError);
      return lock;
    }

    it('stops renewing once lost', async () => {
      await lose();
      const renew = vi.spyOn(store, 'renew');
      renew.mockClear(); // the same spy as the refused renewal's
      await clock.advance('1m');
      expect(renew).not.toHaveBeenCalled();
      expect(clock.pendingTimers).toBe(0);
    });

    it('still tries to give the key back at release(), answering false whatever the store says', async () => {
      const lock = await lose();
      const release = vi.spyOn(store, 'release').mockRejectedValueOnce(new Error('ECONNRESET'));
      await expect(lock.release()).resolves.toBe(false);
      await expect(lock.release()).resolves.toBe(false);
      expect(release).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledWith('k', lock.owner);
    });

    it('frees the key for a waiting instance when released after it was lost', async () => {
      const lock = await lose();
      expect(lock.held).toBe(false);
      // The in-memory store still has it (the refused renewal was the mock's): the other
      // instance gets it once the lost holder gives it back, not only when it expires.
      const { locks } = await instance();
      const waiting = locks.acquire('k', { wait: '1m' });
      await lock.release();
      await clock.advance('2s');
      expect((await waiting)?.fencingToken).toBe(2);
    });
  });

  describe('at shutdown', () => {
    it("logs a release that fails, and doesn't release a lock twice", async () => {
      const { app, locks } = await instance();
      const done = (await locks.acquire('done'))!;
      await done.release();
      await locks.acquire('stuck');
      const release = vi.spyOn(store, 'release').mockRejectedValue(new Error('ECONNRESET'));
      await app.close();
      apps = [];
      expect(release.mock.calls.map(([key]) => key)).toEqual(['stuck']);
      expect(logger.matching('ERROR Could not release the lock "stuck" at shutdown')).toHaveLength(1);
    });

    it('completes LocksEvents.events$', async () => {
      const { app } = await instance();
      const complete = vi.fn();
      app.get(LocksEvents).events$.subscribe({ complete });
      await app.close();
      apps = [];
      expect(complete).toHaveBeenCalledTimes(1);
    });
  });

  describe('a store', () => {
    it.each([
      [0, 'got 0 (number)'],
      [-3, 'got -3 (number)'],
      [1.5, 'got 1.5 (number)'],
      [2 ** 53, `got ${2 ** 53} (number)`],
      [null, 'got null (object)'],
    ])('whose fencing token is %s is refused, and the lock is given back', async (token, message) => {
      class BadTokens extends InMemoryLockStore {
        override async acquire(key: string, owner: string, ttl: number): Promise<LockAcquireResult> {
          const result = await super.acquire(key, owner, ttl);
          return result.acquired ? ({ acquired: true, fencingToken: token } as never) : result;
        }
      }
      store = new BadTokens({ clock });
      const { locks } = await instance();
      const error = await locks.acquire('k').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(TypeError);
      expect((error as Error).message).toBe(`BadTokens.acquire() must resolve fencingToken as a positive safe integer, ${message}`);
      expect(store.peek('k')).toBeUndefined();
    });

    it('that fails acquire() rejects acquire() and withLock() with its error', async () => {
      const { locks } = await instance();
      vi.spyOn(store, 'acquire').mockRejectedValue(new Error('ECONNREFUSED'));
      const fn = vi.fn();
      await expect(locks.acquire('k', { wait: '1m' })).rejects.toThrow('ECONNREFUSED');
      await expect(locks.withLock('k', fn)).rejects.toThrow('ECONNREFUSED');
      expect(fn).not.toHaveBeenCalled();
    });
  });
});

describe('errors', () => {
  it('LockLostError says how the loss was detected, and keeps a cause', () => {
    const cause = new Error('ETIMEDOUT');
    const renewal = new LockLostError('stock', 7, 'renewal');
    const deadline = new LockLostError('stock', 7, 'deadline', { cause });
    expect(renewal).toBeInstanceOf(LocksError);
    expect(renewal).toBeInstanceOf(Error);
    expect(renewal).toMatchObject({ name: 'LockLostError', key: 'stock', fencingToken: 7, detectedBy: 'renewal' });
    expect(renewal.message).toBe('Lost the lock "stock" (fencing token 7): it expired before it was renewed, and another holder may have it');
    expect(deadline.message).toBe('Lost the lock "stock" (fencing token 7): no renewal reached the store before it expired');
    expect(deadline.cause).toBe(cause);
  });

  it('carry no 4xx status: contention is not the caller\'s mistake', () => {
    expect('status' in new LockNotAcquiredError('k', 0)).toBe(false);
    expect('status' in new LockLostError('k', 1, 'renewal')).toBe(false);
  });
});

describe('LocksEvents', () => {
  const event: LocksEvent = { type: 'leadership-lost', key: 'feed', fencingToken: 3, reason: 'released' };

  it('publishes each event on its own diagnostics channel, and on events$', () => {
    const events = new LocksEvents();
    const streamed: LocksEvent[] = [];
    events.events$.subscribe((e) => streamed.push(e));
    const lost: unknown[] = [];
    const acquired: unknown[] = [];
    const onLost = (e: unknown) => lost.push(e);
    const onAcquired = (e: unknown) => acquired.push(e);
    subscribe('nestjs:locks:leadership-lost', onLost);
    subscribe('nestjs:locks:leadership-acquired', onAcquired);

    try {
      events.emit(event);
    } finally {
      unsubscribe('nestjs:locks:leadership-lost', onLost);
      unsubscribe('nestjs:locks:leadership-acquired', onAcquired);
    }

    expect(lost).toEqual([event]);
    expect(acquired).toEqual([]);
    expect(streamed).toEqual([event]);
  });

  it('streams events with nobody on the channel, and nothing after shutdown', () => {
    const events = new LocksEvents();
    const streamed: LocksEvent[] = [];
    events.events$.subscribe((e) => streamed.push(e));
    events.emit(event);
    events.onApplicationShutdown();
    events.emit(event);
    expect(streamed).toEqual([event]);
  });
});

describe('LocksContext', () => {
  it('run() returns what the function returns, and nests', async () => {
    const clock = new ManualLockClock();
    const app = await startInstance({ locks: { clock } });
    const locks = app.get(Locks);
    const context = new LocksContext();
    const outer = (await locks.acquire('outer'))!;
    const inner = (await locks.acquire('inner'))!;
    const seen = context.run(outer, () => [context.lock?.key, context.run(inner, () => context.fencingToken), context.lock?.key]);
    expect(seen).toEqual(['outer', inner.fencingToken, 'outer']);
    expect(context.lock).toBeUndefined();
    await app.close();
  });

  it('gives the signal of the lock set with run()', async () => {
    const app = await startInstance({ locks: { clock: new ManualLockClock() } });
    const lock = (await app.get(Locks).acquire('k'))!;
    const context = app.get(LocksContext);
    const signal = context.run(lock, () => context.signal);
    await lock.release();
    expect(signal).toBe(lock.signal);
    expect(signal!.aborted).toBe(true);
    await app.close();
  });
});
