import { describe, expect, it } from 'vitest';
import { IDLE_LIMIT_MS, idleExpired, needsTouch, sessionStillGood } from './idle';

const at = (h: number) => new Date(Date.UTC(2026, 9, 7, 0, 0, 0) + h * 3_600_000);

describe('idle log-out (T12)', () => {
  it('the storekeeper is logged out after 12 hours without use, not before', () => {
    expect(idleExpired('STOREKEEPER', at(0), at(11.9))).toBe(false);
    expect(idleExpired('STOREKEEPER', at(0), at(12.1))).toBe(true);
  });
  it('the owner stays logged in for 30 days', () => {
    expect(idleExpired('OWNER', at(0), at(24 * 29))).toBe(false);
    expect(idleExpired('OWNER', at(0), at(24 * 31))).toBe(true);
    expect(IDLE_LIMIT_MS.OWNER).toBeGreaterThan(IDLE_LIMIT_MS.STOREKEEPER);
  });
  it('someone who has never been seen is not expired (the first request writes it)', () => {
    expect(idleExpired('STOREKEEPER', null, at(100))).toBe(false);
    expect(needsTouch(null, at(0))).toBe(true);
  });
  it('activity is written at most every five minutes', () => {
    expect(needsTouch(at(0), new Date(at(0).getTime() + 4 * 60_000))).toBe(false);
    expect(needsTouch(at(0), new Date(at(0).getTime() + 6 * 60_000))).toBe(true);
  });

  it('a password reset ends the sessions made before it, and only those', () => {
    const user = { role: 'STOREKEEPER' as const, lastActiveAt: at(0), sessionEpoch: 1 };
    expect(sessionStillGood(user, 0, at(1))).toBe(false);          // the old cookie
    expect(sessionStillGood(user, 1, at(1))).toBe(true);           // a login made after the reset
    expect(sessionStillGood({ ...user, sessionEpoch: 0 }, undefined, at(1))).toBe(true); // a cookie from before the counter existed
    expect(sessionStillGood(user, 1, at(13))).toBe(false);         // and a long silence still ends it
  });
});
