import { LocksError } from './locks.error.js';

/**
 * `withLock()` couldn't take the lock within `wait`: another holder kept it (`'taken'`), or the
 * application is shutting down and grants no new locks (`'shutdown'`).
 */
export class LockNotAcquiredError extends LocksError {
  override name = 'LockNotAcquiredError';
  constructor(
    readonly key: string,
    /** How long it waited, in ms (0: it tried once). */
    readonly waitMs: number,
    readonly reason: 'taken' | 'shutdown' = 'taken',
  ) {
    super(
      reason === 'shutdown'
        ? `Could not acquire the lock "${key}": the application is shutting down`
        : waitMs > 0
          ? `Could not acquire the lock "${key}" within ${waitMs}ms: another holder has it`
          : `Could not acquire the lock "${key}": another holder has it`,
    );
  }
}
