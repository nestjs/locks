import { Injectable, Logger, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as api from '../lib/index.js';
import type { LocksModuleOptions, LocksOptionsFactory } from '../lib/interfaces/locks-module-options.interface.js';
import { LOCKS_INTERNALS } from '../lib/locks.constants.js';
import { LocksModule } from '../lib/locks.module.js';
import { Locks } from '../lib/locks.service.js';
import { LocksStorage } from '../lib/storage/locks.storage.js';
import { InMemoryLockStore } from '../lib/stores/in-memory-lock.store.js';
import { ManualLockClock } from '../lib/testing/manual-lock-clock.js';

async function compile(imports: unknown[], providers: unknown[] = []) {
  const moduleRef = await Test.createTestingModule({ imports: imports as never[], providers: providers as never[] }).compile();
  moduleRef.useLogger(false);
  await moduleRef.init();
  return moduleRef;
}

describe('LocksModule options', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('rounds a fractional ttl up to whole milliseconds, and reads fractional units', async () => {
    const fractional = await compile([LocksModule.forRoot({ ttl: 0.2 })]);
    expect(fractional.get(Locks)[LOCKS_INTERNALS].defaultTtl).toBe(1);
    await fractional.close();
    const seconds = await compile([LocksModule.forRoot({ ttl: '1.5s' })]);
    expect(seconds.get(Locks)[LOCKS_INTERNALS].defaultTtl).toBe(1_500);
    await seconds.close();
  });

  it('refuses a clock class instead of an instance, naming it', async () => {
    await expect(compile([LocksModule.forRoot({ clock: ManualLockClock as never })])).rejects.toThrow(
      'LocksModule: `clock` must implement LockClock (now, setTimeout, clearTimeout), got the class ManualLockClock (pass an instance)',
    );
  });

  it('runs the in-memory default on the configured clock', async () => {
    const clock = new ManualLockClock();
    const moduleRef = await compile([LocksModule.forRoot({ clock })]);
    const lock = (await moduleRef.get(Locks).acquire('k', { ttl: '5s' }))!;
    const store = moduleRef.get(LocksStorage).source as InMemoryLockStore;
    expect(store.peek('k')!.expiresAt).toBe(clock.now() + 5_000);
    await lock.release();
    await moduleRef.close();
  });

  it('takes options from forRootAsync({ useExisting }) and from a factory with inject', async () => {
    const clock = new ManualLockClock();

    @Injectable()
    class LocksConfig implements LocksOptionsFactory {
      createLocksOptions(): LocksModuleOptions {
        return { ttl: '2s', clock };
      }
    }
    @Module({ providers: [LocksConfig], exports: [LocksConfig] })
    class ConfigModule {}

    const existing = await compile([LocksModule.forRootAsync({ imports: [ConfigModule], useExisting: LocksConfig })]);
    expect(existing.get(Locks)[LOCKS_INTERNALS]).toMatchObject({ defaultTtl: 2_000, clock });
    await existing.close();

    const injected = await compile([
      LocksModule.forRootAsync({
        imports: [ConfigModule],
        inject: [LocksConfig],
        useFactory: (config: LocksConfig) => ({ ...config.createLocksOptions(), ttl: '4s' }),
      }),
    ]);
    expect(injected.get(Locks)[LOCKS_INTERNALS]).toMatchObject({ defaultTtl: 4_000, clock });
    await injected.close();
  });

  it('fails at startup on a bad ttl from forRootAsync(), naming the option', async () => {
    await expect(compile([LocksModule.forRootAsync({ useFactory: () => ({ ttl: 'soon' as never }) })])).rejects.toThrow(
      'LocksModule: `ttl`: Invalid duration "soon"',
    );
  });

  it('is not global with forRootAsync({ isGlobal: false })', async () => {
    @Injectable()
    class Consumer {
      constructor(readonly locks: Locks) {}
    }
    @Module({ providers: [Consumer] })
    class FeatureModule {}
    await expect(
      compile([LocksModule.forRootAsync({ isGlobal: false, useFactory: () => ({}) }), FeatureModule]),
    ).rejects.toThrow(/can't resolve dependencies/);
  });

  it('refuses a `store` next to forRootAsync() options too', () => {
    expect(() => LocksModule.forRootAsync({ useFactory: () => ({}), store: {} } as never)).toThrow(
      'LocksModule: `store` is not an option.',
    );
  });

  it('reads allowInMemoryStorage from forRootAsync() in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    const moduleRef = await compile([LocksModule.forRootAsync({ useFactory: async () => ({ allowInMemoryStorage: true }) })]);
    expect(moduleRef.get(LocksStorage).source).toBeInstanceOf(InMemoryLockStore);
    await moduleRef.close();
    await expect(compile([LocksModule.forRootAsync({ useFactory: async () => ({}) })])).rejects.toThrow('no LockStore is registered');
  });
});

describe('LocksStorage: messages', () => {
  afterEach(() => vi.restoreAllMocks());

  it('names a single missing method, and an anonymous class', () => {
    const storage = new LocksStorage();
    expect(() => storage.registerSource({ acquire() {}, renew() {} } as never)).toThrow(
      "LocksStorage.registerSource(): an object doesn't implement LockStore: release() is missing.",
    );
    expect(() => storage.registerSource((() => class {})() as never)).toThrow('got the class (anonymous) (pass an instance)');
    expect(() => storage.registerSource('redis' as never)).toThrow('expected an object implementing LockStore, got redis.');
  });

  it('names the registered store, not the default, when a registration comes too late', () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    const storage = new LocksStorage();
    storage.registerSource(new InMemoryLockStore());
    expect(storage.source).toBeInstanceOf(InMemoryLockStore);
    expect(() => storage.registerSource(new InMemoryLockStore(), { replace: true })).toThrow(
      'InMemoryLockStore registered after LocksModule initialized (or after its storage was first read), which already uses InMemoryLockStore. Register',
    );
  });
});

describe('InMemoryLockStore on the system clock', () => {
  afterEach(() => vi.restoreAllMocks());

  it('expires locks by Date.now()', async () => {
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const store = new InMemoryLockStore();
    await store.acquire('k', 'a', 100);
    expect(store.peek('k')).toEqual({ owner: 'a', fencingToken: 1, expiresAt: 1_100 });
    now = 1_099;
    expect(await store.renew('k', 'a', 100)).toBe(true);
    now = 1_198;
    expect(store.peek('k')).toBeDefined();
    now = 1_199;
    expect(store.peek('k')).toBeUndefined();
  });
});

describe('public surface', () => {
  it("keeps the package's internals and the contract suite out of the main entry", () => {
    for (const name of ['LOCKS_INTERNALS', 'LINGER', 'DEFAULT_TTL', 'systemClock', 'toMs', 'runInLockScope', 'lockStoreContract', 'LockKeys']) {
      expect(api).not.toHaveProperty(name);
    }
    expect(api.LocksError.prototype).toBeInstanceOf(Error);
  });
});
