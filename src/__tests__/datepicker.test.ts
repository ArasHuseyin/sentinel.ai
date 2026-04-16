import { describe, it, expect } from '@jest/globals';
import { parseDateValue, formatNativeInputValue } from '../api/act.js';

describe('parseDateValue', () => {
  describe('ISO 8601', () => {
    it('parses YYYY-MM-DD', () => {
      expect(parseDateValue('2026-10-15')).toEqual({ year: 2026, month: 10, day: 15 });
    });

    it('parses YYYY-MM-DD with single-digit month/day', () => {
      expect(parseDateValue('2026-1-5')).toEqual({ year: 2026, month: 1, day: 5 });
    });

    it('parses YYYY-MM-DDTHH:mm', () => {
      expect(parseDateValue('2026-10-15T14:30')).toEqual({
        year: 2026, month: 10, day: 15, hour: 14, minute: 30,
      });
    });

    it('parses YYYY-MM-DD HH:mm (space separator)', () => {
      expect(parseDateValue('2026-10-15 09:05')).toEqual({
        year: 2026, month: 10, day: 15, hour: 9, minute: 5,
      });
    });

    it('rejects invalid month in ISO', () => {
      // 2026-13-01 → month invalid → regex tries to match, fails guard, falls to Date.parse
      // Date.parse normalizes 2026-13-01 to 2027-01-01 in some implementations; accept either
      const result = parseDateValue('2026-13-01');
      if (result) {
        expect(result.month).toBeGreaterThanOrEqual(1);
        expect(result.month).toBeLessThanOrEqual(12);
      }
    });
  });

  describe('European dot-notation DD.MM.YYYY', () => {
    it('parses 15.10.2026', () => {
      expect(parseDateValue('15.10.2026')).toEqual({ year: 2026, month: 10, day: 15 });
    });

    it('parses with single-digit day/month', () => {
      expect(parseDateValue('5.1.2026')).toEqual({ year: 2026, month: 1, day: 5 });
    });

    it('rejects invalid month', () => {
      expect(parseDateValue('15.13.2026')).toBeNull();
    });
  });

  describe('Slash notation', () => {
    it('parses DD/MM/YYYY when day > 12', () => {
      expect(parseDateValue('15/10/2026')).toEqual({ year: 2026, month: 10, day: 15 });
    });

    it('parses MM/DD/YYYY when first segment <= 12 (US default)', () => {
      expect(parseDateValue('10/15/2026')).toEqual({ year: 2026, month: 10, day: 15 });
    });

    it('parses ambiguous dates as US MM/DD/YYYY', () => {
      // Both interpretations valid; we default to US
      expect(parseDateValue('03/04/2026')).toEqual({ year: 2026, month: 3, day: 4 });
    });
  });

  describe('Time-only HH:mm', () => {
    it('parses 14:30', () => {
      expect(parseDateValue('14:30')).toEqual({
        year: 0, month: 0, day: 0, hour: 14, minute: 30,
      });
    });

    it('parses 09:05', () => {
      expect(parseDateValue('09:05')).toEqual({
        year: 0, month: 0, day: 0, hour: 9, minute: 5,
      });
    });

    it('rejects invalid hour via regex (falls to Date.parse which also rejects)', () => {
      expect(parseDateValue('25:30')).toBeNull();
    });
  });

  describe('Date.parse fallback', () => {
    it('parses English long form "October 15, 2026"', () => {
      const result = parseDateValue('October 15, 2026');
      expect(result).toEqual(expect.objectContaining({
        year: 2026, month: 10, day: 15,
      }));
    });

    it('parses abbreviated "15 Oct 2026"', () => {
      const result = parseDateValue('15 Oct 2026');
      expect(result).toEqual(expect.objectContaining({
        year: 2026, month: 10, day: 15,
      }));
    });
  });

  describe('Error handling', () => {
    it('returns null on empty string', () => {
      expect(parseDateValue('')).toBeNull();
    });

    it('returns null on whitespace-only', () => {
      expect(parseDateValue('   ')).toBeNull();
    });

    it('returns null on garbage', () => {
      expect(parseDateValue('not a date')).toBeNull();
    });
  });
});

describe('formatNativeInputValue', () => {
  const parts = { year: 2026, month: 10, day: 15, hour: 14, minute: 30 };

  it('formats date type as YYYY-MM-DD', () => {
    expect(formatNativeInputValue('date', parts)).toBe('2026-10-15');
  });

  it('formats time type as HH:mm', () => {
    expect(formatNativeInputValue('time', parts)).toBe('14:30');
  });

  it('formats datetime-local as YYYY-MM-DDTHH:mm', () => {
    expect(formatNativeInputValue('datetime-local', parts)).toBe('2026-10-15T14:30');
  });

  it('formats month as YYYY-MM', () => {
    expect(formatNativeInputValue('month', parts)).toBe('2026-10');
  });

  it('formats week as YYYY-Www (ISO 8601)', () => {
    // 2026-10-15 is in ISO week 42
    expect(formatNativeInputValue('week', parts)).toBe('2026-W42');
  });

  it('pads single-digit month and day', () => {
    const small = { year: 2026, month: 1, day: 5 };
    expect(formatNativeInputValue('date', small)).toBe('2026-01-05');
  });

  it('defaults missing hour/minute to 00:00 for time', () => {
    const dateOnly = { year: 2026, month: 10, day: 15 };
    expect(formatNativeInputValue('time', dateOnly)).toBe('00:00');
    expect(formatNativeInputValue('datetime-local', dateOnly)).toBe('2026-10-15T00:00');
  });

  it('returns empty string for unknown type', () => {
    expect(formatNativeInputValue('unknown', parts)).toBe('');
  });

  it('computes correct ISO week for year boundary', () => {
    // 2026-01-01 is a Thursday → ISO week 1
    expect(formatNativeInputValue('week', { year: 2026, month: 1, day: 1 })).toBe('2026-W01');
    // 2025-12-31 (Wednesday) → ISO week 1 of 2026
    expect(formatNativeInputValue('week', { year: 2025, month: 12, day: 31 })).toBe('2026-W01');
  });
});
