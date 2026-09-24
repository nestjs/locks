import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { LockStore } from '../interfaces/lock-store.interface.js';
import type { LocksStorageRegisterOptions } from '../interfaces/locks-storage-register-options.interface.js';
import { LOCK_STORAGE } from '../locks.constants.js';
import { LOCKS_MODULE_OPTIONS } from '../locks.module-definition.js';
import type { LocksModuleOptions } from '../interfaces/locks-module-options.interface.js';
import { InMemoryLockStore } from '../stores/in-memory-lock.store.js';

/** The methods `LocksStorage.registerSource()` checks for. */
export const LOCK_STORE_METHODS = ['acquire', 'renew', 'release'] as const;

const DEFAULT =
  'InMemoryLockStore (the default: locks exclude callers in this process only, and are lost on restart)';

/**
 * Where the app registers its lock store. Inject it into the provider that implements
 * `LockStore` and register in the constructor:
 *
 * ```ts
 * constructor(@InjectDrizzle() private readonly db: Database, storage: LocksStorage) {
 *   storage.registerSource(this);
 * }
 * ```
 *
 * With nothing registered, the module uses an `InMemoryLockStore`, which fails startup in
 * production unless `allowInMemoryStorage` is set. The registry locks in `LocksModule`'s
 * `onModuleInit`, after every provider constructor has run and before any scheduled job
 * runs, or at the first read of the store if that is earlier (another module's
 * `onModuleInit`).
 */
@Injectable()
export class LocksStorage {
  private readonly logger = new Logger('LocksModule');
  private registered?: LockStore;
  private active?: LockStore;

  constructor(@Optional() @Inject(LOCKS_MODULE_OPTIONS) private readonly options?: LocksModuleOptions) {}

  /**
   * Makes `source` the store every lock uses. Call it once, from the constructor of a
   * singleton provider. Throws when `source` is missing a method, when a source is already
   * registered (unless `{ replace: true }`), and once the registry has locked.
   */
  registerSource(source: LockStore, options: LocksStorageRegisterOptions = {}): void {
    validate(source);
    if (this.active) {
      throw new Error(
        `LocksStorage.registerSource(): ${nameOf(source)} registered after LocksModule initialized (or after its ` +
          `storage was first read), which already uses ${this.registered ? nameOf(this.active) : DEFAULT}. Register ` +
          'from the constructor of a singleton provider: providers of lazy-loaded modules, request-scoped and ' +
          'transient providers, and lifecycle hooks run too late.',
      );
    }
    if (this.registered && !options.replace) {
      throw new Error(
        `LocksStorage.registerSource(): ${nameOf(source)} can't register, ` +
          `${this.registered === source ? 'it already did (the same instance, twice)' : `${nameOf(this.registered)} already did`}. ` +
          'Register one store, or pass { replace: true } to replace it on purpose (tests, wrappers).',
      );
    }

    this.registered = source;
  }

  /** The store in use: the registered source, or the in-memory default. Reading it locks the registry. */
  get source(): LockStore {
    if (!this.active) {
      this[LOCK_STORAGE]();
    }
    return this.active!;
  }

  /** Fixes the source, logs it, and enforces the production guard (which leaves the registry open). */
  [LOCK_STORAGE](): void {
    if (this.active) {
      return;
    }
    if (!this.registered && process.env.NODE_ENV === 'production' && !this.options?.allowInMemoryStorage) {
      throw new Error(
        'LocksStorage: no LockStore is registered, and NODE_ENV is "production": in memory, a lock only excludes ' +
          'callers in this process, so every instance of the app would take the same lock and run the same job. ' +
          'Implement LockStore in a provider that injects LocksStorage and calls `storage.registerSource(this)` in its ' +
          'constructor, or set `allowInMemoryStorage: true` in the LocksModule options to run in memory anyway (one ' +
          'instance).',
      );
    }

    this.active = this.registered ?? new InMemoryLockStore({ clock: this.options?.clock });
    this.logger.log(`LocksStorage: ${this.registered ? nameOf(this.registered) : DEFAULT}`);
  }
}

/** Throws unless `source` has every method of `LockStore`. */
function validate(source: LockStore): void {
  if (source === null || typeof source !== 'object') {
    throw new TypeError(`LocksStorage.registerSource(): expected an object implementing LockStore, got ${nameOf(source)}.`);
  }

  const missing = LOCK_STORE_METHODS.filter(
    (method) => typeof (source as unknown as Record<string, unknown>)[method] !== 'function',
  );
  if (missing.length > 0) {
    throw new TypeError(
      `LocksStorage.registerSource(): ${nameOf(source)} doesn't implement LockStore: ` +
        `${missing.map((m) => `${m}()`).join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing.`,
    );
  }
}

/** How a message names a value: its class, or what it is instead of an instance. */
export function nameOf(value: unknown): string {
  if (typeof value === 'function') {
    return `the class ${value.name || '(anonymous)'} (pass an instance)`;
  }
  if (value === null || typeof value !== 'object') {
    return String(value);
  }

  const name = (value as object).constructor?.name;

  return name && name !== 'Object' ? name : 'an object';
}

/** The store is registered, not configured: a leftover `store` option fails instead of being ignored. */
export function storeOptionError(): Error {
  return new Error(
    'LocksModule: `store` is not an option. Implement LockStore in a provider that injects LocksStorage and calls ' +
      '`storage.registerSource(this)` in its constructor.',
  );
}
