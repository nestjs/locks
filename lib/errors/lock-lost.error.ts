import { LocksError } from './locks.error.js';

/**
 * The lock stopped being held while its holder was using it. It is the `reason` of the
 * lock's `signal`, so work that passes the signal on (`fetch`, a database driver,
 * `signal.throwIfAborted()`) stops with this error. `detectedBy` says how the holder found
 * out:
 * - `renewal`: the store refused a renewal. The lock expired there (the process paused or
 *   lost the store for longer than `ttl`), and another holder may have taken it.
 * - `deadline`: `ttl` passed since the last renewal the store confirmed (the store is down
 *   or slow, or the event loop was blocked), so another holder may take it any moment.
 */
export class LockLostError extends LocksError {
  override name = 'LockLostError';
  constructor(
    readonly key: string,
    readonly fencingToken: number,
    readonly detectedBy: 'renewal' | 'deadline',
    options?: { cause?: unknown },
  ) {
    super(
      detectedBy === 'renewal'
        ? `Lost the lock "${key}" (fencing token ${fencingToken}): it expired before it was renewed, and another holder may have it`
        : `Lost the lock "${key}" (fencing token ${fencingToken}): no renewal reached the store before it expired`,
      options,
    );
  }
}
