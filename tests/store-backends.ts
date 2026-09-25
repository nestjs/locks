/**
 * The stores the README documents, each opened once per test file and shared by the instances
 * of the app a test starts, as instances in production share one database:
 *
 * - `InMemoryLockStore`, registered in every instance, on a `ManualLockClock` of its own.
 * - The `DrizzleLockStore` recipe (`fixtures/database`) with its migration, on PGlite (every
 *   instance gets the one in-process database through `DrizzleModule.forRoot({ db })`) and on
 *   PostgreSQL (`SQL_TEST_PG_URL`, else a throwaway cluster from local binaries; every instance opens its
 *   own pool with `DrizzleModule.forRootAsync()` and ends it in `onApplicationShutdown()`).
 * - The `RedisLockStore` recipe (`fixtures/redis`) on a throwaway `redis-server` (every instance
 *   its own connection, through the recipe's `RedisModule`).
 */
import { PGlite } from '@electric-sql/pglite';
import type { DynamicModule, Type } from '@nestjs/common';
import { DrizzleModule } from '@nestjs/drizzle';
import type { TestingModule } from '@nestjs/testing';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { DrizzleLockStore } from './fixtures/database/drizzle-lock.store.js';
import * as schema from './fixtures/database/schema.js';
import { RedisLockStore } from './fixtures/redis/redis-lock.store.js';
import { RedisClient } from './fixtures/redis/redis.client.js';
import { RedisModule } from './fixtures/redis/redis.module.js';
import { startPostgres } from './support/postgres.js';
import { startRedis } from './support/redis-server.js';
import type { LockStore } from '../lib/interfaces/lock-store.interface.js';
import { LocksStorage } from '../lib/storage/locks.storage.js';
import { InMemoryLockStore } from '../lib/stores/in-memory-lock.store.js';
import { ManualLockClock } from '../lib/testing/manual-lock-clock.js';

const migrationsFolder = fileURLToPath(new URL('./fixtures/drizzle', import.meta.url));

export interface StoreBackend {
  name: string;
  /** Why this store is unavailable here (its suite is skipped with the reason). */
  unavailable?: string;
  /** What one instance of the app imports and provides for its store: its own connection, and the recipe's provider. */
  modules(): (DynamicModule | Type<unknown>)[];
  providers(): Type<unknown>[];
  /** Runs on each instance before `init()`. */
  beforeInit(moduleRef: TestingModule): void;
  /** The store an instance uses, for spying on its calls. */
  storeOf(moduleRef: TestingModule): LockStore;
  /** The owner of the live lock on `key`, if any, read from the store's own data. */
  holder(key: string): Promise<string | undefined>;
  /**
   * Makes the store expire the locks on `keys`, as it does when their holder stops renewing
   * past the ttl (the in-memory store's clock moves past every lease).
   */
  expire(keys: string[]): Promise<void>;
  /** Empties the store between tests. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

export async function openBackends(): Promise<StoreBackend[]> {
  return [memoryBackend(), await pgliteBackend(), await postgresBackend(), await redisBackend()];
}

function memoryBackend(): StoreBackend {
  let clock = new ManualLockClock();
  let store = new InMemoryLockStore({ clock });

  return {
    name: 'InMemoryLockStore shared by the instances',
    modules: () => [],
    providers: () => [],
    beforeInit: (moduleRef) => moduleRef.get(LocksStorage).registerSource(store, { replace: true }),
    storeOf: () => store,
    holder: async (key) => store.peek(key)?.owner,
    expire: () => clock.advance('1d'),
    reset: async () => {
      clock = new ManualLockClock();
      store = new InMemoryLockStore({ clock });
    },
    close: async () => undefined,
  };
}

/** A `DrizzleLockStore` backend on a database that `query` reads and writes. */
function sqlBackend(
  name: string,
  store: Type<LockStore>,
  drizzleModule: () => DynamicModule,
  query: (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>,
  close: () => Promise<void>,
): StoreBackend {
  return {
    name,
    modules: () => [drizzleModule()],
    providers: () => [store],
    beforeInit: () => undefined,
    storeOf: (moduleRef) => moduleRef.get(store),
    holder: async (key) => {
      const [row] = await query('select owner from locks where key = $1 and owner is not null and expires_at > clock_timestamp()', [key]);
      return (row?.owner as string | undefined) ?? undefined;
    },
    expire: async (keys) => {
      await query("update locks set expires_at = clock_timestamp() - interval '1 millisecond' where key = any($1)", [keys]);
    },
    reset: async () => {
      await query('truncate locks');
    },
    close,
  };
}

async function pgliteBackend(): Promise<StoreBackend> {
  const client = new PGlite();
  const db = drizzlePglite(client, { schema });
  await migratePglite(db, { migrationsFolder });

  return sqlBackend(
    'DrizzleLockStore on PGlite',
    DrizzleLockStore,
    () => DrizzleModule.forRoot({ db, autoCloseConnection: false }),
    async (text, params) => (await client.query<Record<string, unknown>>(text, params)).rows,
    () => client.close(),
  );
}

async function postgresBackend(): Promise<StoreBackend> {
  const name = 'DrizzleLockStore on PostgreSQL';
  const { postgres, reason } = await startPostgres();
  if (!postgres) {
    return unavailable(name, reason);
  }

  const url = await postgres.createDatabase('locks_integration');
  const pool = new pg.Pool({ connectionString: url });
  await migrate(drizzle(pool, { schema }), { migrationsFolder });

  return sqlBackend(
    name,
    DrizzleLockStore,
    // What an application's AppModule registers: a pool per instance, ended in onApplicationShutdown().
    () => DrizzleModule.forRootAsync({ useFactory: () => ({ drizzle, connection: url, schema }) }),
    async (text, params) => (await pool.query(text, params)).rows,
    async () => {
      await pool.end();
      postgres.stop();
    },
  );
}

async function redisBackend(): Promise<StoreBackend> {
  const name = 'RedisLockStore on redis-server';
  const { redis, reason } = await startRedis();
  if (!redis) {
    return unavailable(name, reason);
  }

  const client = new RedisClient(redis.url);
  // The recipe's RedisModule connects each instance to REDIS_URL.
  process.env.REDIS_URL = redis.url;

  return {
    name,
    modules: () => [RedisModule],
    providers: () => [RedisLockStore],
    beforeInit: () => undefined,
    storeOf: (moduleRef) => moduleRef.get(RedisLockStore),
    holder: async (key) => ((await client.command('GET', `locks:key:${key}`)) as string | null) ?? undefined,
    // A key Redis expired and a deleted key are the same thing; the fencing counter stays.
    expire: async (keys) => {
      await client.command('DEL', ...keys.map((key) => `locks:key:${key}`));
    },
    reset: async () => {
      await client.command('FLUSHALL');
    },
    close: async () => {
      await client.quit();
      delete process.env.REDIS_URL;
      redis.stop();
    },
  };
}

function unavailable(name: string, reason: string): StoreBackend {
  const fail = () => {
    throw new Error(`${name} is unavailable: ${reason}`);
  };

  return {
    name,
    unavailable: reason,
    modules: fail,
    providers: fail,
    beforeInit: fail,
    storeOf: fail,
    holder: fail,
    expire: fail,
    reset: fail,
    close: async () => undefined,
  };
}
