/** The default `ttl`, in ms: 30 seconds. */
export const DEFAULT_TTL = 30_000;

/** Internal: what the scheduler and elections use. */
export const LOCKS_INTERNALS = Symbol('Locks.internals');

/** Internal: locks the registry. `LocksModule.onModuleInit()` and the first read call it. */
export const LOCK_STORAGE = Symbol('LocksStorage.lock');

/** Internal: stops renewing and lets the lock expire `ms` from now, instead of releasing it. */
export const LINGER = Symbol('Lock.linger');

/** Internal: where `@OnOneInstance()` and `@WithoutOverlapping()` keep the job's definition on the method they wrap. */
export const JOB_DEFINITION = Symbol('nestjs:locks:job');

/** @internal Where `@LeaderElection()` keeps its definition on the class. */
export const LEADER_ELECTION = Symbol('nestjs:locks:leader-election');
