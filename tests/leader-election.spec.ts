import { Inject, Injectable, Scope } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { ManualLockClock } from '../lib/testing/manual-lock-clock.js';
import { LeaderElection } from '../lib/decorators/leader-election.decorator.js';
import type { OnLeadershipAcquired, OnLeadershipLost } from '../lib/interfaces/leader-election.interface.js';
import type { Lock } from '../lib/lock/lock.js';
import { LockLostError } from '../lib/errors/lock-lost.error.js';
import type { LocksEvent } from '../lib/events/locks-events.interface.js';
import { LocksEvents } from '../lib/events/locks-events.service.js';
import { LocksModule } from '../lib/locks.module.js';
import { OnOneInstance } from '../lib/decorators/on-one-instance.decorator.js';
import { InMemoryLockStore } from '../lib/stores/in-memory-lock.store.js';
import { CapturingLogger, startInstance } from './helpers.js';

let log: string[] = [];
let failAcquired = 0;
const NAME = Symbol('NAME');

@Injectable()
@LeaderElection('warehouse-feed', { ttl: '15s' })
class WarehouseFeed implements OnLeadershipAcquired, OnLeadershipLost {
  constructor(@Inject(NAME) readonly name: string) {}
  lock?: Lock;
  onLeadershipAcquired(lock: Lock) {
    if (failAcquired > 0) {
      failAcquired--;
      return Promise.reject(new Error('feed unreachable'));
    }
    this.lock = lock;
    log.push(`${this.name} leads (token ${lock.fencingToken})`);
  }
  onLeadershipLost(lock: Lock) {
    log.push(`${this.name} lost (${(lock.signal.reason as Error).name})`);
  }
}

describe('@LeaderElection()', () => {
  let clock: ManualLockClock;
  let store: InMemoryLockStore;
  let apps: TestingModule[];
  let logger: CapturingLogger;

  async function instance(name: string, own?: ManualLockClock) {
    const app = await startInstance({
      store,
      locks: { clock: own ?? clock },
      providers: [WarehouseFeed, { provide: NAME, useValue: name }],
      logger,
    });
    apps.push(app);
    const events: LocksEvent[] = [];
    app.get(LocksEvents).events$.subscribe((event) => events.push(event));

    return { app, feed: app.get(WarehouseFeed), events };
  }

  beforeEach(() => {
    clock = new ManualLockClock();
    store = new InMemoryLockStore({ clock });
    apps = [];
    log = [];
    failAcquired = 0;
    logger = new CapturingLogger();
  });
  afterEach(async () => {
    for (const app of apps) {
      await app.close();
    }
  });

  it('elects one leader among the instances, and keeps it', async () => {
    // The first campaign runs in onApplicationBootstrap: listen before the instances start.
    const published: unknown[] = [];
    const listener = (event: unknown) => published.push(event);
    subscribe('nestjs:locks:leadership-acquired', listener);

    try {
      const a = await instance('a');
      await instance('b');
      await instance('c');
      await clock.advance('10m');
      expect(log).toEqual(['a leads (token 1)']);
      expect(a.feed.lock!.held).toBe(true);
      expect(store.peek('warehouse-feed')!.owner).toBe(a.feed.lock!.owner);
      expect(published).toEqual([{ type: 'leadership-acquired', key: 'warehouse-feed', fencingToken: 1 }]);
      expect(logger.matching('[Locks] Leading "warehouse-feed" (fencing token 1)')).toHaveLength(1);
    } finally {
      unsubscribe('nestjs:locks:leadership-acquired', listener);
    }
  });

  it('fails over when the leader stops renewing, and tells the old leader when it wakes up', async () => {
    const clockA = new ManualLockClock();
    const a = await instance('a', clockA);
    const b = await instance('b');
    await clock.advance('20s'); // A is paused: its lease expires, and B's next campaign takes it
    expect(log).toEqual(['a leads (token 1)', 'b leads (token 2)']);
    await clockA.advance('5s'); // A wakes up: its renewal is refused
    expect(log).toEqual(['a leads (token 1)', 'b leads (token 2)', 'a lost (LockLostError)']);
    expect(a.feed.lock!.signal.reason).toBeInstanceOf(LockLostError);
    expect(a.events.at(-1)).toEqual({ type: 'leadership-lost', key: 'warehouse-feed', fencingToken: 1, reason: 'lost' });
    await clockA.advance('1m');
    await clock.advance('1m');
    expect(log.filter((line) => line.includes('leads'))).toHaveLength(2); // B stays the leader
    expect(b.feed.lock!.held).toBe(true);
  });

  it('steps down at shutdown, and another instance takes over at its next campaign', async () => {
    const a = await instance('a');
    await instance('b');
    await clock.advance(0);
    await a.app.close();
    apps.splice(apps.indexOf(a.app), 1);
    expect(log).toEqual(['a leads (token 1)', 'a lost (AbortError)']);
    expect(a.events.at(-1)).toMatchObject({ type: 'leadership-lost', reason: 'released' });
    await clock.advance('5s'); // ttl / 3
    expect(log.at(-1)).toBe('b leads (token 2)');
  });

  it('steps down when onLeadershipAcquired() fails, so another instance can lead', async () => {
    failAcquired = 1;
    await instance('a');
    await instance('b');
    await clock.advance(0);
    expect(logger.matching('ERROR WarehouseFeed.onLeadershipAcquired() failed for "warehouse-feed": stepping down')).toHaveLength(1);
    // A stepped down before B started, so B's first campaign won.
    expect(log).toEqual(['a lost (AbortError)', 'b leads (token 2)']);
  });

  it('refuses a provider without hooks, a request-scoped one, and two ttls for one election', async () => {
    const boot = async (...providers: unknown[]) => {
      const moduleRef = await Test.createTestingModule({ imports: [LocksModule.forRoot()], providers: providers as never[] }).compile();
      moduleRef.useLogger(false);
      return moduleRef.init();
    };
    @Injectable()
    @LeaderElection('feed')
    class NoHooks {}
    await expect(boot(NoHooks)).rejects.toThrow(
      '@LeaderElection("feed") on NoHooks: implement OnLeadershipAcquired (onLeadershipAcquired(lock)) and OnLeadershipLost',
    );
    @Injectable({ scope: Scope.REQUEST })
    @LeaderElection('feed')
    class Scoped {
      onLeadershipAcquired() {}
    }
    await expect(boot(Scoped)).rejects.toThrow('@LeaderElection("feed") on Scoped: use it on a singleton provider');
    @Injectable()
    @LeaderElection('feed', { ttl: '10s' })
    class First {
      onLeadershipAcquired() {}
    }
    @Injectable()
    @LeaderElection('feed', { ttl: '20s' })
    class Second {
      onLeadershipAcquired() {}
    }
    await expect(boot(First, Second)).rejects.toThrow('@LeaderElection("feed") is used with different `ttl`s');
    expect(() => LeaderElection('')).toThrow('@LeaderElection(): the election key must be a non-empty string, got ""');
    // An election on a job's lease key: the two would exclude each other.
    @Injectable()
    class Jobs {
      @OnOneInstance({ key: 'feed' })
      run() {}
    }
    @Injectable()
    @LeaderElection('feed:owner')
    class OnTheLease {
      onLeadershipAcquired() {}
    }
    await expect(boot(Jobs, OnTheLease)).rejects.toThrow(
      'LocksModule: @LeaderElection("feed:owner") and the job Jobs.run (key "feed") both use the lock key "feed:owner", so they would exclude each other',
    );
    expect(() => LeaderElection('feed', { ttl: 'soon' as never })).toThrow('@LeaderElection("feed"): `ttl`: Invalid duration "soon"');
  });

  it('lets several providers take part in one election', async () => {
    const calls: string[] = [];
    @Injectable()
    @LeaderElection('feed')
    class Consumer {
      onLeadershipAcquired() {
        calls.push('consumer');
      }
    }
    @Injectable()
    @LeaderElection('feed')
    class Metrics {
      onLeadershipAcquired() {
        calls.push('metrics');
      }
    }
    apps.push(await startInstance({ store, locks: { clock }, providers: [Consumer, Metrics], logger }));
    await clock.advance(0);
    expect(calls.sort()).toEqual(['consumer', 'metrics']);
  });
});
