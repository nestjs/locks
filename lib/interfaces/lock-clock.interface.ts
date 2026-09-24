/**
 * Where the package reads the time and sets its timers: lease deadlines, renewals every
 * `ttl / 3`, `wait` polling, and the in-memory store's expiry. The default is the system
 * clock; tests pass a `ManualLockClock` to move time by hand.
 */
export interface LockClock {
  /** Epoch milliseconds. */
  now(): number;
  /**
   * Calls `callback` once, `ms` from now on this clock. A callback may return a promise (a
   * renewal in flight): `ManualLockClock` waits for it before it fires the next timer.
   * `options.ref` asks the timer to keep the process alive until it fires: set for a wait
   * the caller awaits (`acquire()`'s `wait`), not for renewals and deadlines, which must
   * never keep a process up on their own.
   */
  setTimeout(callback: () => unknown, ms: number, options?: LockTimerOptions): unknown;
  clearTimeout(handle: unknown): void;
}

export interface LockTimerOptions {
  /** Keep the process alive until the timer fires. Default `false`. */
  ref?: boolean;
}
