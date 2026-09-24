import { ManualLockClock } from '../lib/testing/manual-lock-clock.js';
import { InMemoryLockStore } from '../lib/stores/in-memory-lock.store.js';
import { lockStoreContract } from '../lib/testing/index.js';

describe('InMemoryLockStore: the LockStore contract, on a ManualLockClock', () => {
  let clock: ManualLockClock;
  const cases = lockStoreContract(
    () => {
      clock = new ManualLockClock();
      return new InMemoryLockStore({ clock });
    },
    { advanceTime: (ms) => clock.advance(ms), concurrent: true },
  );
  for (const c of cases) {
    it(c.name, c.run);
  }
});

describe('InMemoryLockStore: the LockStore contract, on the system clock', () => {
  // The expiry cases wait in real time: the store reads Date.now() by default.
  const cases = lockStoreContract(() => new InMemoryLockStore());
  for (const c of cases) {
    it(c.name, c.run, 10_000);
  }
});

describe('InMemoryLockStore', () => {
  it('peek() shows the live lock as a copy, and nothing once it expired', async () => {
    const clock = new ManualLockClock();
    const store = new InMemoryLockStore({ clock });
    await store.acquire('k', 'a', 1_000);
    const peeked = store.peek('k')!;
    expect(peeked).toEqual({ owner: 'a', fencingToken: 1, expiresAt: clock.now() + 1_000 });
    peeked.owner = 'mallory';
    expect(store.peek('k')!.owner).toBe('a');
    await clock.advance(1_000);
    expect(store.peek('k')).toBeUndefined();
  });

  it('draws fencing tokens from one counter for every key', async () => {
    const store = new InMemoryLockStore();
    expect(await store.acquire('a', 'o', 1_000)).toEqual({ acquired: true, fencingToken: 1 });
    expect(await store.acquire('b', 'o', 1_000)).toEqual({ acquired: true, fencingToken: 2 });
    await store.release('a', 'o');
    expect(await store.acquire('a', 'o2', 1_000)).toEqual({ acquired: true, fencingToken: 3 });
  });

  it('sweeps expired locks as it goes, so abandoned keys do not pile up', async () => {
    const clock = new ManualLockClock();
    const store = new InMemoryLockStore({ clock });
    for (let i = 0; i < 999; i++) {
      await store.acquire(`k${i}`, 'o', 10);
    }
    await clock.advance(10);
    await store.acquire('trigger', 'o', 10); // the 1000th acquire sweeps
    expect((store as unknown as { locks: Map<string, unknown> }).locks.size).toBe(1);
  });
});
