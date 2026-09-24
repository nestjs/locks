import type { LoggerService, ModuleMetadata } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { Test, type TestingModule } from '@nestjs/testing';
import { LocksModule } from '../lib/locks.module.js';
import type { LocksModuleForRootOptions } from '../lib/interfaces/locks-module-options.interface.js';
import { LocksStorage } from '../lib/storage/locks.storage.js';
import type { LockStore } from '../lib/interfaces/lock-store.interface.js';

/** Collects log lines as `[Context] message` (the global logger, so every app in this process). */
export class CapturingLogger implements LoggerService {
  readonly lines: string[] = [];
  log(message: unknown, context?: string) {
    this.lines.push(`[${context}] ${message}`);
  }
  error(message: unknown, ...rest: unknown[]) {
    this.lines.push(`[${rest.at(-1)}] ERROR ${message}`);
  }
  warn(message: unknown, context?: string) {
    this.lines.push(`[${context}] WARN ${message}`);
  }
  debug(message: unknown, context?: string) {
    this.lines.push(`[${context}] DEBUG ${message}`);
  }
  verbose() {}
  matching(pattern: string | RegExp) {
    return this.lines.filter((line) => (typeof pattern === 'string' ? line.includes(pattern) : pattern.test(line)));
  }
}

export interface InstanceOptions extends Pick<ModuleMetadata, 'imports' | 'providers'> {
  /** LocksModule options (clock, ttl...). */
  locks?: LocksModuleForRootOptions;
  /** A store shared with other instances; without one, each instance has its own in-memory store. */
  store?: LockStore;
  /** Import `ScheduleModule.forRoot()`. Default `false`. */
  schedule?: boolean;
  logger?: LoggerService | false;
}

/**
 * One instance of an application, as a Nest application context. Several of them sharing
 * one store and one clock are several instances of the app in one process.
 */
export async function startInstance(options: InstanceOptions = {}): Promise<TestingModule> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      LocksModule.forRoot(options.locks ?? {}),
      ...(options.schedule ? [ScheduleModule.forRoot()] : []),
      ...(options.imports ?? []),
    ],
    providers: options.providers ?? [],
  }).compile();
  moduleRef.useLogger(options.logger ?? false);
  if (options.store) {
    moduleRef.get(LocksStorage).registerSource(options.store, { replace: true });
  }
  await moduleRef.init();

  return moduleRef;
}

/** A promise with its resolve and reject, to hold a job open. */
export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function until(check: () => boolean | Promise<boolean>, timeout = 5_000) {
  const start = performance.now();
  while (!(await check())) {
    if (performance.now() - start > timeout) {
      throw new Error('Timed out waiting');
    }
    await sleep(5);
  }
}
