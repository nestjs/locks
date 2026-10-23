import type { Duration } from './duration.interface.js';

/** `acquire()` and `withLock()` options. */
export interface LockOptions {
  /**
   * How long the lock lives without a renewal: how soon another caller can take it after
   * this process crashed. While held, it renews itself every `ttl / 3`. Default: the
   * module's `ttl` (`'30s'`).
   */
  ttl?: Duration;
  /**
   * How long to wait for a lock another holder has, trying again with backoff (and at once
   * when a holder in this process releases it). Default `0`: try once. A store call already
   * sent is answered past `wait`: `wait` bounds the waiting for another holder, and the
   * module's `storeTimeout` bounds the store. The waiting stops when the application shuts
   * down: `acquire()` then resolves `null`, without calling the store again.
   */
  wait?: Duration;
  /**
   * Stops waiting, also for a store call in flight: `acquire()` rejects with the signal's
   * reason (and a lock the store grants after that goes back to it), and `withLock()` doesn't
   * run its callback. Not needed for the application's own shutdown: from
   * `beforeApplicationShutdown()` on, `acquire()` resolves `null` without a store call, and a
   * grant that lands after that goes back too.
   */
  signal?: AbortSignal;
}
