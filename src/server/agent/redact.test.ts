import { describe, expect, it } from 'vitest';
import { HIDDEN, redactSecrets } from './redact';

describe('redactSecrets', () => {
  it.each([
    'create a login for Ravi, password is sneaky-pass-123',
    'password: Welcome1',
    'PASSWORD = abc',
    'pwd abc12345 for him',
    'password xK9!mz2pq',
    'the password is hunter2, and the login is ravi@x.test',
  ])('hides it in %j', (input) => {
    const r = redactSecrets(input);
    expect(r.hidden).toBe(true);
    expect(r.text).not.toMatch(/sneaky|Welcome1|abc12345|xK9|hunter2/);
    expect(r.text.split(HIDDEN)).toHaveLength(2); // exactly one thing hidden
  });

  it.each([
    'password reset for Ravi', 'Ravi forgot his password', 'please change the password', 'what is the password rule', 'passport number 123',
    'create a login for Ravi', 'pass the cores to job 31', 'compass 12345', 'issue wire to job 31',
  ])('leaves ordinary words alone: %j', (input) => {
    expect(redactSecrets(input)).toEqual({ text: input, hidden: false });
  });
});
