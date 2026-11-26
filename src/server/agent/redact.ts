/**
 * Passwords belong in the form's password box, never in the chat (SAFETY T19: the conversation store never holds one,
 * and the model never sees one). If a message looks like it contains one, the secret is hidden BEFORE the message is
 * saved or sent to the model, so the saved chat and what the model was told are the same.
 *
 * It looks for the word (password, passwd, pwd, pass) and the value after it. A value counts as a secret when the person
 * wrote "is", ":" or "=" before it, or when it is 6+ characters with a digit or a symbol in it. So "password reset for
 * Ravi" is left alone and "password is sneaky-pass-123" and "pwd abc12345" are not.
 */
const KEYWORD = '(?:password|passwd|pwd|pass)';
const EXPLICIT = new RegExp(`\\b(${KEYWORD})\\b(\\s*(?:is|are|=|:|-)\\s*)(\\S{3,})`, 'gi');
const BARE = new RegExp(`\\b(${KEYWORD})\\b(\\s+)(?=\\S{6,})(?=\\S*[\\d!@#$%^&*_\\-+=])(\\S+)`, 'gi');

export const HIDDEN = '••••••';

export function redactSecrets(text: string): { text: string; hidden: boolean } {
  let hidden = false;
  const swap = (_m: string, kw: string, sep: string) => { hidden = true; return `${kw}${sep}${HIDDEN}`; };
  const out = text.replace(EXPLICIT, swap).replace(BARE, swap);
  return { text: out, hidden };
}
