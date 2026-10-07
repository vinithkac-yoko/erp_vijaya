import { describe, expect, it, vi } from 'vitest';
import { protectConsole, redactLine } from './log-redact';

describe('logs never carry a secret (T19)', () => {
  it('hides API keys, tokens and authorization or cookie headers', () => {
    expect(redactLine('key sk-ant-api03-AbCdEf123456789_xyz used')).toBe('key sk-ant-[hidden] used');
    expect(redactLine('Authorization: Bearer eyJhbGciOi.payload.sig')).not.toMatch(/eyJ/);
    expect(redactLine('headers {"cookie":"vijaya_session=Fe26.2**abc; theme=dark"}')).not.toMatch(/Fe26/);
    expect(redactLine('set-cookie: vijaya_session=Fe26.2**abc; Path=/')).not.toMatch(/Fe26/);
    expect(redactLine('x-api-key: abc123def456')).not.toMatch(/abc123/);
  });
  it('hides environment secrets and the password inside a connection string', () => {
    expect(redactLine('ANTHROPIC_API_KEY=sk-ant-zzzzzzzzzz1 SESSION_SECRET=hunter2hunter2 ok')).toBe('ANTHROPIC_API_KEY=[hidden] SESSION_SECRET=[hidden] ok');
    expect(redactLine('connecting postgresql://vijaya:s3cret@db.internal:5432/vijaya')).toBe('connecting postgresql://vijaya:[hidden]@db.internal:5432/vijaya');
    expect(redactLine('SEED_OWNER_PASSWORD=correct-horse')).toBe('SEED_OWNER_PASSWORD=[hidden]');
    expect(redactLine('smtp smtps://user:pa55word@smtp.example.com:465')).not.toMatch(/pa55word/);
  });
  it('hides a password or hash inside JSON, and leaves ordinary words alone', () => {
    expect(redactLine('{"name":"Ravi","password":"abc12345","role":"STOREKEEPER"}')).toBe('{"name":"Ravi","password":"[hidden]","role":"STOREKEEPER"}');
    expect(redactLine('{"passwordHash":"$2b$12$abcdefghijk"}')).not.toMatch(/\$2b/);
    expect(redactLine('Password reset for Ravi on 12 Sep; 40 pieces issued to job 31')).toBe('Password reset for Ravi on 12 Sep; 40 pieces issued to job 31');
  });
  it('console is wrapped once: strings, errors and objects are all cleaned before they are printed', () => {
    const seen: string[] = [];
    const fake = { log: (...a: unknown[]) => seen.push(a.join(' ')), info: () => undefined, warn: () => undefined, error: (...a: unknown[]) => seen.push(a.map(String).join(' ')) } as unknown as Console;
    protectConsole(fake); protectConsole(fake);
    fake.log('token sk-ant-api03-ABCDEFGH12345678');
    fake.error(new Error('failed with ANTHROPIC_API_KEY=sk-ant-ABCDEFGH12345678'));
    fake.log({ cookie: 'vijaya_session=Fe26.2**abc' });
    expect(seen.join('\n')).not.toMatch(/ABCDEFGH|Fe26/);
    expect(seen).toHaveLength(3);
    void vi;
  });
});
