/**
 * Base class of the errors this package raises: `LockNotAcquiredError` from `withLock()`,
 * `LockLostError`, the reason a lock's `signal` aborts with when the lock is lost, and
 * `LockStoreTimeoutError`, when the store doesn't answer within `storeTimeout`. None carries a
 * 4xx `status`: contention, lost leases and a slow store are not the caller's mistake, and a
 * retry may succeed.
 */
export abstract class LocksError extends Error {}
