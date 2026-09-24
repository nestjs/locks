/** What `LockStore#acquire()` resolves: the lock and its fencing token, or nothing. */
export type LockAcquireResult = { acquired: true; fencingToken: number } | { acquired: false };

/**
 * Where locks live: the contract a store implements. The package owns the rules (below);
 * the store owns data access. Write it as an ordinary provider that injects whatever it
 * needs (a Drizzle database, a Redis client) and registers itself with `LocksStorage` in its
 * constructor:
 *
 * ```ts
 * @Injectable()
 * export class DrizzleLockStore implements LockStore {
 *   constructor(@InjectDrizzle() private readonly db: Database, storage: LocksStorage) {
 *     storage.registerSource(this);
 *   }
 * }
 * ```
 *
 * A lock is a record for a key with an `owner` (a random string per acquisition, never
 * reused), a `fencingToken`, and an expiry `ttl` milliseconds after it was taken or last
 * renewed. An expired lock doesn't exist, for every method, whether or not it has been
 * deleted yet. **The store measures `ttl` with its own clock** (Redis `PEXPIRE`, the
 * database's `clock_timestamp()`, `Date.now()` in memory): every instance then agrees on when
 * a lock expires, whatever their own clocks say. The holder renews the lock every `ttl / 3`,
 * one call at a time, so a lock only expires when its process stops renewing it (crash,
 * partition, a blocked event loop).
 *
 * **Fencing tokens** are integers that grow with every acquisition of a key: each
 * `acquire()` that succeeds returns a token greater than every token the store returned for
 * that key before, across releases and expiries, for as long as the store lives. The holder
 * hands it to the resources it writes, which reject a token lower than one they have seen
 * (a holder that paused past its lease and woke up after another took over). A store-wide
 * counter (a Redis `INCR` key, a PostgreSQL sequence) is the simple way; it must never go
 * back, so a Redis store needs persistence. Tokens are safe integers (up to 2^53 - 1).
 *
 * Calls for different keys, and for the same key, arrive concurrently, from one process or
 * many. `acquire()` must let exactly one of any number of concurrent callers win a free or
 * expired key; `renew()` and `release()` are a single compare-and-set on `owner` (write only
 * if `owner` still holds a live lock). Durations are whole milliseconds, at least 1, and up
 * to weeks (30 days is 2,592,000,000, past a 32-bit integer). Keys are arbitrary strings
 * (any Unicode, up to 500 characters) and must be kept apart exactly (`k` and `K` are two
 * locks). Test a store with the contract suite from `@nestjs/locks/testing`.
 */
export interface LockStore {
  /**
   * Takes `key` for `owner`, expiring `ttl` ms from now, if no live lock holds it (none, a
   * released one, or an expired one), and resolves `{ acquired: true, fencingToken }` with a
   * token greater than every token returned for `key` before. Otherwise it changes nothing
   * and resolves `{ acquired: false }`, also when `owner` itself holds the lock (a lock is
   * taken once).
   *
   * **Atomic.** Two concurrent calls for the same free (or expired) key must never both
   * acquire it: a read followed by a separate write lets both callers into the critical
   * section. Use one atomic operation (`SET NX PX` in a Lua script, `INSERT ... ON CONFLICT
   * DO UPDATE ... WHERE expired`), and take over an expired lock with a write that re-checks
   * the expiry, so that of many concurrent callers only one takes it. Draw the token in the
   * same operation, after the check.
   */
  acquire(key: string, owner: string, ttl: number): Promise<LockAcquireResult>;

  /**
   * Heartbeat: sets `owner`'s live lock on `key` to expire `ttl` ms from now. Resolves
   * `true` when it did, and `false`, changing nothing, when `owner` doesn't hold a live lock
   * on `key`: it expired (and may have been taken over), or it was released.
   *
   * **A compare-and-set:** the owner and expiry check and the write are one operation. A
   * renewal that read first could revive a lock that expired in between, or extend the new
   * owner's lock after the new owner crashed.
   */
  renew(key: string, owner: string, ttl: number): Promise<boolean>;

  /**
   * Frees `owner`'s live lock on `key` (deletes it, or marks it released), so another
   * caller can take it at once. Resolves `true` when it did, `false` (changing nothing) when
   * `owner` doesn't hold a live lock on `key`. It must not reset the key's fencing counter.
   *
   * **A compare-and-set**, like `renew()`: a stale owner must not delete the lock of the
   * caller that took over.
   */
  release(key: string, owner: string): Promise<boolean>;
}
