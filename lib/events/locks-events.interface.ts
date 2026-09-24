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
