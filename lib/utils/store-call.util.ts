import type { LockClock } from '../interfaces/lock-clock.interface.js';

export interface StoreCallOptions<T> {
  clock: LockClock;
  /** ms */
  timeout: number;
  /** What the call rejects with when `timeout` passes first. */
  timedOut(): Error;
  signal?: AbortSignal;
  /** The answer that came after the caller stopped waiting (a lock to give back). */
  late?(answer: T): void;
}

/**
 * The store's answer, or a rejection when `timeout` passes on `clock` first (`timedOut()`), or
 * `signal` aborts first (its reason): a store that answers late, or never (a saturated pool, a
 * failover, a client queueing commands offline), doesn't keep the caller waiting. An answer
 * that comes after that goes to `late`, and a failure after that is nobody's to handle.
 */
export function storeCall<T>(answer: Promise<T>, { clock, timeout, timedOut, signal, late }: StoreCallOptions<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const settle = () => {
      settled = true;
      clock.clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    };
    const stop = (reason: () => unknown) => {
      if (settled) {
        return;
      }
      settle();
      reject(reason());
      answer.then((value) => late?.(value)).catch(() => undefined);
    };
    const abort = () => stop(() => signal!.reason);
    const timer = clock.setTimeout(() => stop(timedOut), timeout);
    signal?.addEventListener('abort', abort, { once: true });

    answer.then(
      (value) => {
        if (!settled) {
          settle();
          resolve(value);
        }
      },
      (error: unknown) => {
        if (!settled) {
          settle();
          reject(error);
        }
      },
    );
  });
}
