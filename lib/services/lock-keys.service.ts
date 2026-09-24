import { Injectable } from '@nestjs/common';

/**
 * Internal: the lock keys the application's jobs and elections use, checked against each
 * other at startup. A job with key `k` holds `k` (its run lock) and `k:owner` (its lease);
 * an election holds its key. Two features on one key would exclude each other silently: a
 * job that never runs anywhere, an election that never elects.
 */
@Injectable()
export class LockKeys {
  private readonly claims = new Map<string, string>();

  /** Reserves `key` for `holder` (how a message names it); throws when another holder has it. */
  claim(key: string, holder: string): void {
    const previous = this.claims.get(key);
    if (previous !== undefined && previous !== holder) {
      throw new Error(
        `LocksModule: ${holder} and ${previous} both use the lock key "${key}", so they would exclude each other. ` +
          'Give one of them another key.',
      );
    }

    this.claims.set(key, holder);
  }
}
