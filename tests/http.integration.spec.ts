import {
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Inject,
  Injectable,
  Module,
  Param,
  Post,
  Query,
  type INestApplication,
} from '@nestjs/common';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import request from 'supertest';
import { adapters, createApp, type AdapterName } from './support/adapters.js';
import {
  InMemoryLockStore,
  Lock,
  LockLostError,
  LockNotAcquiredError,
  Locks,
  LocksContext,
  LocksEvents,
  LocksModule,
  LocksStorage,
  ManualLockClock,
  type Duration,
  type LocksEvent,
} from '../lib/index.js';
import { deferred, until } from './helpers.js';

const INSTANCE = Symbol('INSTANCE');
const EXPORT_LOCK = 'invoices:export';

/** A resource every instance writes to, which refuses a write carrying a lower token than one it has seen. */
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

/** What the instances of one test share: the store, the ledger, and the gates that hold a request open. */
interface World {
  store: InMemoryLockStore;
  ledger: Ledger;
  gates: Map<string, Promise<void>>;
}

let world: World;

@Injectable()
class InvoiceExporter {
  constructor(
    @Inject(INSTANCE) private readonly instance: string,
    private readonly locksContext: LocksContext,
  ) {}

  async export(hold?: string) {
    const { fencingToken, signal } = this.locksContext;
    await (hold ? world.gates.get(hold) : undefined);
    const accepted = world.ledger.write(this.instance, fencingToken!);

    return { instance: this.instance, fencingToken, accepted, aborted: signal!.aborted };
  }
}

@Controller()
class ExportsController {
  /** Locks this instance holds across requests, and the reasons their signals aborted. */
  readonly held = new Map<string, Lock>();
  readonly aborted: unknown[] = [];

  constructor(
    private readonly locks: Locks,
    private readonly invoiceExporter: InvoiceExporter,
  ) {}

  @Post('exports')
  @HttpCode(200)
  async exportNow(@Query('hold') hold?: string, @Query('wait') wait?: Duration) {
    try {
      return await this.locks.withLock(EXPORT_LOCK, () => this.invoiceExporter.export(hold), { wait });
    } catch (error) {
      if (error instanceof LockNotAcquiredError) {
        throw new ConflictException(`An export is already running (waited ${error.waitMs}ms)`);
      }
      throw error;
    }
  }

  @Post('reports/:key/hold')
  @HttpCode(200)
  async hold(@Param('key') key: string) {
    const lock = await this.locks.acquire(key);
    if (!lock) {
      throw new ConflictException(`${key} is held elsewhere`);
    }

    lock.signal.addEventListener('abort', () => this.aborted.push(lock.signal.reason));
    this.held.set(key, lock);

    return { fencingToken: lock.fencingToken };
  }

  @Post('reports/:key/release')
  @HttpCode(200)
  async release(@Param('key') key: string) {
    return { released: await this.held.get(key)!.release() };
  }

  @Get('reports/:key/scoped')
  async scoped(@Param('key') key: string) {
    await using lock = await this.locks.acquire(key);

    return { fencingToken: lock?.fencingToken, held: lock?.held };
  }
}

function appModule(name: string, clock: ManualLockClock) {
  @Module({
    imports: [LocksModule.forRootAsync({ useFactory: () => ({ clock, ttl: '30s' }) })],
    controllers: [ExportsController],
    providers: [InvoiceExporter, { provide: INSTANCE, useValue: name }],
  })
  class AppModule {}

  return AppModule;
}

describe.each(adapters)('HTTP handlers under locks, several instances ($name)', ({ name: adapter }) => {
  let storeClock: ManualLockClock;
  let apps: INestApplication[];

  async function instance(name: string, clock = new ManualLockClock()) {
    const app = await createApp(adapter as AdapterName, appModule(name, clock), {
      setup: (app) => {
        app.useLogger(false);
        app.get(LocksStorage).registerSource(world.store, { replace: true });
      },
    });
    apps.push(app);
    const events: LocksEvent[] = [];
    app.get(LocksEvents).events$.subscribe((event) => events.push(event));

    return { app, clock, events, http: () => request(app.getHttpServer()), controller: app.get(ExportsController) };
  }

  /** Holds the next request that passes `hold=<id>` inside its critical section, until `open()`. */
  function gate(id: string) {
    const held = deferred();
    world.gates.set(id, held.promise);
    return { open: () => held.resolve() };
  }

  beforeEach(() => {
    storeClock = new ManualLockClock();
    world = { store: new InMemoryLockStore({ clock: storeClock }), ledger: new Ledger(), gates: new Map() };
    apps = [];
  });
  afterEach(async () => {
    for (const app of apps) {
      await app.close();
    }
  });

  it('runs one export at a time across instances, answering 409 to the others, with growing tokens', async () => {
    const [a, b, c] = await Promise.all(['a', 'b', 'c'].map((name) => instance(name)));
    const held = gate('first');
    const first = a!.http().post('/exports?hold=first').then((res) => res);
    await until(() => world.store.peek(EXPORT_LOCK) !== undefined);

    const refused = await Promise.all([b!.http().post('/exports'), c!.http().post('/exports')]);
    expect(refused.map((res) => res.status)).toEqual([409, 409]);
    expect(refused[0]!.body.message).toBe('An export is already running (waited 0ms)');

    held.open();
    const done = await first;
    expect(done.status).toBe(200);
    expect(done.body).toEqual({ instance: 'a', fencingToken: 1, accepted: true, aborted: false });
    expect(world.store.peek(EXPORT_LOCK)).toBeUndefined();

    const next = await b!.http().post('/exports').expect(200);
    expect(next.body).toMatchObject({ instance: 'b', fencingToken: 2, accepted: true });
    expect(world.ledger.entries).toEqual([
      { instance: 'a', fencingToken: 1 },
      { instance: 'b', fencingToken: 2 },
    ]);
  });

  it('wakes a request waiting on the same instance as soon as the holder releases', async () => {
    const a = await instance('a');
    const held = gate('first');
    const first = a.http().post('/exports?hold=first').then((res) => res);
    await until(() => world.store.peek(EXPORT_LOCK) !== undefined);
    const second = a.http().post('/exports?wait=5s').then((res) => res);
    await until(() => a.clock.pendingTimers === 2); // the holder's renewal, and the waiter's backoff

    held.open();
    const [one, two] = await Promise.all([first, second]);
    expect([one.status, two.status]).toEqual([200, 200]);
    expect(two.body.fencingToken).toBeGreaterThan(one.body.fencingToken);
  });

  it("polls for another instance's lock with backoff, on its own clock, and takes it once freed", async () => {
    const a = await instance('a');
    const b = await instance('b');
    const held = gate('first');
    const byA = a.http().post('/exports?hold=first').then((res) => res);
    await until(() => world.store.peek(EXPORT_LOCK) !== undefined);
    const byB = b.http().post('/exports?wait=2s').then((res) => res);
    await until(() => b.clock.pendingTimers === 1); // B tried once, and sleeps on its backoff

    // A release on another instance doesn't wake B: its next poll does.
    held.open();
    expect((await byA).status).toBe(200);
    await b.clock.advance('1s');
    const response = await byB;
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ instance: 'b', fencingToken: 2, accepted: true });
  });

  it('answers 409 after waiting out the whole wait on the other instance', async () => {
    const a = await instance('a');
    const b = await instance('b');
    const held = gate('long');
    const first = a.http().post('/exports?hold=long').then((res) => res);
    await until(() => world.store.peek(EXPORT_LOCK) !== undefined);

    const waiting = b.http().post('/exports?wait=2s').then((res) => res);
    await until(() => b.clock.pendingTimers === 1);
    await b.clock.advance('2s');
    const response = await waiting;
    expect(response.status).toBe(409);
    expect(response.body.message).toBe('An export is already running (waited 2000ms)');

    held.open();
    expect((await first).status).toBe(200);
  });

  it('fences off the write of a request whose instance paused past its lease', async () => {
    const published: unknown[] = [];
    const listener = (event: unknown) => published.push(event);
    subscribe('nestjs:locks:lock-lost', listener);

    try {
      const a = await instance('a');
      const b = await instance('b');
      const held = gate('paused');
      const stale = a.http().post('/exports?hold=paused').then((res) => res);
      await until(() => world.store.peek(EXPORT_LOCK) !== undefined);

      // A stands still (its clock doesn't move) while the store's clock passes its lease.
      await storeClock.advance('31s');
      const fresh = await b.http().post('/exports').expect(200);
      expect(fresh.body).toMatchObject({ instance: 'b', fencingToken: 2, accepted: true });

      // A wakes up: its next renewal is refused, and its signal aborts.
      await a.clock.advance('10s');
      expect(a.events).toEqual([{ type: 'lock-lost', key: EXPORT_LOCK, fencingToken: 1, detectedBy: 'renewal' }]);
      expect(published).toEqual(a.events);

      held.open();
      const late = await stale;
      expect(late.status).toBe(200);
      expect(late.body).toEqual({ instance: 'a', fencingToken: 1, accepted: false, aborted: true });
      expect(world.ledger.entries).toEqual([{ instance: 'b', fencingToken: 2 }]);
      expect(b.events).toEqual([]);
    } finally {
      unsubscribe('nestjs:locks:lock-lost', listener);
    }
  });

  it('renews a lock held across requests for as long as it is held, and releases it on request', async () => {
    const a = await instance('a');
    const b = await instance('b');
    await a.http().post('/reports/monthly/hold').expect(200);

    // Five minutes on both clocks, ten seconds at a time: A renews every ttl / 3.
    for (let step = 0; step < 30; step++) {
      await storeClock.advance('10s');
      await a.clock.advance('10s');
    }
    await b.http().post('/reports/monthly/hold').expect(409);
    expect(world.store.peek('monthly')!.expiresAt).toBe(storeClock.now() + 30_000);

    expect((await a.http().post('/reports/monthly/release').expect(200)).body).toEqual({ released: true });
    expect(a.controller.aborted).toEqual([expect.objectContaining({ name: 'AbortError' })]);
    expect((await b.http().post('/reports/monthly/hold').expect(200)).body).toEqual({ fencingToken: 2 });
  });

  it('releases an `await using` lock when the handler returns', async () => {
    const a = await instance('a');
    const b = await instance('b');
    const response = await a.http().get('/reports/weekly/scoped').expect(200);
    expect(response.body).toEqual({ fencingToken: 1, held: true });
    expect(world.store.peek('weekly')).toBeUndefined();
    expect((await b.http().get('/reports/weekly/scoped').expect(200)).body).toEqual({ fencingToken: 2, held: true });
  });

  it('releases the locks an instance holds when it shuts down, so another instance takes them at once', async () => {
    const a = await instance('a');
    const b = await instance('b');
    await a.http().post('/reports/monthly/hold').expect(200);
    await b.http().post('/reports/monthly/hold').expect(409);
    let completed = false;
    a.app.get(LocksEvents).events$.subscribe({ complete: () => (completed = true) });

    await a.app.close();
    apps.splice(apps.indexOf(a.app), 1);
    expect(a.controller.aborted).toEqual([expect.objectContaining({ name: 'AbortError' })]);
    expect(a.controller.aborted[0]).not.toBeInstanceOf(LockLostError);
    expect(completed).toBe(true);
    expect((await b.http().post('/reports/monthly/hold').expect(200)).body).toEqual({ fencingToken: 2 });
  });
});
