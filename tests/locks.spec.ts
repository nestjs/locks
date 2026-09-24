import { Test, type TestingModule } from '@nestjs/testing';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import type { LockClock } from '../lib/interfaces/lock-clock.interface.js';
import { ManualLockClock } from '../lib/testing/manual-lock-clock.js';
import type { Lock } from '../lib/lock/lock.js';
import type { LockAcquireResult, LockStore } from '../lib/interfaces/lock-store.interface.js';
import { LocksContext } from '../lib/context/locks.context.js';
import { LockLostError, LockNotAcquiredError, LocksError } from '../lib/errors/index.js';
import type { LocksEvent } from '../lib/events/locks-events.interface.js';
import { LocksEvents } from '../lib/events/locks-events.service.js';
import { LocksModule } from '../lib/locks.module.js';
import { Locks } from '../lib/locks.service.js';
import { LocksStorage } from '../lib/storage/locks.storage.js';
import { InMemoryLockStore } from '../lib/stores/in-memory-lock.store.js';
import { CapturingLogger, deferred, startInstance, until } from './helpers.js';

describe('Locks', () => {
  let clock: ManualLockClock;
  let store: InMemoryLockStore;
  let apps: TestingModule[];
  let logger: CapturingLogger;

  /** An instance of the app: its own Locks, on the shared store, with its own clock or the shared one. */
  async function instance(own?: ManualLockClock) {
    const app = await startInstance({ store, locks: { clock: own ?? clock }, logger });
    apps.push(app);
    return { app, locks: app.get(Locks), events: collect(app) };
  }

  function collect(app: TestingModule) {
    const events: LocksEvent[] = [];
    app.get(LocksEvents).events$.subscribe((event) => events.push(event));
    return events;
  }

  beforeEach(() => {
    clock = new ManualLockClock();
    store = new InMemoryLockStore({ clock });
    apps = [];
    logger = new CapturingLogger();
  });
  afterEach(async () => {
    for (const app of apps) {
      await app.close();
    }
  });

  describe('acquire()', () => {
    it('takes a free lock once, with a fencing token that grows with every acquisition', async () => {
      const { locks } = await instance();
      const first = (await locks.acquire('invoices:export'))!;
      expect(first).toMatchObject({ key: 'invoices:export', fencingToken: 1 });
      expect(first.owner).toMatch(/^[0-9a-f-]{36}$/);
      expect(first.held).toBe(true);
      expect(await locks.acquire('invoices:export')).toBeNull();
      expect(await first.release()).toBe(true);
      const second = (await locks.acquire('invoices:export'))!;
      expect(second.fencingToken).toBe(2);
      expect(second.owner).not.toBe(first.owner);
    });

    it('excludes another instance of the app on the same store', async () => {
      const a = await instance();
      const b = await instance();
      const lock = (await a.locks.acquire('k'))!;
      expect(await b.locks.acquire('k')).toBeNull();
      await lock.release();
      expect(await b.locks.acquire('k')).not.toBeNull();
    });

    it('renews the lock every ttl / 3 while it is held, for as long as it is held', async () => {
      const { locks } = await instance();
      const lock = (await locks.acquire('k', { ttl: '30s' }))!;
      await clock.advance('10m');
      expect(lock.held).toBe(true);
      expect(store.peek('k')).toMatchObject({ owner: lock.owner });
      expect(store.peek('k')!.expiresAt - clock.now()).toBeGreaterThan(20_000);
      await lock.release();
      expect(clock.pendingTimers).toBe(0); // no renewal left behind
    });

    it('waits for a holder in this process to release it, and takes it at once', async () => {
      const { locks } = await instance();
      const holder = (await locks.acquire('k'))!;
      const waiting = locks.acquire('k', { wait: '1m' });
      await clock.advance(0);
      await holder.release(); // no time passes: the waiter is woken
      const lock = await waiting;
      expect(lock?.fencingToken).toBe(2);
    });

    it("polls for another instance's lock with backoff until it is free", async () => {
      const a = await instance();
      const b = await instance();
      const holder = (await a.locks.acquire('k'))!;
      const acquire = vi.spyOn(store, 'acquire');
      const waiting = b.locks.acquire('k', { wait: '1m' });
      await clock.advance('3s');
      const attempts = acquire.mock.calls.length;
      // 50ms, 100ms, 200ms... capped at 1s, each with equal jitter (half to the full wait):
      // 7 attempts in 3s with no jitter, 10 with the shortest waits.
      expect(attempts).toBeGreaterThanOrEqual(3);
      expect(attempts).toBeLessThanOrEqual(10);
      await holder.release();
      await clock.advance('1s');
      expect((await waiting)?.fencingToken).toBe(2);
    });

    it('waits on a timer that keeps the process alive; renewals and deadlines never do', async () => {
      // A command that waits for a lock with nothing else on its event loop must not exit
      // mid-wait; a held lock's heartbeat, on the other hand, must not keep a process up.
      const timers: { ms: number; ref: boolean }[] = [];
      const spying: LockClock = {
        now: () => clock.now(),
        setTimeout: (callback, ms, options) => {
          timers.push({ ms, ref: options?.ref === true });
          return clock.setTimeout(callback, ms, options);
        },
        clearTimeout: (handle) => clock.clearTimeout(handle),
      };
      const app = await startInstance({ store, locks: { clock: spying }, logger });
      apps.push(app);
      const locks = app.get(Locks);
      const held = (await locks.acquire('k'))!;
      expect(timers).toEqual([{ ms: 10_000, ref: false }]); // the renewal after ttl / 3
      const waiting = locks.acquire('k', { wait: '1s' });
      await until(() => timers.length === 2);
      expect(timers[1]).toMatchObject({ ref: true }); // the wait
      await held.release();
      const lock = await waiting;
      expect(lock).not.toBeNull();
      await lock!.release();
    });

    it('gives up after wait: null from acquire(), LockNotAcquiredError from withLock()', async () => {
      const a = await instance();
      const b = await instance();
      await a.locks.acquire('k');
      const waiting = b.locks.acquire('k', { wait: '5s' });
      await clock.advance('5s');
      expect(await waiting).toBeNull();

      const run = vi.fn();
      const withLock = b.locks.withLock('k', run, { wait: '2s' });
      const rejected = expect(withLock).rejects.toThrow(
        new LockNotAcquiredError('k', 2_000),
      );
      await clock.advance('2s');
      await rejected;
      const error = await withLock.catch((e: unknown) => e);
      expect(error).toBeInstanceOf(LocksError);
      expect(error).toMatchObject({ name: 'LockNotAcquiredError', key: 'k', waitMs: 2_000 });
      expect((error as Error).message).toBe('Could not acquire the lock "k" within 2000ms: another holder has it');
      expect(run).not.toHaveBeenCalled();
    });

    it('stops waiting when its signal aborts', async () => {
      const { locks } = await instance();
      await locks.acquire('k');
      const controller = new AbortController();
      const waiting = locks.acquire('k', { wait: '1m', signal: controller.signal });
      controller.abort(new Error('client went away'));
      await expect(waiting).rejects.toThrow('client went away');
      await expect(locks.acquire('k', { signal: controller.signal })).rejects.toThrow('client went away');
    });

    it('rejects a bad key or duration, naming it', async () => {
      const { locks } = await instance();
      await expect(locks.acquire('')).rejects.toThrow('Locks: the lock key must be a non-empty string, got ""');
      await expect(locks.acquire(42 as never)).rejects.toThrow('got 42');
      await expect(locks.acquire('k', { ttl: '10 minutes' as never })).rejects.toThrow(
        'Locks: `ttl` of "k": Invalid duration "10 minutes"',
      );
      await expect(locks.acquire('k', { ttl: 0 })).rejects.toThrow('Locks: `ttl` of "k" must be at least 1ms, got 0');
      await expect(locks.acquire('k', { wait: -1 })).rejects.toThrow('Locks: `wait` of "k": Invalid duration -1');
    });

    it('rounds a fractional ttl up to whole milliseconds for the store', async () => {
      const { locks } = await instance();
      const acquire = vi.spyOn(store, 'acquire');
      await locks.acquire('k', { ttl: 1000 / 3 });
      expect(acquire).toHaveBeenCalledWith('k', expect.any(String), 334);
    });

    it("refuses a store's fencing token that isn't a positive safe integer, and gives the lock back", async () => {
      class StringTokens extends InMemoryLockStore {
        override async acquire(key: string, owner: string, ttl: number): Promise<LockAcquireResult> {
          const result = await super.acquire(key, owner, ttl);
          return result.acquired ? ({ acquired: true, fencingToken: String(result.fencingToken) } as never) : result;
        }
      }
      store = new StringTokens({ clock });
      const { locks } = await instance();
      await expect(locks.acquire('k')).rejects.toThrow(
        'StringTokens.acquire() must resolve fencingToken as a positive safe integer, got "1" (string): PostgreSQL ' +
          'returns bigint columns as strings, convert it with Number()',
      );
      expect(store.peek('k')).toBeUndefined();
    });
  });

  describe('withLock()', () => {
    it('runs the callback under the lock, with LocksContext set, then releases it', async () => {
      const { app, locks } = await instance();
      const context = app.get(LocksContext);
      const result = await locks.withLock('k', async (lock) => {
        expect(context.lock).toBe(lock);
        expect(context.fencingToken).toBe(lock.fencingToken);
        expect(context.signal).toBe(lock.signal);
        expect(await locks.acquire('k')).toBeNull();
        return 'exported';
      });
      expect(result).toBe('exported');
      expect(context.lock).toBeUndefined();
      expect(store.peek('k')).toBeUndefined();
    });

    it('releases the lock when the callback throws, synchronously or not', async () => {
      const { locks } = await instance();
      await expect(
        locks.withLock('k', () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      await expect(locks.withLock('k', async () => Promise.reject(new Error('async boom')))).rejects.toThrow('async boom');
      expect(store.peek('k')).toBeUndefined();
    });

    it("logs a release that fails instead of hiding the callback's result", async () => {
      const { locks } = await instance();
      vi.spyOn(store, 'release').mockRejectedValueOnce(new Error('connection reset'));
      await expect(locks.withLock('k', () => 42)).resolves.toBe(42);
      expect(logger.matching('Could not release the lock "k"')).toHaveLength(1);
    });
  });

  describe('a lost lock', () => {
    it('aborts its signal with LockLostError when a renewal is refused: the GC-pause case', async () => {
      // Instance A pauses (its clock stands still) while the store's time and B's go on.
      const clockA = new ManualLockClock();
      const a = await instance(clockA);
      const b = await instance();
      const channelEvents: unknown[] = [];
      const listener = (event: unknown) => channelEvents.push(event);
      subscribe('nestjs:locks:lock-lost', listener);

      try {
        const stale = (await a.locks.acquire('stock', { ttl: '30s' }))!;
        await clock.advance('31s'); // the store's lock expired: A didn't renew
        const fresh = (await b.locks.acquire('stock', { ttl: '30s' }))!;
        expect(fresh.fencingToken).toBeGreaterThan(stale.fencingToken);
        expect(stale.signal.aborted).toBe(false); // A hasn't noticed yet: it is paused

        await clockA.advance('10s'); // A wakes up; its next renewal is refused
        expect(stale.signal.aborted).toBe(true);
        expect(stale.signal.reason).toBeInstanceOf(LockLostError);
        expect(stale.signal.reason).toMatchObject({ key: 'stock', fencingToken: stale.fencingToken, detectedBy: 'renewal' });
        expect(stale.held).toBe(false);
        expect(a.events).toEqual([{ type: 'lock-lost', key: 'stock', fencingToken: stale.fencingToken, detectedBy: 'renewal' }]);
        expect(channelEvents).toEqual(a.events);
        expect(logger.matching(`WARN Lost the lock "stock" (fencing token ${stale.fencingToken})`)).toHaveLength(1);
        expect(await stale.release()).toBe(false);
        expect(fresh.held).toBe(true);
        expect(store.peek('stock')!.owner).toBe(fresh.owner);
      } finally {
        unsubscribe('nestjs:locks:lock-lost', listener);
      }
    });

    it('aborts at its deadline when no renewal reaches the store, even with one in flight', async () => {
      const { locks, events } = await instance();
      const lock = (await locks.acquire('k', { ttl: '30s' }))!;
      const stuck = deferred<boolean>();
      const renew = vi.spyOn(store, 'renew').mockReturnValue(stuck.promise);
      await clock.advance('29s');
      expect(lock.signal.aborted).toBe(false);
      expect(renew).toHaveBeenCalledTimes(1); // one at a time: later beats didn't pile up
      await clock.advance('1s');
      expect(lock.signal.reason).toMatchObject({ name: 'LockLostError', detectedBy: 'deadline' });
      expect(events).toMatchObject([{ type: 'lock-lost', detectedBy: 'deadline' }]);

      // The renewal lands after all: the lock is handed back instead of blocking the key.
      const release = vi.spyOn(store, 'release');
      renew.mockRestore();
      stuck.resolve(true);
      await clock.advance(0);
      expect(release).toHaveBeenCalledWith('k', lock.owner);
    });

    it('keeps renewing through a transient store error, and logs it', async () => {
      const { locks } = await instance();
      const lock = (await locks.acquire('k', { ttl: '30s' }))!;
      vi.spyOn(store, 'renew').mockRejectedValueOnce(new Error('ECONNRESET'));
      await clock.advance('25s'); // the first renewal failed, the second one landed
      expect(lock.held).toBe(true);
      await clock.advance('5m');
      expect(lock.held).toBe(true);
      expect(logger.matching('ERROR Could not renew the lock "k"')).toHaveLength(1);
    });
  });

  describe('release()', () => {
    it('aborts the signal with an AbortError, and answers false the second time', async () => {
      const { locks } = await instance();
      const lock = (await locks.acquire('k'))!;
      expect(await lock.release()).toBe(true);
      expect(lock.signal.reason).toMatchObject({ name: 'AbortError', message: 'The lock "k" was released' });
      expect(await lock.release()).toBe(false);
      expect(lock.held).toBe(false);
    });

    it('rejects when the store fails; the lock then expires on its own', async () => {
      const { locks } = await instance();
      const lock = (await locks.acquire('k', { ttl: '10s' }))!;
      vi.spyOn(store, 'release').mockRejectedValueOnce(new Error('ECONNRESET'));
      await expect(lock.release()).rejects.toThrow('ECONNRESET');
      await clock.advance('10s');
      expect(store.peek('k')).toBeUndefined();
    });

    it('happens at the end of an `await using` block', async () => {
      const { locks } = await instance();
      let inside: Lock | undefined;
      {
        await using lock = (await locks.acquire('k'))!;
        inside = lock;
        expect(store.peek('k')).toBeDefined();
      }
      expect(inside.signal.aborted).toBe(true);
      expect(store.peek('k')).toBeUndefined();
    });

    it('happens for every lock still held when the application shuts down', async () => {
      const { app, locks } = await instance();
      const lock = (await locks.acquire('k'))!;
      await app.close();
      apps = [];
      expect(lock.signal.aborted).toBe(true);
      expect(store.peek('k')).toBeUndefined();
    });

    it("happens before the app's own onApplicationShutdown hooks, where it closes the store's connection", async () => {
      // The tutorial's DatabaseModule ends its pool in onApplicationShutdown, and Nest runs
      // that phase root module first, then the imported modules in import order: a module
      // imported before LocksModule closes the connection before the package's hook of the
      // same phase would run.
      let closed = false;
      const failing: LockStore = {
        acquire: (key, owner, ttl) => store.acquire(key, owner, ttl),
        renew: (key, owner, ttl) => store.renew(key, owner, ttl),
        release: async (key, owner) => {
          if (closed) {
            throw new Error('Cannot use a pool after calling end on the pool');
          }
          return store.release(key, owner);
        },
      };
      class DatabaseModule {
        onApplicationShutdown() {
          closed = true;
        }
      }
      Reflect.defineMetadata('imports', [], DatabaseModule);
      const app = await Test.createTestingModule({ imports: [DatabaseModule, LocksModule.forRoot({ clock })] }).compile();
      app.useLogger(logger);
      app.get(LocksStorage).registerSource(failing);
      await app.init();
      const lock = (await app.get(Locks).acquire('k'))!;
      await app.close();
      expect(lock.signal.aborted).toBe(true);
      expect(logger.matching('ERROR Could not release the lock "k" at shutdown')).toEqual([]);
      expect(store.peek('k')).toBeUndefined();
    });
  });

  describe('LocksContext', () => {
    it('is empty outside a locked section, and run() sets it', async () => {
      const { app, locks } = await instance();
      const context = app.get(LocksContext);
      expect([context.lock, context.fencingToken, context.signal]).toEqual([undefined, undefined, undefined]);
      const lock = (await locks.acquire('k'))!;
      const seen = await context.run(lock, async () => {
        await Promise.resolve();
        return context.fencingToken;
      });
      expect(seen).toBe(lock.fencingToken);
    });
  });

  it('works with a store written against the interface alone', async () => {
    // What the package calls, and nothing else: the contract, not the in-memory store's extras.
    const calls: string[] = [];
    const minimal: LockStore = {
      acquire: async (key, owner, ttl) => (calls.push(`acquire ${key} ${ttl}`), store.acquire(key, owner, ttl)),
      renew: async (key, owner, ttl) => (calls.push(`renew ${key} ${ttl}`), store.renew(key, owner, ttl)),
      release: async (key, owner) => (calls.push(`release ${key}`), store.release(key, owner)),
    };
    const app = await startInstance({ store: minimal, locks: { clock, ttl: '3s' }, logger });
    apps.push(app);
    await app.get(Locks).withLock('k', () => clock.advance('1s'));
    expect(calls).toEqual(['acquire k 3000', 'renew k 3000', 'release k']);
  });
});
