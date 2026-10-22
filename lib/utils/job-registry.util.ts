/** What `@OnOneInstance()` and `@WithoutOverlapping()` record on the method they wrap. */
export interface JobDefinition {
  /** The class that declares the method: its subclasses inherit the job, each with a key of its own. */
  className: string;
  methodName: string;
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

/**
 * `ClassName.methodName`, named after the instance's class when given one: the key when neither
 * decorator sets one. A subclass that inherits a decorated method is a job of its own.
 */
export function describeJob(definition: JobDefinition, instance?: object): string {
  return `${jobClassName(definition, instance)}.${definition.methodName}`;
}

/** The instance's class when given one, else the class that declares the method. */
export function jobClassName(definition: JobDefinition, instance?: object): string {
  return (instance && (instance.constructor as { name?: string } | undefined)?.name) || definition.className;
}

export function decoratorsOf(definition: JobDefinition): string {
  return [definition.oneInstance && '@OnOneInstance()', definition.withoutOverlapping && '@WithoutOverlapping()']
    .filter(Boolean)
    .join(' and ');
}
