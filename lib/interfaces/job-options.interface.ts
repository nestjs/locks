import type { Duration } from './duration.interface.js';

export interface OnOneInstanceOptions {
  /**
   * The job's lock key, shared with `@WithoutOverlapping()` on the same method (set it on
   * either). Default: `ClassName.methodName`. Set it for jobs that must never run twice: a
   * renamed class or method (or a minifier) changes the default, and during a rolling deploy
   * old and new instances would then each run the job once.
   */
  key?: string;
  /**
   * How long the instance that runs the job keeps it without renewing: after a crash,
   * another instance takes the job over at its first tick after `ttl`. Default: the module's
   * `ttl` (`'30s'`).
   */
  ttl?: Duration;
}

export interface WithoutOverlappingOptions {
  /**
   * The key of the lock a run holds, shared with `@OnOneInstance()` (set it on either).
   * Default: `ClassName.methodName`. Code that must not run alongside the job takes the same
   * lock: `locks.withLock(key, ...)`.
   */
  key?: string;
  /** How long a run's lock lives without a renewal (a crashed run). Default: the module's `ttl`. */
  ttl?: Duration;
}
