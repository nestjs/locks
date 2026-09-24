/** What `@OnOneInstance()` and `@WithoutOverlapping()` record on the method they wrap. */
export interface JobDefinition {
  className: string;
  methodName: string;
  /** `ClassName.methodName`: the key when neither decorator sets one. */
  derivedKey: string;
  /** Set by either decorator. */
  key?: string;
  /** `@OnOneInstance()`: the ownership lease's ttl in ms, or the module's. */
  oneInstance?: { ttl?: number };
  /** `@WithoutOverlapping()`: the run lock's ttl in ms, or the module's. */
  withoutOverlapping?: { ttl?: number };
}

/** What runs a job for one provider instance of one application. */
export interface JobRunner {
  run(invoke: () => unknown): Promise<unknown>;
}

/**
 * The runners by provider instance, filled by `LocksModule` when it discovers the
 * application's providers. Keyed by instance, so several applications in one process
 * (tests) each run their own jobs on their own store.
 */
export const jobRunners = new WeakMap<object, Map<JobDefinition, JobRunner>>();

export function describeJob(definition: JobDefinition): string {
  return `${definition.className}.${definition.methodName}`;
}

export function decoratorsOf(definition: JobDefinition): string {
  return [definition.oneInstance && '@OnOneInstance()', definition.withoutOverlapping && '@WithoutOverlapping()']
    .filter(Boolean)
    .join(' and ');
}
