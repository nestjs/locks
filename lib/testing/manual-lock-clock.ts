import type { Duration } from '../interfaces/duration.interface.js';
import type { LockClock, LockTimerOptions } from '../interfaces/lock-clock.interface.js';
import { toMs } from '../utils/duration.util.js';

interface ManualTimer {
  id: number;
  due: number;
  callback: () => unknown;
}

/** How long, in real time, `advance()` waits for the promise a timer returned. */
const SETTLE_TIMEOUT = 1_000;

/**
 * A clock that only moves when told to, with timers that fire as it moves. For tests:
 * give each simulated instance its own (`LocksModule.forRoot({ clock })`) and the shared
 * `InMemoryLockStore` another, and a paused process is an instance whose clock you don't
 * advance while the store's moves past its lease.
 *
 * ```ts
 * const clock = new ManualLockClock();
 * // ...LocksModule.forRoot({ clock }), new InMemoryLockStore({ clock })
 * await clock.advance('31s'); // renewals and deadlines due by then run, in order
 * ```
 */
export class ManualLockClock implements LockClock {
  private current: number;
  private timers: ManualTimer[] = [];
  private nextId = 1;

  constructor(start: Date | number = Date.UTC(2026, 0, 1)) {
    this.current = start instanceof Date ? start.getTime() : start;
  }

  now(): number {
    return this.current;
  }

  /** `options.ref` is accepted and ignored: nothing runs on this clock's own. */
  setTimeout(callback: () => unknown, ms: number, _options?: LockTimerOptions): unknown {
    const id = this.nextId++;
    this.timers.push({ id, due: this.current + Math.max(0, ms), callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((timer) => timer.id !== handle);
  }

  /**
   * Moves the clock forward by `duration`, firing every timer that falls due on the way,
   * in order, each at its own time. After each timer it waits for the promise the timer
   * returned (a renewal reaching the store, for up to a second of real time) and lets
   * other pending promises settle, so the next timer sees its outcome. `advance(0)` fires
   * what is due now.
   */
  async advance(duration: Duration): Promise<void> {
    const target = this.current + toMs(duration);
    await settle();

    for (;;) {
      const next = this.timers
        .filter((timer) => timer.due <= target)
        .reduce<ManualTimer | undefined>((earliest, timer) => (!earliest || timer.due < earliest.due ? timer : earliest), undefined);
      if (!next) {
        break;
      }
      this.timers.splice(this.timers.indexOf(next), 1);
      this.current = Math.max(this.current, next.due);
      const result = next.callback();
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([
          (result as Promise<unknown>).then(undefined, () => undefined),
          new Promise<void>((resolve) => (timer = setTimeout(resolve, SETTLE_TIMEOUT))),
        ]);
        clearTimeout(timer);
      }
      await settle();
    }

    this.current = Math.max(this.current, target);
    await settle();
  }

  /** Timers waiting to fire, for assertions (a lock that stopped renewing has none). */
  get pendingTimers(): number {
    return this.timers.length;
  }
}

/** A few turns of the event loop: promise chains and in-process I/O callbacks run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
