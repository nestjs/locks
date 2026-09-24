import { ManualLockClock } from '../lib/testing/manual-lock-clock.js';
import { systemClock } from '../lib/utils/system-clock.util.js';

describe('ManualLockClock', () => {
  it('starts on 2026-01-01 (or the given time) and only moves when told to', async () => {
    expect(new ManualLockClock().now()).toBe(Date.UTC(2026, 0, 1));
    const clock = new ManualLockClock(new Date('2026-09-23T02:00:00Z'));
    expect(clock.now()).toBe(Date.parse('2026-09-23T02:00:00Z'));
    await clock.advance('1h');
    expect(clock.now()).toBe(Date.parse('2026-09-23T03:00:00Z'));
    await expect(clock.advance('an hour' as never)).rejects.toThrow('Invalid duration "an hour"');
  });

  it('fires the timers that fall due, in order, each at its own time', async () => {
    const clock = new ManualLockClock(0);
    const fired: string[] = [];
    clock.setTimeout(() => fired.push(`b@${clock.now()}`), 200);
    clock.setTimeout(() => fired.push(`a@${clock.now()}`), 100);
    const cancelled = clock.setTimeout(() => fired.push('cancelled'), 150);
    clock.setTimeout(() => fired.push(`late@${clock.now()}`), 1_000);
    clock.clearTimeout(cancelled);
    await clock.advance(500);
    expect(fired).toEqual(['a@100', 'b@200']);
    expect(clock.now()).toBe(500);
    expect(clock.pendingTimers).toBe(1);
  });

  it('fires timers that timers set, when they fall due within the advance', async () => {
    const clock = new ManualLockClock(0);
    const fired: number[] = [];
    const every = () => {
      fired.push(clock.now());
      clock.setTimeout(every, 100);
    };
    clock.setTimeout(every, 100);
    await clock.advance(350);
    expect(fired).toEqual([100, 200, 300]);
  });

  it('lets promise chains a timer starts settle before the next timer fires', async () => {
    const clock = new ManualLockClock(0);
    const order: string[] = [];
    clock.setTimeout(() => {
      void Promise.resolve()
        .then(() => Promise.resolve())
        .then(() => order.push('first chain done'));
    }, 10);
    clock.setTimeout(() => order.push('second timer'), 20);
    await clock.advance(30);
    expect(order).toEqual(['first chain done', 'second timer']);
  });
});

describe('systemClock', () => {
  it("unref()s its timers and caps them at Node's largest delay", () => {
    const handle = systemClock.setTimeout(() => {}, 2 ** 40) as NodeJS.Timeout;
    try {
      expect(handle.hasRef()).toBe(false);
    } finally {
      systemClock.clearTimeout(handle);
    }
  });

  it('keeps the process alive for a timer set with { ref: true }: a wait the caller awaits', () => {
    const handle = systemClock.setTimeout(() => {}, 1_000, { ref: true }) as NodeJS.Timeout;
    try {
      expect(handle.hasRef()).toBe(true);
    } finally {
      systemClock.clearTimeout(handle);
    }
  });
});
