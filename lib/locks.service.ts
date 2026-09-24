import { Inject, Injectable, Logger, Optional, type BeforeApplicationShutdown } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { LockClock } from './interfaces/lock-clock.interface.js';
import type { LockOptions } from './interfaces/lock-options.interface.js';
import type { LocksModuleOptions } from './interfaces/locks-module-options.interface.js';
import { Lock } from './lock/lock.js';
import { runInLockScope } from './context/locks.context.js';
import type { LockLostError } from './errors/lock-lost.error.js';
import { LockNotAcquiredError } from './errors/lock-not-acquired.error.js';
import { LocksEvents } from './events/locks-events.service.js';
import { DEFAULT_TTL, LOCKS_INTERNALS } from './locks.constants.js';
import { LOCKS_MODULE_OPTIONS } from './locks.module-definition.js';
import { LocksStorage, nameOf, storeOptionError } from './storage/locks.storage.js';
import { systemClock } from './utils/system-clock.util.js';
import { durationMs, ttlMs } from './utils/ttl.util.js';

export interface LocksInternals {
  clock: LockClock;
  /** The module's `ttl`, in ms. */
  defaultTtl: number;
  /** One attempt at `key`, with `onLost` called if the lock is lost later. */
  tryAcquire(key: string, ttl: number, onLost?: (lock: Lock, error: LockLostError) => void): Promise<Lock | null>;
}

const FIRST_BACKOFF = 50;
const MAX_BACKOFF = 1_000;

/**
 * Distributed locks on the registered `LockStore`:
 *
 * ```ts
 * const lock = await locks.acquire('invoices:export', { ttl: '30s', wait: '5s' });
 * if (!lock) return; // another instance has it
 * try {
 *   await this.export({ signal: lock.signal, fencingToken: lock.fencingToken });
 * } finally {
 *   await lock.release();
 * }
 *
 * await locks.withLock('invoices:export', (lock) => this.export(lock)); // throws LockNotAcquiredError if taken
 * ```
 */
@Injectable()
export class Locks implements BeforeApplicationShutdown {
  private readonly logger = new Logger('Locks');
  private readonly clock: LockClock;
  private readonly defaultTtl: number;
  private readonly held = new Set<Lock>();
  private readonly waiters = new Map<string, Set<() => void>>();

  constructor(
    private readonly storage: LocksStorage,
    private readonly events: LocksEvents,
    @Optional() @Inject(LOCKS_MODULE_OPTIONS) options?: LocksModuleOptions,
  ) {
    // What a forRootAsync() factory returned is only seen here.
    if (options && 'store' in options) {
      throw storeOptionError();
    }

    this.clock = options?.clock ?? systemClock;
    if (typeof this.clock?.now !== 'function' || typeof this.clock.setTimeout !== 'function' || typeof this.clock.clearTimeout !== 'function') {
      throw new TypeError(`LocksModule: \`clock\` must implement LockClock (now, setTimeout, clearTimeout), got ${nameOf(this.clock)}`);
    }

    this.defaultTtl = options?.ttl === undefined ? DEFAULT_TTL : ttlMs(options.ttl, 'LocksModule: `ttl`');
  }

  /**
   * Takes the lock on `key`, waiting up to `wait` for another holder to give it back.
   * Resolves the `Lock` (it renews itself until you release it), or `null` if another holder
   * kept it. Rejects when the store fails, and with `signal`'s reason when it aborts.
   */
  async acquire(key: string, options: LockOptions = {}): Promise<Lock | null> {
    const { ttl, wait } = this.resolve(key, options);
    const { signal } = options;
    signal?.throwIfAborted();
    const owner = randomUUID();
    const deadline = this.clock.now() + wait;
    let backoff = FIRST_BACKOFF;

    for (;;) {
      const lock = await this.attempt(key, owner, ttl);
      if (lock) {
        return lock;
      }
      const remaining = deadline - this.clock.now();
      if (remaining <= 0) {
        return null;
      }
      signal?.throwIfAborted();
      // Equal jitter: instances waiting for one key don't retry in lockstep.
      await this.sleep(key, Math.min(remaining, backoff / 2 + (Math.random() * backoff) / 2), signal);
      backoff = Math.min(backoff * 2, MAX_BACKOFF);
    }
  }

  /**
   * Runs `fn` under the lock on `key`, then releases it, whether `fn` resolves or throws.
   * Rejects with `LockNotAcquiredError` if another holder kept the lock for `wait` (default:
   * don't wait). Inside `fn`, `LocksContext` has the lock too. If the lock is lost while `fn`
   * runs, `lock.signal` aborts with a `LockLostError`; `fn` decides whether to stop.
   */
  async withLock<T>(key: string, fn: (lock: Lock) => T | Promise<T>, options: LockOptions = {}): Promise<T> {
    const { wait } = this.resolve(key, options);
    const lock = await this.acquire(key, options);
    if (!lock) {
      throw new LockNotAcquiredError(key, wait);
    }

    try {
      return await runInLockScope({ lock, signal: lock.signal }, () => fn(lock));
    } finally {
      // The work is done, or failed: a release that fails only means the lock expires
      // after ttl, which isn't the caller's error.
      await lock.release().catch((error: unknown) => {
        this.logger.error(`Could not release the lock "${key}"`, (error as Error)?.stack ?? String(error));
      });
    }
  }

  /** @internal */
  get [LOCKS_INTERNALS](): LocksInternals {
    return {
      clock: this.clock,
      defaultTtl: this.defaultTtl,
      tryAcquire: (key, ttl, onLost) => this.attempt(key, randomUUID(), ttl, onLost),
    };
  }

  /**
   * Locks still held when the application shuts down are released, and their signals
   * abort. In `beforeApplicationShutdown`: after every module's `onModuleDestroy` (where
   * jobs finish and elections step down), and before any `onApplicationShutdown`, where
   * the app closes the store's connection. Nest runs each phase for the whole application,
   * and inside a phase a module imported before `LocksModule` runs first, so a release in
   * `onApplicationShutdown` could find the pool already ended.
   */
  async beforeApplicationShutdown() {
    await Promise.all(
      [...this.held].map((lock) =>
        lock.release().catch((error: unknown) => {
          this.logger.error(`Could not release the lock "${lock.key}" at shutdown`, (error as Error)?.stack ?? String(error));
        }),
      ),
    );
  }

  private async attempt(
    key: string,
    owner: string,
    ttl: number,
    onLost?: (lock: Lock, error: LockLostError) => void,
  ): Promise<Lock | null> {
    const store = this.storage.source;
    const sentAt = this.clock.now();
    const result = await store.acquire(key, owner, ttl);
    if (!result?.acquired) {
      return null;
    }

    const { fencingToken } = result;

    if (!Number.isSafeInteger(fencingToken) || fencingToken < 1) {
      // A store bug that would silently break fencing: give the lock back, and say what to fix.
      await store.release(key, owner).catch(() => undefined);
      throw new TypeError(
        `${nameOf(store)}.acquire() must resolve fencingToken as a positive safe integer, got ${JSON.stringify(fencingToken)} ` +
          `(${typeof fencingToken})${typeof fencingToken === 'string' ? ': PostgreSQL returns bigint columns as strings, convert it with Number()' : ''}`,
      );
    }

    const lock = new Lock({
      key,
      owner,
      fencingToken,
      ttl,
      sentAt,
      store,
      clock: this.clock,
      onLost: (lost, error) => {
        this.logger.warn(`${error.message}. Stop writing on its behalf, and fence what it guards with its token.`);
        this.events.emit({ type: 'lock-lost', key, fencingToken, detectedBy: error.detectedBy });
        onLost?.(lost, error);
      },
      onEnd: (ended) => {
        this.held.delete(ended);
        for (const wake of this.waiters.get(key) ?? []) {
          wake();
        }
      },
    });
    this.held.add(lock);

    return lock;
  }

  private resolve(key: string, options: LockOptions): { ttl: number; wait: number } {
    if (typeof key !== 'string' || key.length === 0) {
      throw new TypeError(`Locks: the lock key must be a non-empty string, got ${JSON.stringify(key)}`);
    }
    return {
      ttl: options.ttl === undefined ? this.defaultTtl : ttlMs(options.ttl, `Locks: \`ttl\` of "${key}"`),
      wait: options.wait === undefined ? 0 : durationMs(options.wait, `Locks: \`wait\` of "${key}"`),
    };
  }

  /**
   * Waits `ms`, or until a holder in this process releases `key`, or `signal` aborts. The
   * caller awaits this, so its timer keeps the process alive (a renewal's never does): a
   * command that waits for a lock with nothing else on its event loop must not exit.
   */
  private sleep(key: string, ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let waiters = this.waiters.get(key);
      if (!waiters) {
        this.waiters.set(key, (waiters = new Set()));
      }
      const cleanup = () => {
        this.clock.clearTimeout(timer);
        waiters.delete(wake);
        if (waiters.size === 0 && this.waiters.get(key) === waiters) {
          this.waiters.delete(key);
        }
        signal?.removeEventListener('abort', abort);
      };
      const wake = () => {
        cleanup();
        resolve();
      };
      const abort = () => {
        cleanup();
        reject(signal!.reason);
      };
      const timer = this.clock.setTimeout(wake, ms, { ref: true });
      waiters.add(wake);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }
}
