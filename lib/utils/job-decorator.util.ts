import { JOB_DEFINITION } from '../locks.constants.js';
import type { OnOneInstanceOptions, WithoutOverlappingOptions } from '../interfaces/job-options.interface.js';
import { decoratorsOf, describeJob, jobRunners, type JobDefinition } from './job-registry.util.js';
import { ttlMs } from './ttl.util.js';

type Kind = 'oneInstance' | 'withoutOverlapping';

type Wrapped = ((...args: unknown[]) => Promise<unknown>) & { [JOB_DEFINITION]?: JobDefinition };

/** Internal: what `@OnOneInstance()` and `@WithoutOverlapping()` do, `kind` telling them apart. */
export function decorateJob(kind: Kind, decorator: string, options: OnOneInstanceOptions | WithoutOverlappingOptions): MethodDecorator {
  if (options === null || typeof options !== 'object') {
    throw new TypeError(`${decorator} takes an options object ({ key, ttl }), got ${JSON.stringify(options)}`);
  }

  const { key } = options;
  if (key !== undefined && (typeof key !== 'string' || key.length === 0)) {
    throw new TypeError(`${decorator}: \`key\` must be a non-empty string, got ${JSON.stringify(key)}`);
  }

  // Checked when the class is defined: a typo fails at import, not at 2 AM.
  const ttl = options.ttl === undefined ? undefined : ttlMs(options.ttl, `${decorator}: \`ttl\``);

  return (target, propertyKey, descriptor) => {
    const where = `${typeof target === 'function' ? target.name : target.constructor.name}.${String(propertyKey)}`;
    if (typeof target === 'function') {
      throw new TypeError(`${decorator} on ${where}: use it on an instance method of a provider, not a static method`);
    }

    const method = descriptor.value;
    if (typeof method !== 'function') {
      throw new TypeError(`${decorator} on ${where}: use it on a method`);
    }

    const wrapper = (method as Wrapped)[JOB_DEFINITION] ? (method as Wrapped) : wrap(method as (...args: unknown[]) => unknown, target, propertyKey);
    const definition = wrapper[JOB_DEFINITION]!;
    if (definition[kind]) {
      throw new TypeError(`${decorator} is applied twice to ${where}`);
    }

    if (key !== undefined) {
      if (definition.key !== undefined && definition.key !== key) {
        throw new TypeError(
          `${decoratorsOf(definition)} and ${decorator} on ${where} set different keys ("${definition.key}" and ` +
            `"${key}"): they share one, set it on either`,
        );
      }
      definition.key = key;
    }

    definition[kind] = { ttl };
    descriptor.value = wrapper as typeof descriptor.value;

    return descriptor;
  };
}

/**
 * Replaces the method with one that asks the application's runner, and carries over the
 * metadata already on it (a `@Cron()` below this decorator), so `@nestjs/schedule` finds the
 * job either way: decorators above this one write to the wrapper.
 */
function wrap(method: (...args: unknown[]) => unknown, target: object, propertyKey: string | symbol): Wrapped {
  const definition: JobDefinition = {
    className: target.constructor.name,
    methodName: String(propertyKey),
    derivedKey: `${target.constructor.name}.${String(propertyKey)}`,
  };
  const wrapper: Wrapped = async function (this: object, ...args: unknown[]) {
    const runner = jobRunners.get(this)?.get(definition);
    if (!runner) {
      throw new Error(
        `${describeJob(definition)} is decorated with ${decoratorsOf(definition)}, but LocksModule doesn't know this ` +
          `instance, so it can't tell whether this call may run. Import LocksModule in the application, and provide ` +
          `${definition.className} as a singleton provider (not request-scoped or transient, not created with \`new\`).`,
      );
    }

    return runner.run(() => method.apply(this, args));
  };
  wrapper[JOB_DEFINITION] = definition;
  Object.defineProperty(wrapper, 'name', { value: method.name, configurable: true });
  const reflect = Reflect as typeof Reflect & {
    getOwnMetadataKeys?: (target: object) => unknown[];
    getOwnMetadata?: (key: unknown, target: object) => unknown;
    defineMetadata?: (key: unknown, value: unknown, target: object) => void;
  };
  for (const metadataKey of reflect.getOwnMetadataKeys?.(method) ?? []) {
    reflect.defineMetadata!(metadataKey, reflect.getOwnMetadata!(metadataKey, method), wrapper);
  }

  return wrapper;
}
