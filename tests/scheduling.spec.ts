import { Injectable, Module, Scope } from '@nestjs/common';
import { Cron, Interval, SchedulerRegistry, Timeout } from '@nestjs/schedule';
import { Test, type TestingModule } from '@nestjs/testing';
import { ManualLockClock } from '../lib/testing/manual-lock-clock.js';
import { LocksContext } from '../lib/context/locks.context.js';
import { LockLostError } from '../lib/errors/lock-lost.error.js';
import { LocksModule } from '../lib/locks.module.js';
import { OnOneInstance } from '../lib/decorators/on-one-instance.decorator.js';
import { WithoutOverlapping } from '../lib/decorators/without-overlapping.decorator.js';
import { InMemoryLockStore } from '../lib/stores/in-memory-lock.store.js';
import { CapturingLogger, deferred, startInstance, until } from './helpers.js';

/** Every run of every job, across the instances of a test. */
let runs: { job: string; instance: string; fencingToken?: number; signal?: AbortSignal }[] = [];
/** When set, jobs wait for it before finishing. */
let gate: Promise<void> | undefined;

@Injectable()
class ReportJobs {
  constructor(private readonly context: LocksContext) {}
  instance = '?';

  // @Cron above: it writes to the wrapper.
  @Cron('0 2 * * *', { name: 'nightly-report' })
  @OnOneInstance({ key: 'reports:nightly' })
  async nightly() {
    this.record('nightly');
    await gate;
    return 'done';
  }

  // @Cron below: its metadata is carried over to the wrapper.
  @OnOneInstance()
  @WithoutOverlapping()
  @Cron('*/5 * * * *', { name: 'reconcile' })
  async reconcile() {
    this.record('reconcile');
    await gate;
  }

  @WithoutOverlapping({ ttl: '10s' })
  async drain() {
    this.record('drain');
    await gate;
  }

  private record(job: string) {
    runs.push({ job, instance: this.instance, fencingToken: this.context.fencingToken, signal: this.context.signal });
  }
}

describe('@OnOneInstance() and @WithoutOverlapping()', () => {
  let clock: ManualLockClock;
  let store: InMemoryLockStore;
  let apps: TestingModule[];
  let logger: CapturingLogger;

  async function instance(name: string, own?: ManualLockClock) {
    const app = await startInstance({
      store,
      locks: { clock: own ?? clock, ttl: '30s' },
      providers: [ReportJobs],
      schedule: true,
      logger,
    });
    app.get(ReportJobs).instance = name;
    apps.push(app);

    return { app, jobs: app.get(ReportJobs) };
  }

  beforeEach(() => {
    clock = new ManualLockClock();
    store = new InMemoryLockStore({ clock });
    apps = [];
    runs = [];
    gate = undefined;
    logger = new CapturingLogger();
  });
  afterEach(async () => {
    const open = deferred();
    open.resolve();
    gate = open.promise;
    for (const app of apps) {
      await app.close();
    }
  });

  it('keeps the jobs visible to @nestjs/schedule, in either decorator order', async () => {
    const { app } = await instance('a');
    const registry = app.get(SchedulerRegistry);
    expect([...registry.getCronJobs().keys()].sort()).toEqual(['nightly-report', 'reconcile']);
    // A tick through @nestjs/schedule's own callback reaches the job, under its lock.
    await registry.getCronJob('nightly-report').fireOnTick();
    await registry.getCronJob('reconcile').fireOnTick();
    await until(() => runs.length === 2);
    expect(runs.map((r) => r.job).sort()).toEqual(['nightly', 'reconcile']);
    expect(runs.every((r) => typeof r.fencingToken === 'number')).toBe(true);
  });

  it('runs a tick on one of three instances, and the same one keeps running it', async () => {
    const instances = await Promise.all(['a', 'b', 'c'].map((name) => instance(name)));

    for (let tick = 0; tick < 3; tick++) {
      const results = await Promise.all(instances.map(({ jobs }) => jobs.nightly()));
      expect(results.filter((r) => r === 'done')).toHaveLength(1);
      expect(results.filter((r) => r === undefined)).toHaveLength(2);
      await clock.advance('1h'); // hundreds of renewals; a day's worth would take seconds on a busy machine
    }

    expect(runs.map((r) => r.instance)).toEqual(['a', 'a', 'a']);
    // One lease, renewed all along: the same fencing token.
    expect(new Set(runs.map((r) => r.fencingToken)).size).toBe(1);
    expect(store.peek('reports:nightly:owner')).toBeDefined();
    expect(logger.matching('ReportJobs.nightly runs on this instance (lease "reports:nightly:owner", fencing token 1)')).toHaveLength(1);
    expect(logger.matching('DEBUG Skipped ReportJobs.nightly: it runs on another instance')).toHaveLength(6);
  });

  it('lets a run overlap the previous one on the owner, like a plain @Cron()', async () => {
    const { jobs } = await instance('a');
    const hold = deferred();
    gate = hold.promise;
    const first = jobs.nightly();
    await until(() => runs.length === 1);
    const second = jobs.nightly();
    await until(() => runs.length === 2);
    hold.resolve();
    expect(await Promise.all([first, second])).toEqual(['done', 'done']);
  });

  it('with @WithoutOverlapping(), skips ticks everywhere while a run is in progress', async () => {
    const instances = await Promise.all(['a', 'b'].map((name) => instance(name)));
    const hold = deferred();
    gate = hold.promise;
    const running = instances[0]!.jobs.reconcile();
    await until(() => runs.length === 1);
    expect(await instances[0]!.jobs.reconcile()).toBeUndefined(); // the owner, overlapping
    expect(await instances[1]!.jobs.reconcile()).toBeUndefined(); // another instance
    expect(logger.matching('Skipped ReportJobs.reconcile: a run is still in progress')).toHaveLength(1);
    expect(logger.matching('Skipped ReportJobs.reconcile: it runs on another instance')).toHaveLength(1);
    hold.resolve();
    await running;
    gate = undefined;
    await instances[0]!.jobs.reconcile();
    expect(runs).toHaveLength(2);
    // Each run holds the run lock, with a token of its own.
    expect(runs[1]!.fencingToken).toBeGreaterThan(runs[0]!.fencingToken!);
    expect(store.peek('ReportJobs.reconcile')).toBeUndefined(); // released after each run
  });

  it('with @WithoutOverlapping() alone, any instance runs, one at a time', async () => {
    const instances = await Promise.all(['a', 'b'].map((name) => instance(name)));
    const hold = deferred();
    gate = hold.promise;
    const running = instances[0]!.jobs.drain();
    await until(() => runs.length === 1);
    expect(await instances[1]!.jobs.drain()).toBeUndefined();
    hold.resolve();
    await running;
    await instances[1]!.jobs.drain();
    expect(runs.map((r) => r.instance)).toEqual(['a', 'b']);
  });

  it('keeps a long run locked with renewals, however long it takes', async () => {
    const instances = await Promise.all(['a', 'b'].map((name) => instance(name)));
    const hold = deferred();
    gate = hold.promise;
    const running = instances[0]!.jobs.reconcile();
    await until(() => runs.length === 1);
    await clock.advance('2h');
    expect(await instances[1]!.jobs.reconcile()).toBeUndefined();
    expect(runs[0]!.signal!.aborted).toBe(false);
    hold.resolve();
    await running;
  });

  it('moves the job to another instance when the owner stops renewing, and aborts the stale run', async () => {
    const clockA = new ManualLockClock(); // A's own clock: it stands still while A is paused
    const a = await instance('a', clockA);
    const b = await instance('b');
    const hold = deferred();
    gate = hold.promise;
    const stale = a.jobs.reconcile();
    await until(() => runs.length === 1);

    await clock.advance('31s'); // A is paused past its leases: they expire in the store
    gate = undefined;
    await b.jobs.reconcile(); // B's next tick takes the job over
    expect(runs.map((r) => r.instance)).toEqual(['a', 'b']);
    expect(runs[1]!.fencingToken).toBeGreaterThan(runs[0]!.fencingToken!);

    await clockA.advance('10s'); // A wakes up: its renewals are refused
    expect(runs[0]!.signal!.aborted).toBe(true);
    expect(runs[0]!.signal!.reason).toBeInstanceOf(LockLostError);
    hold.resolve();
    await stale;
    expect(await a.jobs.reconcile()).toBeUndefined(); // B owns it now
    await b.jobs.reconcile();
    expect(runs.map((r) => r.instance)).toEqual(['a', 'b', 'b']);
  });

  it('on shutdown, waits for a run in progress, then hands the job over', async () => {
    const a = await instance('a');
    const b = await instance('b');
    const hold = deferred();
    gate = hold.promise;
    const running = a.jobs.nightly();
    await until(() => runs.length === 1);
    await clock.advance('2s');
    const closing = a.app.close();
    apps.splice(apps.indexOf(a.app), 1);
    await clock.advance(0);
    expect(await a.jobs.nightly()).toBeUndefined(); // no new runs once shutdown began
    expect(store.peek('reports:nightly:owner')).toBeDefined(); // still A's: its run goes on
    hold.resolve();
    await closing;
    expect(await running).toBe('done');
    gate = undefined;
    expect(await b.jobs.nightly()).toBe('done'); // A's lease went back at once
  });

  it('keeps the lease for a second after a run that just started, so a lagging clock cannot rerun the tick', async () => {
    const a = await instance('a');
    const b = await instance('b');
    await a.jobs.nightly();
    await clock.advance(400);
    await a.app.close();
    apps.splice(apps.indexOf(a.app), 1);
    expect(await b.jobs.nightly()).toBeUndefined(); // B's clock is behind: this is the tick A ran
    await clock.advance(600);
    expect(await b.jobs.nightly()).toBe('done');
  });

  it('fails closed when the store fails: the job does not run', async () => {
    const { jobs } = await instance('a');
    vi.spyOn(store, 'acquire').mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(jobs.nightly()).rejects.toThrow(
      'ReportJobs.nightly did not run: the lock store failed (ECONNREFUSED)',
    );
    expect(runs).toEqual([]);
    expect(await jobs.nightly()).toBe('done'); // the next tick tries again
  });

  it('logs a failed tick through @nestjs/schedule, like any job error', async () => {
    const { app } = await instance('a');
    vi.spyOn(store, 'acquire').mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await app.get(SchedulerRegistry).getCronJob('nightly-report').fireOnTick();
    await until(() => logger.matching('did not run').length > 0);
    expect(logger.matching('[Scheduler] ERROR Error: ReportJobs.nightly did not run: the lock store failed')).toHaveLength(1);
  });

  it('runs @Interval() and @Timeout() jobs on one instance', async () => {
    const intervalRuns: string[] = [];
    const timeoutRuns: string[] = [];
    @Injectable()
    class Timers {
      name = '?';
      @Interval(20)
      @OnOneInstance({ key: 'timers:interval' })
      tick() {
        intervalRuns.push(this.name);
      }
      @OnOneInstance({ key: 'timers:timeout' })
      @Timeout(10)
      warmUp() {
        timeoutRuns.push(this.name);
      }
    }
    // The system clock: @nestjs/schedule's own timers fire the jobs.
    const shared = new InMemoryLockStore();
    const started: TestingModule[] = [];

    for (const name of ['a', 'b', 'c']) {
      const app = await startInstance({ store: shared, providers: [Timers], schedule: true, logger });
      app.get(Timers).name = name;
      started.push(app);
    }

    apps.push(...started);
    await until(() => intervalRuns.length >= 5 && timeoutRuns.length >= 1);
    expect(new Set(intervalRuns).size).toBe(1);
    expect(timeoutRuns).toHaveLength(1);
  });

  it('refuses a call on an instance LocksModule does not know', async () => {
    const jobs = new ReportJobs(new LocksContext());
    await expect(jobs.nightly()).rejects.toThrow(
      'ReportJobs.nightly is decorated with @OnOneInstance(), but LocksModule doesn\'t know this instance, so it ' +
        "can't tell whether this call may run. Import LocksModule in the application, and provide ReportJobs as a " +
        'singleton provider',
    );
    expect(runs).toEqual([]);
  });

  it('warns about a request-scoped provider, whose calls would fail', async () => {
    @Injectable({ scope: Scope.REQUEST })
    class ScopedJobs {
      @OnOneInstance()
      run() {}
    }
    await startInstance({ providers: [ScopedJobs], logger }).then((app) => apps.push(app));
    expect(
      logger.matching(
        'WARN ScopedJobs.run is decorated with @OnOneInstance(), but ScopedJobs is not a singleton provider',
      ),
    ).toHaveLength(1);
  });

  describe('keys', () => {
    it('refuses two jobs whose default keys collide, but lets explicit keys be shared on purpose', async () => {
      const make = () => {
        @Injectable()
        class Jobs {
          @OnOneInstance()
          run() {}
        }
        return Jobs;
      };
      const [First, Second] = [make(), make()];
      const moduleRef = await Test.createTestingModule({
        imports: [LocksModule.forRoot()],
        providers: [First, { provide: 'second', useClass: Second }],
      }).compile();
      moduleRef.useLogger(false);
      await expect(moduleRef.init()).rejects.toThrow(
        'LocksModule: Jobs.run and Jobs.run both use the lock key "Jobs.run". Two jobs share a key only when both ' +
          'set it on purpose (to exclude each other); set `key` on @OnOneInstance() to tell them apart.',
      );

      @Injectable()
      class Exports {
        @WithoutOverlapping({ key: 'products-table' })
        exportProducts() {
          runs.push({ job: 'export', instance: 'a' });
          return gate;
        }
        @WithoutOverlapping({ key: 'products-table' })
        importProducts() {
          runs.push({ job: 'import', instance: 'a' });
        }
      }
      const app = await startInstance({ providers: [Exports], store, locks: { clock }, logger });
      apps.push(app);
      const hold = deferred();
      gate = hold.promise;
      const exporting = app.get(Exports).exportProducts();
      await until(() => runs.length === 1);
      expect(await app.get(Exports).importProducts()).toBeUndefined(); // the shared key excludes it
      hold.resolve();
      await exporting;
    });

    it("refuses a job whose key is another job's lease (`<key>:owner`)", async () => {
      @Injectable()
      class Nightly {
        @OnOneInstance({ key: 'reports:nightly' })
        run() {}
      }
      @Injectable()
      class Lease {
        @WithoutOverlapping({ key: 'reports:nightly:owner' })
        run() {}
      }
      const moduleRef = await Test.createTestingModule({ imports: [LocksModule.forRoot()], providers: [Nightly, Lease] }).compile();
      moduleRef.useLogger(false);
      await expect(moduleRef.init()).rejects.toThrow(
        'LocksModule: the job Lease.run (key "reports:nightly:owner") and the job Nightly.run (key "reports:nightly") both use ' +
          'the lock key "reports:nightly:owner", so they would exclude each other. Give one of them another key.',
      );
    });

    it('shares one key between the two decorators, set on either', () => {
      expect(() => {
        class Jobs {
          @OnOneInstance({ key: 'a' })
          @WithoutOverlapping({ key: 'b' })
          run() {}
        }
        return Jobs;
      }).toThrow(
        '@WithoutOverlapping() and @OnOneInstance() on Jobs.run set different keys ("b" and "a"): they share one, set it on either',
      );
    });

    it('checks the options when the class is defined', () => {
      expect(() => OnOneInstance({ key: '' })).toThrow('@OnOneInstance(): `key` must be a non-empty string, got ""');
      expect(() => WithoutOverlapping({ ttl: '1 hour' as never })).toThrow(
        '@WithoutOverlapping(): `ttl`: Invalid duration "1 hour"',
      );
      expect(() => OnOneInstance('reports' as never)).toThrow(
        '@OnOneInstance() takes an options object ({ key, ttl }), got "reports"',
      );
      expect(() => {
        class Jobs {
          @OnOneInstance()
          @OnOneInstance()
          run() {}
        }
        return Jobs;
      }).toThrow('@OnOneInstance() is applied twice to Jobs.run');
      expect(() => {
        class Jobs {
          @OnOneInstance()
          static run() {}
        }
        return Jobs;
      }).toThrow('@OnOneInstance() on Jobs.run: use it on an instance method of a provider, not a static method');
    });
  });

  it("uses the decorator's ttl for its lock, and the module's otherwise", async () => {
    const { jobs } = await instance('a');
    const acquire = vi.spyOn(store, 'acquire');
    await jobs.drain();
    await jobs.nightly();
    expect(acquire.mock.calls.map(([key, , ttl]) => [key, ttl])).toEqual([
      ['ReportJobs.drain', 10_000],
      ['reports:nightly:owner', 30_000],
    ]);
  });

  it('gives the job a signal that aborts when the instance loses the job, not only the run', async () => {
    const clockA = new ManualLockClock();
    const a = await instance('a', clockA);
    const hold = deferred();
    gate = hold.promise;
    const running = a.jobs.reconcile();
    await until(() => runs.length === 1);
    // Take only the lease from under A (as a store failover might), leaving the run lock.
    const lease = store.peek('ReportJobs.reconcile:owner')!;
    await store.release('ReportJobs.reconcile:owner', lease.owner);
    await clockA.advance('10s');
    expect(runs[0]!.signal!.aborted).toBe(true);
    hold.resolve();
    await running;
  });
});

describe('@OnOneInstance() without LocksModule', () => {
  it('fails the tick instead of running unguarded', async () => {
    @Injectable()
    class Jobs {
      ran = false;
      @OnOneInstance()
      run() {
        this.ran = true;
      }
    }
    @Module({ providers: [Jobs] })
    class AppModule {}
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    await expect(moduleRef.get(Jobs).run()).rejects.toThrow("LocksModule doesn't know this instance");
    expect(moduleRef.get(Jobs).ran).toBe(false);
    await moduleRef.close();
  });
});
