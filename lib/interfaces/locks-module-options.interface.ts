import type { ConfigurableModuleAsyncOptions } from '@nestjs/common';
import type { Duration } from './duration.interface.js';
import type { LockClock } from './lock-clock.interface.js';

/** What `LocksModule.forRoot()` takes, and what a `forRootAsync()` factory returns. */
export interface LocksModuleOptions {
  /**
   * How long a lock lives without a renewal: how soon another instance can take it over
   * after its holder crashed. The holder renews it every `ttl / 3` while it holds it. The
   * default for `acquire()`, `withLock()`, `@OnOneInstance()`, `@WithoutOverlapping()` and
   * `@LeaderElection()`; each takes its own `ttl` too. Default `'30s'`.
   */
  ttl?: Duration;
  /** Default: the system clock. Pass a `ManualLockClock` in tests. */
  clock?: LockClock;
  /**
   * With `NODE_ENV=production` and no registered `LockStore`, startup fails: in memory, a
   * lock only excludes callers in this process. `true` accepts that (one instance).
   */
  allowInMemoryStorage?: boolean;
}

/** Structural options: the top level of `forRoot()` and `forRootAsync()`. */
export interface LocksModuleExtras {
  /** Default `true`. */
  isGlobal?: boolean;
}

export type LocksModuleForRootOptions = LocksModuleOptions & LocksModuleExtras;

/** What a class passed to `forRootAsync({ useClass })` implements. */
export interface LocksOptionsFactory {
  createLocksOptions(): LocksModuleOptions | Promise<LocksModuleOptions>;
}

export type LocksModuleAsyncOptions = ConfigurableModuleAsyncOptions<LocksModuleOptions, 'createLocksOptions'> &
  LocksModuleExtras;

