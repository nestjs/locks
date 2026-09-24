import { LocksError } from './locks.error.js';

/** `withLock()` couldn't take the lock within `wait` (another holder kept it). */
export class LockNotAcquiredError extends LocksError {
  override name = 'LockNotAcquiredError';
  constructor(
    readonly key: string,
    /** How long it waited, in ms (0: it tried once). */
    readonly waitMs: number,
  ) {
    super(
      waitMs > 0
        ? `Could not acquire the lock "${key}" within ${waitMs}ms: another holder has it`
        : `Could not acquire the lock "${key}": another holder has it`,
    );
  }
}
