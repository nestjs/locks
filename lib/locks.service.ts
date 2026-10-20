import { Inject, Injectable, Logger, Optional, type BeforeApplicationShutdown } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { LockClock } from './interfaces/lock-clock.interface.js';
import type { LockOptions } from './interfaces/lock-options.interface.js';
import type { LockStore } from './interfaces/lock-store.interface.js';
import type { LocksModuleOptions } from './interfaces/locks-module-options.interface.js';
import { Lock } from './lock/lock.js';
import { runInLockScope } from './context/locks.context.js';
import type { LockLostError } from './errors/lock-lost.error.js';
import { LockNotAcquiredError } from './errors/lock-not-acquired.error.js';
import { LockStoreTimeoutError } from './errors/lock-store-timeout.error.js';
import { LocksEvents } from './events/locks-events.service.js';
import { DEFAULT_STORE_TIMEOUT, DEFAULT_TTL, LOCKS_INTERNALS } from './locks.constants.js';
import { LOCKS_MODULE_OPTIONS } from './locks.module-definition.js';
import { LocksStorage, nameOf, storeOptionError } from './storage/locks.storage.js';
import { storeCall } from './utils/store-call.util.js';
import { systemClock } from './utils/system-clock.util.js';
import { durationMs, ttlMs } from './utils/ttl.util.js';

export interface LocksInternals {
  clock: LockClock;
  /** The module's `ttl`, in ms. */
  defaultTtl: number;
  /**
   * One attempt at `key`, with `onLost` called if the lock is lost later. It rejects with
   * `signal`'s reason when it aborts first (shutdown), and a lock granted after that goes back.
   */
  tryAcquire(
    key: string,
    ttl: number,
    options?: { onLost?: (lock: Lock, error: LockLostError) => void; signal?: AbortSignal },
  ): Promise<Lock | null>;
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
  private readonly storeTimeout: number;
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
    this.storeTimeout =
      options?.storeTimeout === undefined ? DEFAULT_STORE_TIMEOUT : ttlMs(options.storeTimeout, 'LocksModule: `storeTimeout`');
  }

  /**
   * Takes the lock on `key`, waiting up to `wait` for another holder to give it back.
   * Resolves the `Lock` (it renews itself until you release it), or `null` if another holder
   * kept it, or the store only granted it after `ttl` (the lease ran out on the way). Rejects
   * when the store fails or doesn't answer within `storeTimeout` (`LockStoreTimeoutError`), and
   * with `signal`'s reason when it aborts, also while the store has yet to answer (a lock it
   * grants after that goes back to it).
   */
  async acquire(key: string, options: LockOptions = {}): Promise<Lock | null> {
    const { ttl, wait } = this.resolve(key, options);
    const { signal } = options;
    signal?.throwIfAborted();
    const deadline = this.clock.now() + wait;
    let backoff = FIRST_BACKOFF;

    for (;;) {
      const lock = await this.attempt(key, ttl, { signal });
      if (lock) {
        if (signal?.aborted) {
          // Aborted between the store's answer and here: the caller has stopped waiting.
          void lock.release().catch(() => undefined);
          signal.throwIfAborted();
        }
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
      options.signal?.throwIfAborted();
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
      tryAcquire: (key, ttl, options) => this.attempt(key, ttl, options),
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

  /**
   * One call to the store's `acquire()`, with an owner of its own: a call `signal` gave up on
   * may still be granted later, and must then give back its own lock, never a later attempt's.
   */
  private async attempt(
    key: string,
    ttl: number,
    { onLost, signal }: { onLost?: (lock: Lock, error: LockLostError) => void; signal?: AbortSignal } = {},
  ): Promise<Lock | null> {
    signal?.throwIfAborted();
    const store = this.storage.source;
    const owner = randomUUID();
    const ask = <T>(method: keyof LockStore, answer: Promise<T>, late?: (answer: T) => void) =>
      this.ask(store, method, key, answer, { late });
    const giveBack = () => ask('release', store.release(key, owner)).catch(() => undefined);
    const sentAt = this.clock.now();
    const result = await this.ask(store, 'acquire', key, store.acquire(key, owner, ttl), {
      signal,
      late: (answer) => {
        if (answer?.acquired) {
          void giveBack();
        }
      },
    });
    if (!result?.acquired) {
      return null;
    }

    const { fencingToken } = result;

    if (!Number.isSafeInteger(fencingToken) || fencingToken < 1) {
      // A store bug that would silently break fencing: give the lock back, and say what to fix.
      await giveBack();
      throw new TypeError(
        `${nameOf(store)}.acquire() must resolve fencingToken as a positive safe integer, got ${JSON.stringify(fencingToken)} ` +
          `(${typeof fencingToken})${typeof fencingToken === 'string' ? ': PostgreSQL returns bigint columns as strings, convert it with Number()' : ''}`,
      );
    }

    // Granted after its ttl ran out here (a failover, a paused store, a saturated pool): this
    // process would count it lost at once, and its caller would run on a lease the store may
    // have handed on. Give it back, so the key isn't blocked for a ttl, and report it as taken.
    const elapsed = this.clock.now() - sentAt;
    if (elapsed >= ttl) {
      await giveBack();
      this.logger.warn(`The store granted the lock "${key}" ${elapsed}ms after acquire() was sent, past its ${ttl}ms ttl: gave it back.`);
      return null;
    }

    const lock = new Lock({
      key,
      owner,
      fencingToken,
      ttl,
      sentAt,
      store,
      ask,
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

  /** A call to `store`, bounded by `storeTimeout` (and `signal`, if any). */
  private ask<T>(
    store: LockStore,
    method: keyof LockStore,
    key: string,
    answer: Promise<T>,
    options: { signal?: AbortSignal; late?: (answer: T) => void } = {},
  ): Promise<T> {
    return storeCall(answer, {
      ...options,
      clock: this.clock,
      timeout: this.storeTimeout,
      timedOut: () => new LockStoreTimeoutError(key, method, this.storeTimeout, nameOf(store)),
    });
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
