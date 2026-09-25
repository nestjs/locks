import { Inject, Injectable, type Type } from '@nestjs/common';
import { Cron, ScheduleModule, SchedulerRegistry } from '@nestjs/schedule';
import { Test, type TestingModule } from '@nestjs/testing';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import {
  InMemoryLockStore,
  LeaderElection,
  LockLostError,
  LockNotAcquiredError,
  Locks,
  LocksContext,
  LocksEvents,
  LocksModule,
  LocksStorage,
  ManualLockClock,
  OnOneInstance,
  WithoutOverlapping,
  type Lock,
  type LocksEvent,
  type OnLeadershipAcquired,
  type OnLeadershipLost,
} from '../lib/index.js';
import { CapturingLogger, deferred, until } from './helpers.js';
import { DrizzleLockStore } from './fixtures/database/drizzle-lock.store.js';
import { openBackends } from './store-backends.js';

const backends = await openBackends();
afterAll(async () => {
  for (const backend of backends) {
    await backend.close();
  }
});

const NAME = Symbol('NAME');
/** A schedule that never fires on its own: the tests fire the ticks. */
const NEVER = '0 3 29 2 *';
const EXPORT_KEY = 'invoices:export';
const LEASE_KEY = `${EXPORT_KEY}:owner`;
const FEED_KEY = 'inventory:warehouse-feed';
const CHANNELS = ['nestjs:locks:lock-lost', 'nestjs:locks:leadership-acquired', 'nestjs:locks:leadership-lost'];

/** The accounting system every instance books into: it refuses a batch with a lower token than one it has booked. */
class Ledger {
  highest = 0;
  readonly entries: { instance: string; fencingToken: number }[] = [];

  write(instance: string, fencingToken: number): boolean {
    if (fencingToken < this.highest) {
      return false;
    }

    this.highest = fencingToken;
    this.entries.push({ instance, fencingToken });

    return true;
  }
}

interface Run {
  instance: string;
  fencingToken: number;
  signal: AbortSignal;
  accepted?: boolean;
}

let ledger: Ledger;
let runs: Run[];
/** Per instance name: the next runs there wait for it before they book. */
let gates: Map<string, Promise<void>>;
let leadership: string[];

@Injectable()
class InvoiceExportJob {
  constructor(
    @Inject(NAME) private readonly instance: string,
    private readonly locksContext: LocksContext,
  ) {}

  @Cron(NEVER, { name: 'invoice-export' })
  @OnOneInstance({ key: EXPORT_KEY })
  @WithoutOverlapping()
  async export() {
    const { fencingToken, signal } = this.locksContext;
    const run: Run = { instance: this.instance, fencingToken: fencingToken!, signal: signal! };
    runs.push(run);
    await gates.get(this.instance);
    run.accepted = ledger.write(this.instance, run.fencingToken);

    return run.accepted;
  }
}

@Injectable()
@LeaderElection(FEED_KEY, { ttl: '15s' })
class WarehouseFeed implements OnLeadershipAcquired, OnLeadershipLost {
  lock?: Lock;

  constructor(@Inject(NAME) private readonly instance: string) {}

  onLeadershipAcquired(lock: Lock) {
    this.lock = lock;
    leadership.push(`${this.instance} leads (token ${lock.fencingToken})`);
  }

  onLeadershipLost(lock: Lock) {
    if (this.lock === lock) {
      this.lock = undefined;
    }
    leadership.push(`${this.instance} lost (${(lock.signal.reason as Error).name})`);
  }
}

for (const backend of backends) {
  const title = `several instances on ${backend.name}${backend.unavailable ? ` (skipped: ${backend.unavailable})` : ''}`;

  describe.skipIf(!!backend.unavailable)(title, () => {
    let apps: TestingModule[];
    let logger: CapturingLogger;
    let published: { channel: string; event: unknown }[];
    const listeners = CHANNELS.map((channel) => ({ channel, listener: (event: unknown) => published.push({ channel, event }) }));

    /** One instance of the app: its own clock, its own connection to the shared store. */
    async function instance(name: string, providers: Type<unknown>[] = []) {
      const clock = new ManualLockClock();
      const app = await Test.createTestingModule({
        imports: [...backend.modules(), ScheduleModule.forRoot(), LocksModule.forRoot({ clock, ttl: '30s' })],
        providers: [...backend.providers(), ...providers, { provide: NAME, useValue: name }],
      }).compile();
      app.useLogger(logger);
      backend.beforeInit(app);
      const events: LocksEvent[] = [];
      app.get(LocksEvents).events$.subscribe((event) => events.push(event));
      await app.init();
      apps.push(app);

      return { name, app, clock, events, locks: app.get(Locks) };
    }

    async function stop(app: TestingModule) {
      apps.splice(apps.indexOf(app), 1);
      await app.close();
    }

    /** Holds the runs that start on `name` from now on, until `open()`. */
    function gate(name: string) {
      const held = deferred();
      gates.set(name, held.promise);
      return {
        open: () => {
          gates.delete(name);
          held.resolve();
        },
      };
    }

    beforeEach(async () => {
      await backend.reset();
      apps = [];
      logger = new CapturingLogger();
      ledger = new Ledger();
      runs = [];
      gates = new Map();
      leadership = [];
      published = [];
      for (const { channel, listener } of listeners) {
        subscribe(channel, listener);
      }
    });
    afterEach(async () => {
      for (const { channel, listener } of listeners) {
        unsubscribe(channel, listener);
      }
      for (const app of apps.splice(0)) {
        await app.close();
      }
    });

    it('boots every instance on the store, which registered itself', async () => {
      const [a, b] = await Promise.all([instance('a'), instance('b')]);
      const store = backend.storeOf(a.app);

      expect(a.app.get(LocksStorage).source).toBe(store);
      expect(b.app.get(LocksStorage).source).toBe(backend.storeOf(b.app));
      expect(logger.matching(`[LocksModule] LocksStorage: ${store.constructor.name}`)).toHaveLength(2);
    });

    it('lets one instance at a time into a withLock() section, with a token greater than the last', async () => {
      const instances = await Promise.all(['a', 'b', 'c'].map((name) => instance(name)));
      const entered: number[] = [];
      let inside = 0;
      let most = 0;

      for (let round = 0; round < 5; round++) {
        const results = await Promise.allSettled(
          instances.map(({ locks }) =>
            locks.withLock('stock:recount', async (lock) => {
              inside++;
              most = Math.max(most, inside);
              entered.push(lock.fencingToken);
              // The store itself says who holds the key, while the section runs.
              const holder = await backend.holder('stock:recount');
              inside--;

              return holder === lock.owner;
            }),
          ),
        );

        const fulfilled = results.filter((result) => result.status === 'fulfilled');
        expect(fulfilled.length).toBeGreaterThanOrEqual(1);
        expect(fulfilled.every((result) => result.value === true)).toBe(true);
        for (const result of results) {
          if (result.status === 'rejected') {
            expect(result.reason).toBeInstanceOf(LockNotAcquiredError);
          }
        }
      }

      expect(most).toBe(1);
      expect(entered).toEqual([...entered].sort((x, y) => x - y));
      expect(new Set(entered).size).toBe(entered.length);
      expect(await backend.holder('stock:recount')).toBeUndefined();
    });

    it("waits for another instance's lock by polling the store, and takes it once released", async () => {
      const a = await instance('a');
      const b = await instance('b');
      const held = await a.locks.acquire('reports:monthly');
      const waiting = b.locks.acquire('reports:monthly', { wait: '5s' });
      await until(() => b.clock.pendingTimers === 1); // B tried once, and sleeps on its backoff

      expect(await held!.release()).toBe(true);
      await b.clock.advance('1s');
      const taken = await waiting;
      expect(taken!.fencingToken).toBeGreaterThan(held!.fencingToken);
      expect(await backend.holder('reports:monthly')).toBe(taken!.owner);
      await taken!.release();
    });

    it('runs a scheduled job on one instance, which keeps it, one run at a time', async () => {
      const instances = await Promise.all(['a', 'b', 'c'].map((name) => instance(name, [InvoiceExportJob])));
      const [a, b, c] = instances.map(({ app }) => app.get(InvoiceExportJob));

      // The first tick through @nestjs/schedule's own callback takes the job's lease.
      await instances[0]!.app.get(SchedulerRegistry).getCronJob('invoice-export').fireOnTick();
      await until(() => runs[0]?.accepted !== undefined);
      expect(await Promise.all([b!.export(), c!.export()])).toEqual([undefined, undefined]);
      expect(await backend.holder(LEASE_KEY)).toBeDefined();
      expect(await backend.holder(EXPORT_KEY)).toBeUndefined();

      // While a run holds the run lock, the owner's next tick is skipped too.
      const held = gate('a');
      const running = a!.export();
      await until(() => runs.length === 2);
      expect(await Promise.all([a!.export(), b!.export(), c!.export()])).toEqual([undefined, undefined, undefined]);
      expect(await backend.holder(EXPORT_KEY)).toBeDefined();
      held.open();
      expect(await running).toBe(true);

      expect(runs.map((run) => run.instance)).toEqual(['a', 'a']);
      expect(runs[1]!.fencingToken).toBeGreaterThan(runs[0]!.fencingToken);
      expect(logger.matching(`InvoiceExportJob.export runs on this instance (lease "${LEASE_KEY}"`)).toHaveLength(1);
      expect(logger.matching('Skipped InvoiceExportJob.export: it runs on another instance')).toHaveLength(4);
      expect(logger.matching('Skipped InvoiceExportJob.export: a run is still in progress')).toHaveLength(1);
    });

    it('moves the job to another instance when the owner stalls past its lease, and fences off the stale run', async () => {
      const a = await instance('a', [InvoiceExportJob]);
      const b = await instance('b', [InvoiceExportJob]);
      const held = gate('a');
      const stale = a.app.get(InvoiceExportJob).export();
      await until(() => runs.length === 1);

      // A stalls mid-run (its clock stands still) while the store expires its lease and run lock.
      await backend.expire([EXPORT_KEY, LEASE_KEY]);
      expect(await b.app.get(InvoiceExportJob).export()).toBe(true);
      expect(runs[1]).toMatchObject({ instance: 'b', accepted: true });
      expect(runs[1]!.fencingToken).toBeGreaterThan(runs[0]!.fencingToken);

      // A wakes up: both renewals are refused, and the run's signal aborts.
      await a.clock.advance('10s');
      expect(runs[0]!.signal.aborted).toBe(true);
      expect(runs[0]!.signal.reason).toBeInstanceOf(LockLostError);
      expect(a.events).toEqual(
        expect.arrayContaining([
          { type: 'lock-lost', key: EXPORT_KEY, fencingToken: runs[0]!.fencingToken, detectedBy: 'renewal' },
          expect.objectContaining({ type: 'lock-lost', key: LEASE_KEY, detectedBy: 'renewal' }),
        ]),
      );
      expect(a.events).toHaveLength(2);
      expect(published.map(({ channel }) => channel)).toEqual(['nestjs:locks:lock-lost', 'nestjs:locks:lock-lost']);
      expect(logger.matching('WARN')).toHaveLength(2);

      // Its booking carries the old token: the ledger refuses it.
      held.open();
      expect(await stale).toBe(false);
      expect(ledger.entries).toEqual([{ instance: 'b', fencingToken: runs[1]!.fencingToken }]);

      // B keeps the job.
      await b.clock.advance('1m');
      expect(await a.app.get(InvoiceExportJob).export()).toBeUndefined();
      expect(await b.app.get(InvoiceExportJob).export()).toBe(true);
      expect(b.events).toEqual([]);
    });

    it('on a clean shutdown, lets the run finish, then hands the job over', async () => {
      const a = await instance('a', [InvoiceExportJob]);
      const b = await instance('b', [InvoiceExportJob]);
      const held = gate('a');
      const running = a.app.get(InvoiceExportJob).export();
      await until(() => runs.length === 1);
      await a.clock.advance('1s'); // past the handover grace

      let closed = false;
      const closing = stop(a.app).then(() => (closed = true));
      expect(await b.app.get(InvoiceExportJob).export()).toBeUndefined();
      expect(closed).toBe(false);

      held.open();
      await closing;
      expect(await running).toBe(true);
      expect(runs[0]!.signal.reason).not.toBeInstanceOf(LockLostError);
      expect(await backend.holder(LEASE_KEY)).toBeUndefined();

      expect(await b.app.get(InvoiceExportJob).export()).toBe(true);
      expect(runs.map((run) => [run.instance, run.accepted])).toEqual([
        ['a', true],
        ['b', true],
      ]);
      expect(runs[1]!.fencingToken).toBeGreaterThan(runs[0]!.fencingToken);
      expect(a.events).toEqual([]);
    });

    it('elects one leader, which renews its lease, and fails over when the leader shuts down', async () => {
      const a = await instance('a', [WarehouseFeed]);
      await until(() => leadership.length === 1);
      const b = await instance('b', [WarehouseFeed]);
      const c = await instance('c', [WarehouseFeed]);
      await until(() => b.clock.pendingTimers === 1 && c.clock.pendingTimers === 1); // their campaigns were refused

      const leader = a.app.get(WarehouseFeed).lock!;
      expect(leadership).toEqual([`a leads (token ${leader.fencingToken})`]);
      expect(a.events).toEqual([{ type: 'leadership-acquired', key: FEED_KEY, fencingToken: leader.fencingToken }]);

      const renew = vi.spyOn(backend.storeOf(a.app), 'renew');
      for (const { clock } of [a, b, c]) {
        await clock.advance('1m');
      }
      expect(renew.mock.calls.filter(([key, owner]) => key === FEED_KEY && owner === leader.owner)).toHaveLength(12);
      expect(await backend.holder(FEED_KEY)).toBe(leader.owner);
      expect(leadership).toHaveLength(1);
      renew.mockRestore();

      await stop(a.app);
      expect(leadership.at(-1)).toBe('a lost (AbortError)');
      expect(a.events.at(-1)).toEqual({ type: 'leadership-lost', key: FEED_KEY, fencingToken: leader.fencingToken, reason: 'released' });
      expect(await backend.holder(FEED_KEY)).toBeUndefined();

      await b.clock.advance('5s');
      await c.clock.advance('5s');
      const next = b.app.get(WarehouseFeed).lock!;
      expect(next.fencingToken).toBeGreaterThan(leader.fencingToken);
      expect(leadership.slice(2)).toEqual([`b leads (token ${next.fencingToken})`]);
      expect(c.app.get(WarehouseFeed).lock).toBeUndefined();
      expect(published.map(({ channel, event }) => [channel, (event as LocksEvent).fencingToken])).toEqual([
        ['nestjs:locks:leadership-acquired', leader.fencingToken],
        ['nestjs:locks:leadership-lost', leader.fencingToken],
        ['nestjs:locks:leadership-acquired', next.fencingToken],
      ]);
    });

    it("fails over when the leader's lease expires, and tells the old leader at its next renewal", async () => {
      const a = await instance('a', [WarehouseFeed]);
      await until(() => leadership.length === 1);
      const b = await instance('b', [WarehouseFeed]);
      await until(() => b.clock.pendingTimers === 1);
      const stale = a.app.get(WarehouseFeed).lock!;

      // A stalls (its clock stands still) past its lease; B's next campaign takes over.
      await backend.expire([FEED_KEY]);
      await b.clock.advance('5s');
      const next = b.app.get(WarehouseFeed).lock!;
      expect(next.fencingToken).toBeGreaterThan(stale.fencingToken);
      expect(a.app.get(WarehouseFeed).lock).toBe(stale);

      await a.clock.advance('5s');
      expect(leadership).toEqual([
        `a leads (token ${stale.fencingToken})`,
        `b leads (token ${next.fencingToken})`,
        'a lost (LockLostError)',
      ]);
      expect(a.events.slice(1)).toEqual([
        { type: 'lock-lost', key: FEED_KEY, fencingToken: stale.fencingToken, detectedBy: 'renewal' },
        { type: 'leadership-lost', key: FEED_KEY, fencingToken: stale.fencingToken, reason: 'lost' },
      ]);
      expect(published.map(({ channel }) => channel)).toEqual([
        'nestjs:locks:leadership-acquired',
        'nestjs:locks:leadership-acquired',
        'nestjs:locks:lock-lost',
        'nestjs:locks:leadership-lost',
      ]);

      // A campaigns again, and B keeps the lead.
      await a.clock.advance('1m');
      await b.clock.advance('1m');
      expect(leadership).toHaveLength(3);
      expect(await backend.holder(FEED_KEY)).toBe(next.owner);
    });

    it("releases every lock an instance holds at shutdown, before the store's connection closes", async () => {
      const a = await instance('a', [InvoiceExportJob, WarehouseFeed]);
      const b = await instance('b', [InvoiceExportJob]);
      await until(() => leadership.length === 1);
      const held = await a.locks.acquire('reports:monthly');
      expect(await a.app.get(InvoiceExportJob).export()).toBe(true);
      await a.clock.advance('1s'); // past the handover grace
      let completed = false;
      a.app.get(LocksEvents).events$.subscribe({ complete: () => (completed = true) });

      await stop(a.app);
      expect(held!.signal.reason).toMatchObject({ name: 'AbortError' });
      for (const key of ['reports:monthly', LEASE_KEY, FEED_KEY]) {
        expect(await backend.holder(key)).toBeUndefined();
      }
      expect(logger.matching('ERROR')).toEqual([]);
      expect(completed).toBe(true);

      const taken = await b.locks.acquire('reports:monthly');
      expect(taken!.fencingToken).toBeGreaterThan(held!.fencingToken);
      expect(await b.app.get(InvoiceExportJob).export()).toBe(true);
      await taken!.release();
    });
  });
}

describe("testing an app whose store is the Drizzle recipe, without a database", () => {
  it('overrideProvider(DrizzleLockStore).useValue(new InMemoryLockStore()) runs it on the in-memory default', async () => {
    const override = new InMemoryLockStore();
    const logger = new CapturingLogger();
    runs = [];
    gates = new Map();
    ledger = new Ledger();
    const app = await Test.createTestingModule({
      imports: [ScheduleModule.forRoot(), LocksModule.forRoot()],
      providers: [DrizzleLockStore, InvoiceExportJob, { provide: NAME, useValue: 'a' }],
    })
      .overrideProvider(DrizzleLockStore)
      .useValue(override)
      .compile();
    app.useLogger(logger);
    await app.init();

    try {
      // A plain instance doesn't register itself: the default store applies, and one instance runs every tick.
      const source = app.get(LocksStorage).source as InMemoryLockStore;
      expect(source).toBeInstanceOf(InMemoryLockStore);
      expect(source).not.toBe(override);
      expect(logger.matching('LocksStorage: InMemoryLockStore (the default')).toHaveLength(1);

      await app.get(SchedulerRegistry).getCronJob('invoice-export').fireOnTick();
      await until(() => runs[0]?.accepted !== undefined);
      expect(await app.get(InvoiceExportJob).export()).toBe(true);
      expect(source.peek(LEASE_KEY)).toMatchObject({ fencingToken: 1 });
      expect(source.peek(EXPORT_KEY)).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});
