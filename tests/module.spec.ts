import { Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ManualLockClock } from '../lib/testing/manual-lock-clock.js';
import { systemClock } from '../lib/utils/system-clock.util.js';
import { LocksContext } from '../lib/context/locks.context.js';
import { LocksEvents } from '../lib/events/locks-events.service.js';
import { LocksModule } from '../lib/locks.module.js';
import { LOCKS_MODULE_OPTIONS } from '../lib/locks.module-definition.js';
import type { LocksModuleOptions, LocksOptionsFactory } from '../lib/interfaces/locks-module-options.interface.js';
import { LOCKS_INTERNALS } from '../lib/locks.constants.js';
import { Locks } from '../lib/locks.service.js';
import { LocksStorage } from '../lib/storage/locks.storage.js';

async function compile(imports: unknown[], providers: unknown[] = []) {
  const moduleRef = await Test.createTestingModule({ imports: imports as never[], providers: providers as never[] }).compile();
  moduleRef.useLogger(false);
  await moduleRef.init();
  return moduleRef;
}

describe('LocksModule', () => {
  it('works with no options: a 30s ttl, the system clock, global', async () => {
    @Injectable()
    class Consumer {
      constructor(
        readonly locks: Locks,
        readonly context: LocksContext,
        readonly events: LocksEvents,
        readonly storage: LocksStorage,
      ) {}
    }
    @Module({ providers: [Consumer] })
    class FeatureModule {}
    const moduleRef = await compile([LocksModule.forRoot(), FeatureModule]);
    const internals = moduleRef.get(Locks)[LOCKS_INTERNALS];
    expect(internals.defaultTtl).toBe(30_000);
    expect(internals.clock).toBe(systemClock);
    expect(moduleRef.get(Consumer).locks).toBe(moduleRef.get(Locks));
    await moduleRef.close();
  });

  it('takes its options from forRootAsync({ useFactory }) and forRootAsync({ useClass })', async () => {
    const clock = new ManualLockClock();
    const fromFactory = await compile([
      LocksModule.forRootAsync({ useFactory: async () => ({ ttl: '1m', clock }) }),
    ]);
    expect(fromFactory.get(Locks)[LOCKS_INTERNALS]).toMatchObject({ defaultTtl: 60_000, clock });
    await fromFactory.close();

    @Injectable()
    class LocksConfig implements LocksOptionsFactory {
      createLocksOptions(): LocksModuleOptions {
        return { ttl: 5_000 };
      }
    }
    const fromClass = await compile([LocksModule.forRootAsync({ useClass: LocksConfig })]);
    expect(fromClass.get(Locks)[LOCKS_INTERNALS].defaultTtl).toBe(5_000);
    expect(fromClass.get(LOCKS_MODULE_OPTIONS)).toEqual({ ttl: 5_000 });
    await fromClass.close();
  });

  it('fails at startup on an invalid option, naming it', async () => {
    await expect(compile([LocksModule.forRoot({ ttl: '30 seconds' as never })])).rejects.toThrow(
      'LocksModule: `ttl`: Invalid duration "30 seconds"',
    );
    await expect(compile([LocksModule.forRoot({ ttl: 0 })])).rejects.toThrow('LocksModule: `ttl` must be at least 1ms');
    await expect(compile([LocksModule.forRoot({ clock: { now: () => 0 } as never })])).rejects.toThrow(
      'LocksModule: `clock` must implement LockClock (now, setTimeout, clearTimeout), got an object',
    );
  });

  it('refuses a `store` option, pointing to LocksStorage, wherever it is set', async () => {
    const message = 'LocksModule: `store` is not an option. Implement LockStore in a provider that injects LocksStorage';
    expect(() => LocksModule.forRoot({ store: {} } as never)).toThrow(message);
    await expect(compile([LocksModule.forRootAsync({ useFactory: () => ({ store: {} }) as never })])).rejects.toThrow(message);
  });

  it('is not global with isGlobal: false', async () => {
    @Injectable()
    class Consumer {
      constructor(readonly locks: Locks) {}
    }
    @Module({ providers: [Consumer] })
    class FeatureModule {}
    await expect(compile([LocksModule.forRoot({ isGlobal: false }), FeatureModule])).rejects.toThrow(/can't resolve dependencies/);
  });
});
