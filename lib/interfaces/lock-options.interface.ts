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
   * sent is answered past `wait`: `wait` bounds the waiting for another holder, not the store.
   */
  wait?: Duration;
  /**
   * Stops waiting, also for a store call in flight: `acquire()` rejects with the signal's
   * reason (and a lock the store grants after that goes back to it), and `withLock()` doesn't
   * run its callback.
   */
  signal?: AbortSignal;
}
