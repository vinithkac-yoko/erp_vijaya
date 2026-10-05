import bcrypt from 'bcryptjs';

const COST = 12;
// A real hash of a throwaway string, so a login for an unknown email takes as long as one for a known email.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', COST);

export const MIN_PASSWORD_LENGTH = 10;

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, COST);
}

/** Always runs one bcrypt compare, whether or not there is a stored hash. */
export async function verifyPassword(plain: string, hash: string | null | undefined): Promise<boolean> {
  const ok = await bcrypt.compare(plain, hash ?? DUMMY_HASH);
  return hash ? ok : false;
}
