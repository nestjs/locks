import type { LockClock } from '../interfaces/lock-clock.interface.js';

/** The largest delay `setTimeout` takes; a longer one fires at once. */
const MAX_TIMEOUT = 2 ** 31 - 1;

/**
 * `Date.now()` and Node's timers. Timers are `unref()`'d unless asked otherwise, so a
 * renewal never keeps the process alive, and capped at the largest delay Node takes
 * (callers re-check their deadline when a timer fires, so an early one is harmless).
 */
export const systemClock: LockClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms, options) => {
    const timer = setTimeout(callback, Math.min(Math.max(0, ms), MAX_TIMEOUT));
    if (!options?.ref) {
      timer.unref();
    }
    return timer;
  },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};
