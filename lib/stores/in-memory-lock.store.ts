import type { InMemoryLock, InMemoryLockStoreOptions } from '../interfaces/in-memory-lock-store.interface.js';
import type { LockAcquireResult, LockStore } from '../interfaces/lock-store.interface.js';

const SWEEP_EVERY = 1_000;

/**
 * Single-process store: the default when no store is registered, and the test double.
 * Every method checks and writes synchronously (no `await` in between), so concurrent
 * callers in this process can never both acquire a key. Its fencing counter is store-wide,
 * so tokens grow across every key.
 *
 * Locks here exclude callers in this process only: two instances of an app each have their
 * own, and both take "the" lock. That is correct for one instance, and the production guard
 * refuses it unless `allowInMemoryStorage` is set. In tests, several applications in one
 * process can share one instance (register it in each with `registerSource()`) to act as
 * instances of one app.
 */
export class InMemoryLockStore implements LockStore {
  private readonly locks = new Map<string, InMemoryLock>();
  private readonly clock: { now(): number };
  private counter = 0;
  private operations = 0;

  constructor(options: InMemoryLockStoreOptions = {}) {
    this.clock = options.clock ?? { now: () => Date.now() };
  }

  async acquire(key: string, owner: string, ttl: number): Promise<LockAcquireResult> {
    this.maybeSweep();
    if (this.live(key)) {
      return { acquired: false };
    }
    const fencingToken = ++this.counter;
    this.locks.set(key, { owner, fencingToken, expiresAt: this.clock.now() + ttl });
    return { acquired: true, fencingToken };
  }

  async renew(key: string, owner: string, ttl: number): Promise<boolean> {
    const lock = this.live(key);
    if (lock?.owner !== owner) {
      return false;
    }
    lock.expiresAt = this.clock.now() + ttl;
    return true;
  }

  async release(key: string, owner: string): Promise<boolean> {
    const lock = this.live(key);
    if (lock?.owner !== owner) {
      return false;
    }
    this.locks.delete(key);
    return true;
  }

  /** The live lock on `key`, as a copy, for assertions; `undefined` when it is free. */
  peek(key: string): InMemoryLock | undefined {
    const lock = this.live(key);
    return lock && { ...lock };
  }

  private live(key: string): InMemoryLock | undefined {
    const lock = this.locks.get(key);
    if (lock && lock.expiresAt <= this.clock.now()) {
      this.locks.delete(key);
      return undefined;
    }
    return lock;
  }

  private maybeSweep() {
    if (++this.operations % SWEEP_EVERY !== 0) {
      return;
    }

    const now = this.clock.now();

    for (const [key, lock] of this.locks) {
      if (lock.expiresAt <= now) {
        this.locks.delete(key);
      }
    }
  }
}
