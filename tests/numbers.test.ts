import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { nextCode, nextNumber } from '@/server/tools/numbers';
import { prisma, resetDb } from './helpers/db';

beforeEach(() => resetDb());
afterAll(() => prisma.$disconnect());

const get = (type: Parameters<typeof nextNumber>[1], date?: Date) => prisma.$transaction((tx) => nextNumber(tx, type, date));

describe('document numbers (BUSINESS_FLOW §18)', () => {
  it('count up per type in the Indian financial year: JOB-2627-0001, 0002…', async () => {
    const d = new Date('2026-10-07T12:00:00+05:30');
    expect(await get('JOB', d)).toBe('JOB-2627-0001');
    expect(await get('JOB', d)).toBe('JOB-2627-0002');
    expect(await get('PO', d)).toBe('PO-2627-0001'); // each type has its own count
    expect(await get('GRN', d)).toBe('GRN-2627-0001');
    expect(await get('CNT', d)).toBe('CNT-2627-0001');
    expect(await get('SCS', d)).toBe('SCS-2627-0001');
  });

  it('start again on 1 April, in India time', async () => {
    expect(await get('PO', new Date('2027-03-31T23:00:00+05:30'))).toBe('PO-2627-0001');
    expect(await get('PO', new Date('2027-04-01T00:30:00+05:30'))).toBe('PO-2728-0001');
    expect(await get('PO', new Date('2027-03-31T20:00:00Z'))).toBe('PO-2728-0002'); // 20:00 UTC is already 1 April in Chennai
    expect(await get('PO', new Date('2027-03-31T10:00:00Z'))).toBe('PO-2627-0002');
  });

  it('never duplicate under concurrent use: 30 at once get 1…30 exactly', async () => {
    const d = new Date('2026-10-07T12:00:00+05:30');
    const numbers = await Promise.all(Array.from({ length: 30 }, () => get('JOB', d)));
    expect(new Set(numbers).size).toBe(30);
    expect(numbers.sort()).toEqual(Array.from({ length: 30 }, (_, i) => `JOB-2627-${String(i + 1).padStart(4, '0')}`));
  });

  it('a rolled-back save leaves no gap', async () => {
    const d = new Date('2026-10-07T12:00:00+05:30');
    expect(await get('JOB', d)).toBe('JOB-2627-0001');
    await expect(prisma.$transaction(async (tx) => { await nextNumber(tx, 'JOB', d); throw new Error('save failed'); })).rejects.toThrow('save failed');
    expect(await get('JOB', d)).toBe('JOB-2627-0002');
  });

  it('internal codes are separate and never reset', async () => {
    expect(await prisma.$transaction((tx) => nextCode(tx, 'MAT'))).toBe('MAT-0001');
    expect(await prisma.$transaction((tx) => nextCode(tx, 'MAT'))).toBe('MAT-0002');
    expect(await prisma.$transaction((tx) => nextCode(tx, 'PTY'))).toBe('PTY-0001');
  });
});
