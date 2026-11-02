/**
 * Channel `nestjs:locks:lock-lost`: a holder lost its lock while using it (`detectedBy`, as
 * on `LockLostError`). Another instance may be running the same critical section: alert on
 * it, and fence the writes it guards.
 */
export interface LocksLockLostEvent {
  type: 'lock-lost';
  key: string;
  fencingToken: number;
  detectedBy: 'renewal' | 'deadline';
}

/** Channel `nestjs:locks:leadership-acquired`: this instance became the leader of `key`. */
export interface LocksLeadershipAcquiredEvent {
  type: 'leadership-acquired';
  key: string;
  fencingToken: number;
}

/**
 * Channel `nestjs:locks:leadership-lost`: this instance stopped leading `key`, because its
 * lease was lost (`reason: 'lost'`) or it stepped down (`'released'`: shutdown, or an
 * `onLeadershipAcquired()` hook that failed).
 */
export interface LocksLeadershipLostEvent {
  type: 'leadership-lost';
  key: string;
  fencingToken: number;
  reason: 'lost' | 'released';
}

export type LocksEvent = LocksLockLostEvent | LocksLeadershipAcquiredEvent | LocksLeadershipLostEvent;

/**
 * Why a call to an `@OnOneInstance()` or `@WithoutOverlapping()` job did not run: the lease
 * (`'ownership-unavailable'`) or the run lock (`'run-lock-unavailable'`) wasn't granted in time to
 * use it, or the application is shutting down (`'shutdown'`). What this instance saw, not
 * proof: an unavailable lock is usually held elsewhere, but may be one the store granted too
 * late, and gave back.
 */
export type LocksJobSkipReason = 'ownership-unavailable' | 'run-lock-unavailable' | 'shutdown';

/**
 * Channel `nestjs:locks:job-skipped`: a call to `job` (`Class.method`) resolved `undefined`
 * without running, for `reason`. One per skipped call on this instance; the ticks a scheduler
 * never makes aren't counted. `key` is the job's lock key (its `key`, else `job`), not its
 * lease's. On `LocksEvents.jobSkips$`, not on `events$`.
 */
export interface LocksJobSkippedEvent {
  type: 'job-skipped';
  job: string;
  key: string;
  reason: LocksJobSkipReason;
}
