import { describe, it, expect } from 'vitest';
import { parseServerTime } from '../lib/server-time';

// vitest.config.ts runs these tests in Europe/Madrid (UTC+2 on 2026-10-22), so a value
// read as local time instead of UTC is two hours off.
describe('parseServerTime', () => {
  it('runs in a zone that is not UTC (otherwise the tests below prove nothing)', () => {
    expect(new Date('2026-10-22T05:17:41Z').getHours()).toBe(7);
  });

  it('reads a zone-less SQLite timestamp as UTC', () => {
    const date = parseServerTime('2026-10-22 05:17:41');
    expect(date.toISOString()).toBe('2026-10-22T05:17:41.000Z');
    expect(date.getHours()).toBe(7);
    expect(new Date('2026-10-22 05:17:41').getHours()).toBe(5); // what the card showed before
  });

  it('reads a zone-less value with a T separator or fractional seconds as UTC too', () => {
    expect(parseServerTime('2026-10-22T05:17:41').toISOString()).toBe('2026-10-22T05:17:41.000Z');
    expect(parseServerTime('2026-10-22 05:17:41.250').toISOString()).toBe('2026-10-22T05:17:41.250Z');
  });

  it('keeps a value that names its zone', () => {
    expect(parseServerTime('2026-10-22T05:17:41.000Z').toISOString()).toBe('2026-10-22T05:17:41.000Z');
    expect(parseServerTime('2026-10-22T07:17:41+02:00').toISOString()).toBe('2026-10-22T05:17:41.000Z');
  });

  it('gives an invalid date for a value that is not a timestamp, never the current time', () => {
    expect(Number.isNaN(parseServerTime('not a date').getTime())).toBe(true);
  });
});
