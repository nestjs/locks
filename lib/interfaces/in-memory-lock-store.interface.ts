/** A lock as `InMemoryLockStore#peek()` shows it. */
export interface InMemoryLock {
  owner: string;
  fencingToken: number;
  /** Epoch ms on the store's clock. */
  expiresAt: number;
}

export interface InMemoryLockStoreOptions {
  /**
   * The clock that decides expiry. Default: `Date.now()`. Share one `ManualLockClock` in
   * tests to expire locks by moving it.
   */
  clock?: { now(): number };
}
