// Module and options
export { LocksModule } from './locks.module.js';
export { LOCKS_MODULE_OPTIONS } from './locks.module-definition.js';
export type { Duration, LocksModuleAsyncOptions, LocksModuleOptions, LocksOptionsFactory } from './interfaces/index.js';

// Locks in your code: acquire(), withLock(), the lock they hand you, and the lock a job runs under
export { Locks } from './locks.service.js';
export type { LockOptions } from './interfaces/index.js';
export { Lock } from './lock/index.js';
export { LocksContext } from './context/index.js';

// Decorators: scheduled jobs (@nestjs/schedule's @Cron(), @Interval(), @Timeout()) on one
// instance and without overlap, and leader election
export * from './decorators/index.js';
export type {
  LeaderElectionOptions,
  OnLeadershipAcquired,
  OnLeadershipLost,
  OnOneInstanceOptions,
  WithoutOverlappingOptions,
} from './interfaces/index.js';

// Errors
export * from './errors/index.js';

// Events: `LocksEvents.events$`, and `nestjs:locks:*` diagnostics channels
export * from './events/index.js';

// Storage: implement `LockStore` in a provider and register it with `LocksStorage`; the
// in-memory store is the default and the test double. The contract suite is in
// `@nestjs/locks/testing`.
export type {
  InMemoryLock,
  InMemoryLockStoreOptions,
  LockAcquireResult,
  LockStore,
  LocksStorageRegisterOptions,
} from './interfaces/index.js';
export { LocksStorage } from './storage/index.js';
export { InMemoryLockStore } from './stores/index.js';

// Testing: a clock that only moves when told to
export type { LockClock, LockTimerOptions } from './interfaces/index.js';
export { ManualLockClock } from './testing/manual-lock-clock.js';
