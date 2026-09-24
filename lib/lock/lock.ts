import { Logger } from '@nestjs/common';
import { LockLostError } from '../errors/lock-lost.error.js';
import type { LockClock } from '../interfaces/lock-clock.interface.js';
import type { LockStore } from '../interfaces/lock-store.interface.js';
import { LINGER } from '../locks.constants.js';

/** Internal: what `Locks` hands a lock it acquired. */
export interface LockInternals {
  key: string;
  owner: string;
  fencingToken: number;
  /** ms */
  ttl: number;
  /** When the `acquire()` call that took it was sent, on `clock`. */
  sentAt: number;
  store: LockStore;
  clock: LockClock;
  /** The lock was lost (not released). */
  onLost(lock: Lock, error: LockLostError): void;
  /** The lock was released or lost: it is no longer held. */
  onEnd(lock: Lock): void;
}

type State = 'held' | 'released' | 'lost';

const logger = new Logger('Locks');

/**
 * A lock this process holds, from `Locks.acquire()`, `withLock()`, a scheduled job
 * (`LocksContext.lock`) or a leadership hook. While it is held, it renews itself every
 * `ttl / 3`, one renewal at a time, so it only expires if this process stops renewing it
 * (a crash, a partition, a blocked event loop).
 *
 * - `fencingToken` grows with every acquisition of the key. Pass it to what the critical
 *   section writes, and have that reject a token lower than one it has seen: a holder that
 *   paused past its lease then can't overwrite the work of the holder that took over.
 * - `signal` aborts when the lock is lost (reason: `LockLostError`) or released (an
 *   `AbortError`). Pass it to the calls the critical section makes.
 * - `release()` gives the lock back; `await using lock = ...` releases it at the end of the
 *   block.
 */
export class Lock {
  readonly key: string;
  /** This acquisition's owner id: random, never reused. */
  readonly owner: string;
  readonly fencingToken: number;
  readonly signal: AbortSignal;

  private readonly controller = new AbortController();
  private state: State = 'held';
  /** On the clock: renewals must reach the store before it, or the lock counts as lost. */
  private deadline: number;
  private timer: unknown;
  private renewing = false;
  private releasing?: Promise<boolean>;

  /** @internal Locks are acquired through `Locks`, never constructed. */
  constructor(private readonly internals: LockInternals) {
    this.key = internals.key;
    this.owner = internals.owner;
    this.fencingToken = internals.fencingToken;
    this.signal = this.controller.signal;
    // The store started the lock's ttl when it processed the call, which was after it was
    // sent: counting from the send errs on the safe side.
    this.deadline = internals.sentAt + internals.ttl;
    this.schedule();
  }

  /** `true` until the lock is released or lost, or its deadline passes without a confirmed renewal. */
  get held(): boolean {
    return this.state === 'held' && this.internals.clock.now() < this.deadline;
  }

  /**
   * Gives the lock back, so another caller can take it at once, and aborts `signal`.
   * Resolves `true` when the store released it, `false` when this process no longer held it
   * (lost, or released already). Rejects when the store fails; the lock then expires after
   * `ttl`.
   */
  release(): Promise<boolean> {
    if (this.releasing) {
      return this.releasing.then(() => false, () => false);
    }

    const { store, key, owner } = this.internals;

    if (this.state !== 'held') {
      // A lost lock may still be ours in the store (the deadline passed while it was
      // unreachable): try, but it isn't this caller's problem if that fails.
      this.releasing = store.release(key, owner).then(() => false, () => false);
      return this.releasing;
    }

    this.end('released');
    this.releasing = store.release(key, owner);

    return this.releasing;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.release();
  }

  /** @internal */
  async [LINGER](ms: number): Promise<void> {
    if (this.state !== 'held') {
      return;
    }
    this.end('released');
    const { store, key, owner } = this.internals;
    await (ms > 0 ? store.renew(key, owner, ms) : store.release(key, owner));
  }

  /** The next timer: a renewal after `ttl / 3`, or the deadline if that comes first. */
  private schedule() {
    const { clock, ttl } = this.internals;
    if (this.timer !== undefined) {
      clock.clearTimeout(this.timer);
    }
    this.timer = undefined;
    if (this.state !== 'held') {
      return;
    }

    const every = Math.max(1, Math.floor(ttl / 3));
    const delay = Math.max(0, Math.min(every, this.deadline - clock.now()));
    this.timer = clock.setTimeout(() => this.tick(), delay);
  }

  /** Returns the renewal it started, for a clock that waits for it (`ManualLockClock`). */
  private tick(): Promise<void> | undefined {
    this.timer = undefined;
    if (this.state !== 'held') {
      return;
    }

    if (this.internals.clock.now() >= this.deadline) {
      this.lose('deadline');
      return;
    }

    // One renewal at a time: a slow store skips beats instead of piling them up, and the
    // deadline still fires while one is in flight.
    const renewal = this.renewing ? undefined : this.renew();
    this.schedule();

    return renewal;
  }

  private async renew() {
    const { store, key, owner, ttl, clock } = this.internals;
    this.renewing = true;
    const sentAt = clock.now();
    let renewed: boolean;

    try {
      renewed = await store.renew(key, owner, ttl);
    } catch (error) {
      // Keep going: after a transient store error, the next renewal can still land before
      // the deadline.
      if (this.state === 'held') {
        logger.error(`Could not renew the lock "${key}"`, (error as Error)?.stack ?? String(error));
      }
      return;
    } finally {
      this.renewing = false;
    }
    if (this.state !== 'held') {
      // Renewed after this process gave up on it (the deadline passed on the way): hand it
      // back rather than block the key until it expires.
      if (renewed && this.state === 'lost') {
        void store.release(key, owner).catch(() => undefined);
      }
      return;
    }
    if (!renewed) {
      this.lose('renewal');
      return;
    }

    this.deadline = Math.max(this.deadline, sentAt + ttl);
    this.schedule();
  }

  private lose(detectedBy: 'renewal' | 'deadline') {
    if (this.state !== 'held') {
      return;
    }
    const error = new LockLostError(this.key, this.fencingToken, detectedBy);
    this.end('lost', error);
    this.internals.onLost(this, error);
  }

  private end(state: 'released' | 'lost', reason?: LockLostError) {
    this.state = state;
    if (this.timer !== undefined) {
      this.internals.clock.clearTimeout(this.timer);
    }
    this.timer = undefined;
    if (!this.signal.aborted) {
      this.controller.abort(reason ?? new DOMException(`The lock "${this.key}" was released`, 'AbortError'));
    }
    this.internals.onEnd(this);
  }
}
