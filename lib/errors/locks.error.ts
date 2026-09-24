/**
 * Base class of the errors this package raises: `LockNotAcquiredError` from `withLock()`,
 * and `LockLostError`, the reason a lock's `signal` aborts with when the lock is lost.
 * Neither carries a 4xx `status`: contention and lost leases are not the caller's mistake,
 * and a retry may succeed.
 */
export abstract class LocksError extends Error {}
