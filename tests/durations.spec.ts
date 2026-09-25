import { toMs } from '../lib/utils/duration.util.js';
import { durationMs, ttlMs } from '../lib/utils/ttl.util.js';

describe('durations', () => {
  it('reads every unit, fractions included, rounding to whole milliseconds', () => {
    expect(toMs(250)).toBe(250);
    expect(toMs('250ms')).toBe(250);
    expect(toMs('1.5s')).toBe(1_500);
    expect(toMs('15m')).toBe(900_000);
    expect(toMs('6h')).toBe(21_600_000);
    expect(toMs('3d')).toBe(259_200_000);
    expect(toMs('1w')).toBe(604_800_000);
    expect(toMs('0.0004s')).toBe(0);
  });

  it('keeps a fractional number of milliseconds as it is', () => {
    expect(toMs(0.25)).toBe(0.25);
  });

  it.each([NaN, Infinity, -1])('refuses the number %s', (value) => {
    expect(() => toMs(value)).toThrow(`Invalid duration ${value}. Use a non-negative number of milliseconds.`);
  });

  it.each(['1 s', '1S', '-1s', '1e3ms', '.5s', '10', 'ms', '1sec', ''])('refuses the string "%s"', (value) => {
    expect(() => toMs(value as never)).toThrow(`Invalid duration "${value}". Use milliseconds or a string such as "15m" or "3d".`);
  });

  it('names the option in the error, keeping it a TypeError', () => {
    expect(() => durationMs('soon' as never, 'Locks: `wait`')).toThrow(
      new TypeError('Locks: `wait`: Invalid duration "soon". Use milliseconds or a string such as "15m" or "3d".'),
    );
    expect(durationMs(0, 'wait')).toBe(0);
  });

  it('rounds a ttl up to whole milliseconds, and refuses one under 1ms', () => {
    expect(ttlMs(0.1, 'ttl')).toBe(1);
    expect(ttlMs('1.0001s', 'ttl')).toBe(1_000);
    expect(ttlMs(999.2, 'ttl')).toBe(1_000);
    expect(() => ttlMs(0, 'ttl')).toThrow(new RangeError('ttl must be at least 1ms, got 0'));
    // "0.0004s" is 0.4ms before the string is rounded: it rounds to 0, under the minimum.
    expect(() => ttlMs('0.0004s', 'ttl')).toThrow('ttl must be at least 1ms, got "0.0004s"');
  });
});
