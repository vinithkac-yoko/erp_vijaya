import { describe, it, expect } from 'vitest';
import { financialYear, formatDocNumber } from './fy';

describe('financial year', () => {
  it('starts on 1 April in India time', () => {
    expect(financialYear(new Date('2026-04-01T00:00:00+05:30'))).toBe('2627');
    expect(financialYear(new Date('2026-03-31T23:59:59+05:30'))).toBe('2526');
    expect(financialYear(new Date('2027-03-31T23:59:59+05:30'))).toBe('2627');
    expect(financialYear(new Date('2027-04-01T00:00:00+05:30'))).toBe('2728');
  });
  it('uses India time, not UTC (19:00 UTC on 31 Mar is already 1 Apr in Chennai)', () => {
    expect(financialYear(new Date('2026-03-31T19:00:00Z'))).toBe('2627');
  });
  it('handles the century turn', () => {
    expect(financialYear(new Date('2099-05-01T12:00:00Z'))).toBe('9900');
  });
  it('formats document numbers', () => {
    expect(formatDocNumber('JOB', '2627', 31)).toBe('JOB-2627-0031');
    expect(formatDocNumber('PO', '2627', 15)).toBe('PO-2627-0015');
    expect(formatDocNumber('GRN', '2627', 12345)).toBe('GRN-2627-12345');
  });
});
