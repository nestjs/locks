import { Controller, Injectable } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { LocksContext } from '../lib/context/locks.context.js';
import { OnOneInstance } from '../lib/decorators/on-one-instance.decorator.js';
import { WithoutOverlapping } from '../lib/decorators/without-overlapping.decorator.js';
import { InMemoryLockStore } from '../lib/stores/in-memory-lock.store.js';
import { ManualLockClock } from '../lib/testing/manual-lock-clock.js';
import { CapturingLogger, deferred, startInstance, until } from './helpers.js';

describe('job decorators', () => {
  it('check their options when the class is defined', () => {
    expect(() => OnOneInstance({ key: 5 as never })).toThrow(new TypeError('@OnOneInstance(): `key` must be a non-empty string, got 5'));
    expect(() => WithoutOverlapping({ key: '' })).toThrow('@WithoutOverlapping(): `key` must be a non-empty string, got ""');
    expect(() => WithoutOverlapping(null as never)).toThrow('@WithoutOverlapping() takes an options object ({ key, ttl }), got null');
    expect(() => OnOneInstance({ ttl: 0 })).toThrow(new RangeError('@OnOneInstance(): `ttl` must be at least 1ms, got 0'));
    expect(() => OnOneInstance({ ttl: '1.5s' })).not.toThrow();
  });

  it('refuse an accessor, naming it', () => {
    class Jobs {
      get status() {
        return 'ok';
      }
    }
    const descriptor = Object.getOwnPropertyDescriptor(Jobs.prototype, 'status')!;
    expect(() => WithoutOverlapping()(Jobs.prototype, 'status', descriptor)).toThrow(
      '@WithoutOverlapping() on Jobs.status: use it on a method',
    );
  });

  it("keep the method's name, and apply each decorator once whatever the order", () => {
    class Jobs {
      @WithoutOverlapping()
      @OnOneInstance()
      reconcile() {}
    }
    expect(Jobs.prototype.reconcile.name).toBe('reconcile');
    expect(() => {
      class Twice {
        @WithoutOverlapping()
        @OnOneInstance()
        @WithoutOverlapping()
        run() {}
      }
      return Twice;
    }).toThrow('@WithoutOverlapping() is applied twice to Twice.run');
  });

  it('accept the same key set on both', () => {
    expect(() => {
      class Jobs {
        @OnOneInstance({ key: 'k' })
        @WithoutOverlapping({ key: 'k' })
        run() {}
      }
      return Jobs;
    }).not.toThrow();
  });
});

describe('jobs at run time', () => {
  let clock: ManualLockClock;
  let store: InMemoryLockStore;
  let apps: TestingModule[];
  let logger: CapturingLogger;

  async function instance(providers: unknown[], controllers: unknown[] = []) {
    const app = await startInstance({
      store,
      locks: { clock, ttl: '30s' },
      providers: providers as never[],
      imports: controllers.length ? [moduleWith(controllers)] : [],
      logger,
    });
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

  it("passes the call's arguments and `this` through, and resolves what the method returns", async () => {
    @Injectable()
    class Mailer {
      prefix = 'sent';
      @OnOneInstance()
      @WithoutOverlapping()
      async send(to: string, count: number) {
        return `${this.prefix} ${count} to ${to}`;
      }
    }
    const app = await instance([Mailer]);
    expect(await app.get(Mailer).send('ops', 3)).toBe('sent 3 to ops');
  });

  it("rejects with the method's own error, and releases the run lock but keeps the lease", async () => {
    @Injectable()
    class Failing {
      @OnOneInstance({ key: 'failing' })
      @WithoutOverlapping()
      run(): void {
        throw new Error('export failed');
      }
    }
    const app = await instance([Failing]);
    await expect(app.get(Failing).run()).rejects.toThrow('export failed');
    expect(store.peek('failing')).toBeUndefined();
    expect(store.peek('failing:owner')).toBeDefined();
    await expect(app.get(Failing).run()).rejects.toThrow('export failed'); // the next tick runs again
  });

  it('gives a job with both decorators the run lock in LocksContext, and one with only @OnOneInstance() the lease', async () => {
    const seen: Record<string, string | undefined> = {};
    @Injectable()
    class Jobs {
      constructor(private readonly context: LocksContext) {}
      @OnOneInstance({ key: 'both' })
      @WithoutOverlapping()
      both() {
        seen.both = this.context.lock?.key;
      }
      @OnOneInstance({ key: 'lease' })
      lease() {
        seen.lease = this.context.lock?.key;
      }
      @WithoutOverlapping({ key: 'run' })
      run() {
        seen.run = this.context.lock?.key;
      }
    }
    const app = await instance([Jobs]);
    const jobs = app.get(Jobs);
    await jobs.both();
    await jobs.lease();
    await jobs.run();
    expect(seen).toEqual({ both: 'both', lease: 'lease:owner', run: 'run' });
  });

  it('fails closed when the run lock cannot be taken because the store failed', async () => {
    const ran = vi.fn();
    @Injectable()
    class Drain {
      @WithoutOverlapping()
      async run() {
        ran();
      }
    }
    const app = await instance([Drain]);
    const cause = new Error('ECONNREFUSED');
    vi.spyOn(store, 'acquire').mockRejectedValueOnce(cause);
    const error = await app.get(Drain).run().catch((e: unknown) => e);
    expect(error).toMatchObject({ message: 'Drain.run did not run: the lock store failed (ECONNREFUSED)', cause });
    expect(ran).not.toHaveBeenCalled();
  });

  it('runs jobs on controllers too', async () => {
    @Controller()
    class ReportsController {
      runs = 0;
      @OnOneInstance({ key: 'controller-job' })
      rebuild() {
        this.runs++;
      }
    }
    const a = await instance([], [ReportsController]);
    const b = await instance([], [ReportsController]);
    await a.get(ReportsController).rebuild();
    expect(await b.get(ReportsController).rebuild()).toBeUndefined();
    expect(a.get(ReportsController).runs).toBe(1);
    expect(b.get(ReportsController).runs).toBe(0);
  });

  it('shares one lease between jobs that set the same key: they run on the same instance', async () => {
    const runs: string[] = [];
    @Injectable()
    class Products {
      name = '?';
      @OnOneInstance({ key: 'products' })
      exportProducts() {
        runs.push(`${this.name} export`);
      }
      @OnOneInstance({ key: 'products' })
      importProducts() {
        runs.push(`${this.name} import`);
      }
    }
    const a = await instance([Products]);
    const b = await instance([Products]);
    a.get(Products).name = 'a';
    b.get(Products).name = 'b';
    await a.get(Products).exportProducts();
    await b.get(Products).importProducts();
    await a.get(Products).importProducts();
    await b.get(Products).exportProducts();
    expect(runs).toEqual(['a export', 'a import']);
  });

  it('asks the store for one lease at a time when ticks arrive together', async () => {
    @Injectable()
    class Jobs {
      @OnOneInstance({ key: 'burst' })
      run() {
        return 'ran';
      }
    }
    const app = await instance([Jobs]);
    const acquire = vi.spyOn(store, 'acquire');
    const results = await Promise.all([app.get(Jobs).run(), app.get(Jobs).run(), app.get(Jobs).run()]);
    expect(results).toEqual(['ran', 'ran', 'ran']);
    expect(acquire.mock.calls.map(([key]) => key)).toEqual(['burst:owner']);
  });

  it('takes the lease back at the next tick after losing it, with a new token', async () => {
    @Injectable()
    class Jobs {
      constructor(readonly context: LocksContext) {}
      tokens: (number | undefined)[] = [];
      @OnOneInstance({ key: 'relead' })
      run() {
        this.tokens.push(this.context.fencingToken);
      }
    }
    const app = await instance([Jobs]);
    const jobs = app.get(Jobs);
    await jobs.run();
    vi.spyOn(store, 'renew').mockResolvedValueOnce(false);
    await clock.advance('10s'); // the renewal is refused: the lease is lost
    await store.release('relead:owner', store.peek('relead:owner')!.owner);
    await jobs.run();
    expect(jobs.tokens).toEqual([1, 2]);
  });

  it('skips calls once shutdown began, saying why', async () => {
    const hold = deferred();
    @Injectable()
    class Jobs {
      @WithoutOverlapping()
      run() {
        return hold.promise;
      }
    }
    const app = await instance([Jobs]);
    const running = app.get(Jobs).run();
    await until(() => store.peek('Jobs.run') !== undefined);
    const closing = app.close();
    apps = [];
    await clock.advance(0);
    expect(await app.get(Jobs).run()).toBeUndefined();
    expect(logger.matching('DEBUG Skipped Jobs.run: the application is shutting down')).toHaveLength(1);
    hold.resolve();
    await Promise.all([running, closing]);
    expect(store.peek('Jobs.run')).toBeUndefined();
  });
});

function moduleWith(controllers: unknown[]) {
  class ControllersModule {}
  Reflect.defineMetadata('controllers', controllers, ControllersModule);
  return ControllersModule;
}
