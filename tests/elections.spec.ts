import { Injectable } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { LeaderElection } from '../lib/decorators/leader-election.decorator.js';
import type { LockAcquireResult } from '../lib/interfaces/lock-store.interface.js';
import type { Lock } from '../lib/lock/lock.js';
import { InMemoryLockStore } from '../lib/stores/in-memory-lock.store.js';
import { ManualLockClock } from '../lib/testing/manual-lock-clock.js';
import { CapturingLogger, deferred, startInstance } from './helpers.js';

describe('@LeaderElection(): edge cases', () => {
  let clock: ManualLockClock;
  let store: InMemoryLockStore;
  let apps: TestingModule[];
  let logger: CapturingLogger;

  async function instance(providers: unknown[], ttl?: `${number}s`) {
    const app = await startInstance({ store, locks: { clock, ttl }, providers: providers as never[], logger });
    apps.push(app);
    return app;
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

  it('checks its options when the class is defined', () => {
    expect(() => LeaderElection('feed', null as never)).toThrow(
      new TypeError('@LeaderElection("feed") takes an options object ({ ttl }), got null'),
    );
    expect(() => LeaderElection('feed', { ttl: 0 })).toThrow(new RangeError('@LeaderElection("feed"): `ttl` must be at least 1ms, got 0'));
    expect(() => LeaderElection(7 as never)).toThrow('@LeaderElection(): the election key must be a non-empty string, got 7');
  });

  it("campaigns with the module's ttl when it sets none, and hands the hooks the same lease", async () => {
    const locks: Lock[] = [];
    @Injectable()
    @LeaderElection('feed')
    class Feed {
      onLeadershipAcquired(lock: Lock) {
        locks.push(lock);
      }
      onLeadershipLost(lock: Lock) {
        locks.push(lock);
      }
    }
    const acquire = vi.spyOn(store, 'acquire');
    const app = await instance([Feed], '9s');
    await clock.advance(0);
    expect(acquire).toHaveBeenCalledWith('feed', expect.any(String), 9_000);
    await app.close();
    apps = [];
    expect(locks).toHaveLength(2);
    expect(locks[0]).toBe(locks[1]);
    expect(store.peek('feed')).toBeUndefined();
  });

  it('keeps campaigning every ttl / 3 after the store fails, and logs the failure', async () => {
    const led = vi.fn();
    @Injectable()
    @LeaderElection('feed', { ttl: '9s' })
    class Feed {
      onLeadershipAcquired = led;
    }
    vi.spyOn(store, 'acquire').mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await instance([Feed]);
    await clock.advance(0);
    expect(logger.matching('ERROR Leader election "feed": the lock store failed')).toHaveLength(1);
    expect(led).not.toHaveBeenCalled();
    await clock.advance('3s');
    expect(led).toHaveBeenCalledTimes(1);
  });

  it('steps down when onLeadershipAcquired() throws synchronously, and leads again at its next campaign', async () => {
    const log: string[] = [];
    let fail = true;
    @Injectable()
    @LeaderElection('feed', { ttl: '3s' })
    class Feed {
      onLeadershipAcquired(lock: Lock) {
        if (fail) {
          fail = false;
          throw new Error('feed unreachable');
        }
        log.push(`leads ${lock.fencingToken}`);
      }
      onLeadershipLost(lock: Lock) {
        log.push(`lost ${lock.fencingToken} (${(lock.signal.reason as Error).name})`);
      }
    }
    await instance([Feed]);
    await clock.advance(0);
    expect(log).toEqual(['lost 1 (AbortError)']);
    expect(store.peek('feed')).toBeUndefined();
    await clock.advance('1s');
    expect(log).toEqual(['lost 1 (AbortError)', 'leads 2']);
  });

  it('logs an onLeadershipLost() that fails, without anything else changing', async () => {
    @Injectable()
    @LeaderElection('feed', { ttl: '3s' })
    class Feed {
      onLeadershipLost(): Promise<void> {
        return Promise.reject(new Error('flush failed'));
      }
    }
    await instance([Feed]);
    await clock.advance(0);
    vi.spyOn(store, 'renew').mockResolvedValueOnce(false);
    await clock.advance('1s');
    const failures = logger.matching('ERROR Feed.onLeadershipLost() failed for "feed"');
    expect(failures).toHaveLength(1);
    expect(failures[0]).not.toContain('stepping down');
  });

  it('boots a provider with only onLeadershipLost(), and publishes leadership-lost on its channel', async () => {
    const published: unknown[] = [];
    const listener = (event: unknown) => published.push(event);
    subscribe('nestjs:locks:leadership-lost', listener);

    try {
      @Injectable()
      @LeaderElection('feed')
      class Feed {
        onLeadershipLost() {}
      }
      const app = await instance([Feed]);
      await clock.advance(0);
      await app.close();
      apps = [];
      expect(published).toEqual([{ type: 'leadership-lost', key: 'feed', fencingToken: 1, reason: 'released' }]);
    } finally {
      unsubscribe('nestjs:locks:leadership-lost', listener);
    }
  });

  it('hands back a lease that arrives after shutdown began, without calling the hooks', async () => {
    const led = vi.fn();
    @Injectable()
    @LeaderElection('feed')
    class Feed {
      onLeadershipAcquired = led;
    }
    const slow = deferred<void>();
    const acquire = store.acquire.bind(store);
    vi.spyOn(store, 'acquire').mockImplementationOnce(async (key, owner, ttl): Promise<LockAcquireResult> => {
      await slow.promise;
      return acquire(key, owner, ttl);
    });
    const app = await instance([Feed]);
    await app.close();
    apps = [];
    slow.resolve();
    await clock.advance(0);
    expect(led).not.toHaveBeenCalled();
    expect(store.peek('feed')).toBeUndefined();
    expect(clock.pendingTimers).toBe(0);
  });

  it('runs one election per key, each on its own lease', async () => {
    const leaders: string[] = [];
    @Injectable()
    @LeaderElection('feed')
    class Feed {
      onLeadershipAcquired(lock: Lock) {
        leaders.push(lock.key);
      }
    }
    @Injectable()
    @LeaderElection('billing')
    class Billing {
      onLeadershipAcquired(lock: Lock) {
        leaders.push(lock.key);
      }
    }
    await instance([Feed, Billing]);
    await clock.advance(0);
    expect(leaders.sort()).toEqual(['billing', 'feed']);
    expect(store.peek('feed')!.fencingToken).not.toBe(store.peek('billing')!.fencingToken);
  });
});
