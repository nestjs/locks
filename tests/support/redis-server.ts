/**
 * A throwaway Redis server for tests: the locally installed `redis-server` (`REDIS_SERVER_BIN`,
 * else `/usr/local/bin`, `/opt/homebrew/bin`, else `PATH`) on a random loopback port, with no
 * persistence, stopped afterwards. Nothing is downloaded. `REDIS_TEST_URL` uses an existing
 * server instead (its databases are flushed). Resolves to `null` with the reason when there is
 * no server, so a suite can skip with a clear message.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { RedisClient } from '../fixtures/redis/redis.client.js';

export interface TestRedis {
  url: string;
  stop(): void;
}

export type TestRedisResult = { redis: TestRedis; reason?: undefined } | { redis: null; reason: string };

export async function startRedis(): Promise<TestRedisResult> {
  if (process.env.REDIS_TEST_URL) {
    const client = new RedisClient(process.env.REDIS_TEST_URL);
    await client.command('FLUSHALL');
    await client.quit();
    return { redis: { url: process.env.REDIS_TEST_URL, stop: () => {} } };
  }
  const bin = findServer();
  if (!bin) return { redis: null, reason: 'redis-server not found (set REDIS_SERVER_BIN or REDIS_TEST_URL)' };
  const port = await freePort();
  const child = spawn(bin, ['--port', String(port), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no'], {
    stdio: 'ignore',
  });
  const stop = () => {
    if (child.exitCode === null) child.kill('SIGKILL');
  };
  process.once('exit', stop);
  const url = `redis://127.0.0.1:${port}`;
  const started = performance.now();
  for (;;) {
    const client = new RedisClient(url);
    try {
      if ((await client.command('PING')) === 'PONG') break;
    } catch {
      // not listening yet
    } finally {
      await client.quit().catch(() => undefined);
    }
    if (performance.now() - started > 5_000) {
      stop();
      return { redis: null, reason: `redis-server didn't start on port ${port}` };
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return { redis: { url, stop } };
}

function findServer(): string | undefined {
  for (const dir of [process.env.REDIS_SERVER_BIN, '/usr/local/bin', '/opt/homebrew/bin']) {
    if (dir && existsSync(join(dir, 'redis-server'))) return join(dir, 'redis-server');
  }
  const which = spawnSync('which', ['redis-server'], { encoding: 'utf8' });
  return which.status === 0 ? which.stdout.trim() : undefined;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}
