import { Module, type DynamicModule, type OnModuleInit } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { LeaderElections } from './services/leader-elections.service.js';
import { LockKeys } from './services/lock-keys.service.js';
import { LocksContext } from './context/locks.context.js';
import { LocksEvents } from './events/locks-events.service.js';
import { ConfigurableModuleClass, type ASYNC_OPTIONS_TYPE, type OPTIONS_TYPE } from './locks.module-definition.js';
import type { LocksModuleAsyncOptions, LocksModuleForRootOptions } from './interfaces/locks-module-options.interface.js';
import { Locks } from './locks.service.js';
import { LOCK_STORAGE } from './locks.constants.js';
import { LocksStorage, storeOptionError } from './storage/locks.storage.js';
import { ScheduledJobs } from './services/scheduled-jobs.service.js';

/**
 * `LocksModule.forRoot({ ttl, clock, allowInMemoryStorage })`, or `forRootAsync({ imports,
 * inject, useFactory | useClass | useExisting })`, where the factory returns the options.
 * Global by default.
 *
 * Provides `Locks` (acquire, withLock), `LocksContext`, `LocksEvents` and `LocksStorage`,
 * where the app's store registers itself (without one, locks live in memory). It also runs
 * the application's `@OnOneInstance()` and `@WithoutOverlapping()` jobs, and its
 * `@LeaderElection()` providers.
 */
@Module({
  imports: [DiscoveryModule],
  providers: [LocksStorage, LocksEvents, Locks, LocksContext, LockKeys, ScheduledJobs, LeaderElections],
  exports: [LocksStorage, LocksEvents, Locks, LocksContext],
})
export class LocksModule extends ConfigurableModuleClass implements OnModuleInit {
  constructor(private readonly storage: LocksStorage) {
    super();
  }

  static forRoot(options: LocksModuleForRootOptions = {}): DynamicModule {
    if (options && 'store' in options) {
      throw storeOptionError();
    }
    return super.forRoot(options as typeof OPTIONS_TYPE);
  }

  /** Options from `useFactory` (with `inject`), or from a class that implements `LocksOptionsFactory`. */
  static forRootAsync(options: LocksModuleAsyncOptions): DynamicModule {
    if (options && 'store' in options) {
      throw storeOptionError();
    }
    return super.forRootAsync(options as typeof ASYNC_OPTIONS_TYPE);
  }

  /**
   * Every provider constructor has run (so the store provider has registered), and no
   * scheduled job has run yet (`@nestjs/schedule` starts its timers in
   * `onApplicationBootstrap`): the registry locks here, if a read in another module's
   * `onModuleInit` hasn't locked it already.
   */
  onModuleInit() {
    this.storage[LOCK_STORAGE]();
  }
}
