import type { OnOneInstanceOptions } from '../interfaces/job-options.interface.js';
import { decorateJob } from '../utils/job-decorator.util.js';

/**
 * Runs the method on one instance of the application at a time: the first instance to
 * call it takes the job's lease (`<key>:owner`), keeps renewing it while it is up, and runs
 * every call; on the other instances a call is skipped (it resolves `undefined`), never
 * queued. After the owner crashes, the first instance whose call comes `ttl` later takes
 * over. For `@Cron()`, `@Interval()` and `@Timeout()` jobs, in either decorator order:
 *
 * ```ts
 * @Cron('0 2 * * *', { timeZone: 'Europe/Warsaw' })
 * @OnOneInstance({ key: 'invoices:nightly-export' })
 * async exportInvoices() {}
 * ```
 *
 * It doesn't stop a run from overlapping the previous one on the owner (a plain `@Cron()`
 * doesn't either): add `@WithoutOverlapping()`. Inside the method, `LocksContext` has the
 * lease's fencing token and a signal that aborts if this instance loses the job.
 */
export function OnOneInstance(options: OnOneInstanceOptions = {}): MethodDecorator {
  return decorateJob('oneInstance', '@OnOneInstance()', options);
}
