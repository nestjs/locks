import type { Lock } from '../lock/lock.js';
import type { Duration } from './duration.interface.js';

export interface LeaderElectionOptions {
  /**
   * How long the leader's lease lives without a renewal: how soon another instance takes
   * over after the leader crashed. The leader renews it every `ttl / 3`, and the others try
   * to take it as often. Default: the module's `ttl` (`'30s'`).
   */
  ttl?: Duration;
}

/** Called on a `@LeaderElection()` provider when this instance becomes the leader. */
export interface OnLeadershipAcquired {
  /**
   * `lock` is the leader's lease: its `fencingToken` grows with every new leader, and its
   * `signal` aborts when leadership ends. A hook that throws (or rejects) makes the instance
   * step down, so another one can lead.
   */
  onLeadershipAcquired(lock: Lock): unknown;
}

/**
 * Called on a `@LeaderElection()` provider when this instance stops leading: its lease was
 * lost (`lock.signal.reason` is a `LockLostError`), or it stepped down at shutdown or after
 * a failed `onLeadershipAcquired()` (an `AbortError`).
 */
export interface OnLeadershipLost {
  onLeadershipLost(lock: Lock): unknown;
}

/** @internal */
export interface LeaderElectionDefinition {
  key: string;
  /** ms, or the module's. */
  ttl?: number;
}
