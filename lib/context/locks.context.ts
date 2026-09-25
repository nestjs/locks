import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Lock } from '../lock/lock.js';

interface LockScope {
  lock: Lock;
  /** The lock's signal, or one that also aborts with the job's ownership lease. */
  signal: AbortSignal;
}

const scopes = new AsyncLocalStorage<LockScope>();

/** @internal Runs `fn` inside a lock scope. */
export function runInLockScope<T>(scope: LockScope, fn: () => T): T {
  return scopes.run(scope, fn);
}

/**
 * The lock the calling code runs under: a `@OnOneInstance()` or `@WithoutOverlapping()`
 * job's, a `withLock()` callback's, or one set with `run()`. Backed by
 * `AsyncLocalStorage`, so it reaches every service the job calls. A scheduled job gets its
 * fencing token and signal here, because `@nestjs/schedule` calls it without arguments.
 *
 * ```ts
 * @Cron(CronExpression.EVERY_5_MINUTES)
 * @OnOneInstance()
 * @WithoutOverlapping()
 * async reconcile() {
 *   const counts = await this.warehouse.stockCounts({ signal: this.locksContext.signal });
 *   await this.stockRepository.writeStock(counts, this.locksContext.fencingToken!);
 * }
 * ```
 */
@Injectable()
export class LocksContext {
  /** The lock. `undefined` outside a locked section. */
  get lock(): Lock | undefined {
    return scopes.getStore()?.lock;
  }

  /** The lock's fencing token. `undefined` outside a locked section. */
  get fencingToken(): number | undefined {
    return scopes.getStore()?.lock.fencingToken;
  }

  /**
   * Aborts when the section should stop: its lock was lost or released, or, for a
   * `@OnOneInstance()` job, this instance stopped owning the job. `undefined` outside a
   * locked section.
   */
  get signal(): AbortSignal | undefined {
    return scopes.getStore()?.signal;
  }

  /** Runs `fn` under `lock` (code that acquired a lock itself, a test). */
  run<T>(lock: Lock, fn: () => T): T {
    return scopes.run({ lock, signal: lock.signal }, fn);
  }
}
