import type { Duration } from '../interfaces/duration.interface.js';
import { toMs } from './duration.util.js';

/** A duration option in ms, with the option named in the error. */
export function durationMs(value: Duration, option: string): number {
  try {
    return toMs(value);
  } catch (error) {
    throw new TypeError(`${option}: ${(error as Error).message}`);
  }
}

/** A lock's time to live: whole milliseconds, at least 1. */
export function ttlMs(value: Duration, option: string): number {
  const ms = Math.ceil(durationMs(value, option));
  if (ms < 1) {
    throw new RangeError(`${option} must be at least 1ms, got ${JSON.stringify(value)}`);
  }
  return ms;
}
