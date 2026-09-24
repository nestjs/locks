import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import { LockKeys } from './lock-keys.service.js';
import type { Lock } from '../lock/lock.js';
import { JOB_DEFINITION, LINGER, LOCKS_INTERNALS } from '../locks.constants.js';
import { runInLockScope } from '../context/locks.context.js';
import { Locks, type LocksInternals } from '../locks.service.js';
import { decoratorsOf, describeJob, jobRunners, type JobDefinition, type JobRunner } from '../utils/job-registry.util.js';

/**
 * On shutdown, a job that started less than this long ago keeps its lease for the rest of
 * it, instead of releasing it at once: an instance whose clock runs up to this much behind
 * then doesn't run the tick the owner just ran.
 */
const HANDOVER_GRACE = 1_000;

/** What an application shares between the jobs with one key: the lease, and the runs in progress. */
class KeyState {
  ownership?: Lock;
  private acquiring?: Promise<Lock | null>;
  lastStartedAt?: number;

  constructor(
    readonly key: string,
    private readonly locks: LocksInternals,
    private readonly logger: Logger,
  ) {}

  get ownerKey() {
    return `${this.key}:owner`;
  }

  /** The lease on the job: this instance's if it holds it or can take it now, else `null`. */
  ensureOwnership(ttl: number, job: string): Promise<Lock | null> {
    if (this.ownership?.held) {
      return Promise.resolve(this.ownership);
    }

    this.ownership = undefined;
    this.acquiring ??= this.locks
      .tryAcquire(this.ownerKey, ttl, (lost) => {
        if (this.ownership === lost) {
          this.ownership = undefined;
        }
      })
      .then((lock) => {
        if (lock) {
          this.ownership = lock;
          this.logger.log(`${job} runs on this instance (lease "${lock.key}", fencing token ${lock.fencingToken})`);
        }
        return lock;
      })
      .finally(() => {
        this.acquiring = undefined;
      });

    return this.acquiring;
  }
}

/**
 * Finds the methods decorated with `@OnOneInstance()` or `@WithoutOverlapping()` on the
 * application's providers, runs their calls, and on shutdown waits for the runs in progress
 * before it hands the leases back.
 */
@Injectable()
export class ScheduledJobs implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Locks');
  private readonly states = new Map<string, KeyState>();
  private readonly pending = new Set<Promise<unknown>>();
  private stopping = false;

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly locks: Locks,
    private readonly keys: LockKeys,
  ) {}

  onModuleInit() {
    /** Which job each key came from: two different jobs may share a key only if both set it. */
    const owners = new Map<string, JobDefinition>();
    /** The jobs on each key, for the collision check against the other keys and the elections. */
    const jobs = new Map<string, string[]>();

    for (const wrapper of [...this.discovery.getProviders(), ...this.discovery.getControllers()]) {
      const { instance } = wrapper;
      if (!instance || typeof instance !== 'object' || !Object.getPrototypeOf(instance)) {
        continue;
      }
      for (const name of this.scanner.getAllMethodNames(Object.getPrototypeOf(instance))) {
        const definition = (instance as Record<string, { [JOB_DEFINITION]?: JobDefinition } | undefined>)[name]?.[JOB_DEFINITION];
        if (!definition) {
          continue;
        }
        if (!wrapper.isDependencyTreeStatic()) {
          this.logger.warn(
            `${describeJob(definition)} is decorated with ${decoratorsOf(definition)}, but ${wrapper.name as string} is ` +
              'not a singleton provider (it is request-scoped or transient, or depends on one), so its calls will fail.',
          );
          continue;
        }
        const key = definition.key ?? definition.derivedKey;
        const previous = owners.get(key);
        if (previous && previous !== definition && (previous.key === undefined || definition.key === undefined)) {
          throw new Error(
            `LocksModule: ${describeJob(previous)} and ${describeJob(definition)} both use the lock key "${key}". ` +
              'Two jobs share a key only when both set it on purpose (to exclude each other); set `key` on ' +
              `${decoratorsOf(definition.key === undefined ? definition : previous)} to tell them apart.`,
          );
        }
        owners.set(key, definition);
        if (!jobs.get(key)?.includes(describeJob(definition))) {
          jobs.set(key, [...(jobs.get(key) ?? []), describeJob(definition)]);
        }
        this.register(instance, definition, key);
      }
    }
    // A job holds `key` (its run lock) and `key:owner` (its lease): neither may be another
    // job's key or lease, or an election's key.
    for (const [key, names] of jobs) {
      const holder = `the job ${names.join(' and ')} (key "${key}")`;
      this.keys.claim(key, holder);
      this.keys.claim(`${key}:owner`, holder);
    }
  }

  /** Runs in progress finish (they keep their locks), then the leases go back. */
  async onModuleDestroy() {
    this.stopping = true;
    await Promise.allSettled(this.pending);
    const { clock } = this.locks[LOCKS_INTERNALS];
    await Promise.all(
      [...this.states.values()].map(async (state) => {
        const lease = state.ownership;
        if (!lease?.held) {
          return;
        }

        const since = clock.now() - (state.lastStartedAt ?? -Infinity);
        await lease[LINGER](Math.max(0, HANDOVER_GRACE - since)).catch((error: unknown) => {
          this.logger.error(`Could not hand back the lease "${lease.key}"`, (error as Error)?.stack ?? String(error));
        });
      }),
    );
  }

  private register(instance: object, definition: JobDefinition, key: string) {
    const internals = this.locks[LOCKS_INTERNALS];
    let state = this.states.get(key);
    if (!state) {
      this.states.set(key, (state = new KeyState(key, internals, this.logger)));
    }
    const runner = this.runner(definition, state, internals);
    let runners = jobRunners.get(instance);
    if (!runners) {
      jobRunners.set(instance, (runners = new Map()));
    }
    runners.set(definition, runner);
  }

  private runner(definition: JobDefinition, state: KeyState, internals: LocksInternals): JobRunner {
    const job = describeJob(definition);
    const skip = (why: string) => {
      this.logger.debug(`Skipped ${job}: ${why}`);
      return undefined;
    };
    const run = async (invoke: () => unknown): Promise<unknown> => {
      if (this.stopping) {
        return skip('the application is shutting down');
      }

      let ownership: Lock | null = null;
      let runLock: Lock | null = null;

      try {
        if (definition.oneInstance) {
          ownership = await state.ensureOwnership(definition.oneInstance.ttl ?? internals.defaultTtl, job);
          if (!ownership) {
            return skip('it runs on another instance');
          }
        }
        if (definition.withoutOverlapping) {
          runLock = await internals.tryAcquire(state.key, definition.withoutOverlapping.ttl ?? internals.defaultTtl);
          if (!runLock) {
            return skip('a run is still in progress');
          }
        }
      } catch (error) {
        // Fail closed: without the lock, running could mean running twice.
        throw new Error(`${job} did not run: the lock store failed (${(error as Error)?.message ?? String(error)})`, {
          cause: error,
        });
      }

      const lock = (runLock ?? ownership)!;
      const signal = runLock && ownership ? AbortSignal.any([runLock.signal, ownership.signal]) : lock.signal;
      state.lastStartedAt = internals.clock.now();

      try {
        return await runInLockScope({ lock, signal }, invoke);
      } finally {
        await runLock?.release().catch((error: unknown) => {
          this.logger.error(`Could not release the lock "${state.key}" after ${job}`, (error as Error)?.stack ?? String(error));
        });
      }
    };

    return {
      run: (invoke) => {
        const execution = run(invoke);
        this.pending.add(execution);
        const done = () => this.pending.delete(execution);
        execution.then(done, done);
        return execution;
      },
    };
  }
}
