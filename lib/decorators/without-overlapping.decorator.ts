import type { WithoutOverlappingOptions } from '../interfaces/job-options.interface.js';
import { decorateJob } from '../utils/job-decorator.util.js';

/**
 * Skips a call while a run of the method holds its lock (`key`), on this instance or any
 * other: a long run makes the next ticks skip instead of piling up. The lock is renewed
 * while the run lasts and released when it ends. Inside the method, `LocksContext` has the
 * run's fencing token (a new, higher one per run) and a signal that aborts if the lock is
 * lost.
 *
 * ```ts
 * @Cron(CronExpression.EVERY_5_MINUTES)
 * @OnOneInstance()
 * @WithoutOverlapping()
 * async reconcileStock() {}
 * ```
 */
export function WithoutOverlapping(options: WithoutOverlappingOptions = {}): MethodDecorator {
  return decorateJob('withoutOverlapping', '@WithoutOverlapping()', options);
}
