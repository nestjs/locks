import { Inject, Injectable, Logger, Module, type OnModuleInit } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Locks } from '../lib/locks.service.js';
import { LocksModule } from '../lib/locks.module.js';
import { LocksStorage } from '../lib/storage/locks.storage.js';
import type { LockAcquireResult, LockStore } from '../lib/interfaces/lock-store.interface.js';
import { InMemoryLockStore } from '../lib/stores/in-memory-lock.store.js';

class AppLockStore implements LockStore {
  async acquire(): Promise<LockAcquireResult> {
    return { acquired: true, fencingToken: 1 };
  }
  async renew() {
    return true;
  }
  async release() {
    return true;
  }
}

const DB = Symbol('DB');

@Injectable()
class RegisteringStore extends AppLockStore {
  constructor(@Inject(DB) readonly db: unknown, storage: LocksStorage) {
    super();
    storage.registerSource(this);
  }
}

async function boot(providers: unknown[] = [], options = {}) {
  const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});

  try {
    const moduleRef = await Test.createTestingModule({
      imports: [LocksModule.forRoot(options)],
      providers: [{ provide: DB, useValue: {} }, ...(providers as never[])],
    }).compile();
    await moduleRef.init();
    return { moduleRef, logged: log.mock.calls.map((call) => call[0]) };
  } finally {
    log.mockRestore();
  }
}

describe('LocksStorage', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('uses the provider that registers itself, and logs it', async () => {
    const { moduleRef, logged } = await boot([RegisteringStore]);
    expect(moduleRef.get(LocksStorage).source).toBe(moduleRef.get(RegisteringStore));
    expect(logged).toContain('LocksStorage: RegisteringStore');
    await moduleRef.close();
  });

  it('falls back to the in-memory store, and says what that means', async () => {
    const { moduleRef, logged } = await boot();
    expect(moduleRef.get(LocksStorage).source).toBeInstanceOf(InMemoryLockStore);
    expect(logged).toContain(
      'LocksStorage: InMemoryLockStore (the default: locks exclude callers in this process only, and are lost on restart)',
    );
    await moduleRef.close();
  });

  it('checks the shape at once, naming what is missing', () => {
    const storage = new LocksStorage();
    expect(() => storage.registerSource({ acquire() {} } as never)).toThrow(
      "LocksStorage.registerSource(): an object doesn't implement LockStore: renew(), release() are missing.",
    );
    expect(() => storage.registerSource(AppLockStore as never)).toThrow(
      'LocksStorage.registerSource(): expected an object implementing LockStore, got the class AppLockStore (pass an instance).',
    );
    expect(() => storage.registerSource(null as never)).toThrow('got null');
  });

  it('refuses a second source, naming both, unless it replaces on purpose', () => {
    const storage = new LocksStorage();
    const first = new AppLockStore();
    storage.registerSource(first);
    expect(() => storage.registerSource(new InMemoryLockStore())).toThrow(
      "LocksStorage.registerSource(): InMemoryLockStore can't register, AppLockStore already did.",
    );
    expect(() => storage.registerSource(first)).toThrow('it already did (the same instance, twice)');
    const replacement = new InMemoryLockStore();
    storage.registerSource(replacement, { replace: true });
    expect(storage.source).toBe(replacement);
  });

  it('locks at the first read, and refuses a registration after it', () => {
    const storage = new LocksStorage();
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    expect(storage.source).toBeInstanceOf(InMemoryLockStore);
    log.mockRestore();
    expect(() => storage.registerSource(new AppLockStore())).toThrow(
      'LocksStorage.registerSource(): AppLockStore registered after LocksModule initialized (or after its storage was ' +
        'first read), which already uses InMemoryLockStore',
    );
  });

  it('locks at LocksModule.onModuleInit, so a provider registering later fails', async () => {
    @Injectable()
    class LateStore extends AppLockStore implements OnModuleInit {
      constructor(private readonly storage: LocksStorage) {
        super();
      }
      onModuleInit() {
        this.storage.registerSource(this);
      }
    }
    @Module({ imports: [LocksModule.forRoot()], providers: [LateStore] })
    class AppModule {}
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    moduleRef.useLogger(false);
    await expect(moduleRef.init()).rejects.toThrow('LateStore registered after LocksModule initialized');
  });

  it('is read at the first use when another module uses locks in its own onModuleInit', async () => {
    @Injectable()
    class Warmup implements OnModuleInit {
      constructor(private readonly locks: Locks) {}
      acquired?: boolean;
      async onModuleInit() {
        this.acquired = (await this.locks.acquire('warmup')) !== null;
      }
    }
    @Module({ providers: [Warmup] })
    class WarmupModule {}
    const moduleRef = await Test.createTestingModule({
      imports: [LocksModule.forRoot(), WarmupModule],
      providers: [{ provide: DB, useValue: {} }, RegisteringStore],
    }).compile();
    moduleRef.useLogger(false);
    await moduleRef.init();
    expect(moduleRef.get(Warmup).acquired).toBe(true);
    expect(moduleRef.get(LocksStorage).source).toBe(moduleRef.get(RegisteringStore));
    await moduleRef.close();
  });

  describe('in production', () => {
    beforeEach(() => vi.stubEnv('NODE_ENV', 'production'));

    it('refuses to start without a store, saying how to register one', async () => {
      await expect(boot()).rejects.toThrow(
        'LocksStorage: no LockStore is registered, and NODE_ENV is "production": in memory, a lock only excludes ' +
          'callers in this process, so every instance of the app would take the same lock and run the same job. ' +
          'Implement LockStore in a provider that injects LocksStorage and calls `storage.registerSource(this)`',
      );
    });

    it('starts with a registered store', async () => {
      const { moduleRef } = await boot([RegisteringStore]);
      await moduleRef.close();
    });

    it('starts in memory with allowInMemoryStorage', async () => {
      const { moduleRef } = await boot([], { allowInMemoryStorage: true });
      expect(moduleRef.get(LocksStorage).source).toBeInstanceOf(InMemoryLockStore);
      await moduleRef.close();
    });

    it('refuses an unregistered read outside the module too', () => {
      expect(() => new LocksStorage().source).toThrow('no LockStore is registered');
    });
  });
});
