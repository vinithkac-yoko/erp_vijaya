/**
 * First-run users. `--if-empty` (used on every Railway start) seeds only when there are no users at all,
 * so a restart never touches real accounts.
 *
 * Names and emails come from SEED_* variables (see .env.example). Passwords too, when set; otherwise strong
 * ones are generated and printed ONCE below — copy them from the log, then they are gone.
 */
import { randomInt } from 'node:crypto';
import { PrismaClient, type UserRole } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();
const ifEmpty = process.argv.includes('--if-empty');

// No look-alike characters (0/o, 1/l/i), so a password read off a screen can be typed.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
function generatePassword(): string {
  const group = () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  return [group(), group(), group(), group()].join('-');
}

interface Seed { role: UserRole; name: string; email: string; password: string; generated: boolean }

function seedUser(role: UserRole, prefix: 'OWNER' | 'STOREKEEPER', defaults: { name: string; email: string }): Seed {
  const supplied = process.env[`SEED_${prefix}_PASSWORD`]?.trim();
  return {
    role,
    name: process.env[`SEED_${prefix}_NAME`]?.trim() || defaults.name,
    email: (process.env[`SEED_${prefix}_EMAIL`]?.trim() || defaults.email).toLowerCase(),
    password: supplied || generatePassword(),
    generated: !supplied,
  };
}

async function main() {
  if (ifEmpty && (await prisma.user.count()) > 0) {
    console.log('[seed] Users already exist. Nothing to do.');
    return;
  }

  const seeds = [
    seedUser('OWNER', 'OWNER', { name: 'Owner', email: 'owner@vijaya.local' }),
    seedUser('STOREKEEPER', 'STOREKEEPER', { name: 'Storekeeper', email: 'storekeeper@vijaya.local' }),
  ];
  if (seeds[0]?.email === seeds[1]?.email) throw new Error('The owner and the storekeeper need different emails.');

  for (const s of seeds) {
    if (s.password.length < 10) throw new Error(`SEED password for ${s.email} must be at least 10 characters.`);
    const passwordHash = await bcrypt.hash(s.password, 12);
    await prisma.user.upsert({
      where: { email: s.email },
      create: { name: s.name, email: s.email, role: s.role, passwordHash },
      update: { name: s.name, role: s.role, passwordHash, isActive: true },
    });
  }

  console.log('[seed] Created users:');
  for (const s of seeds) console.log(`[seed]   ${s.role.padEnd(11)} ${s.name} <${s.email}>`);
  const generated = seeds.filter((s) => s.generated);
  if (generated.length > 0) {
    console.log('[seed] ──────────────────────────────────────────────────────────────');
    console.log('[seed] FIRST PASSWORDS (shown once — copy them now):');
    for (const s of generated) console.log(`[seed]   ${s.email}  →  ${s.password}`);
    console.log('[seed] ──────────────────────────────────────────────────────────────');
  }
}

main().catch((e) => { console.error('[seed] Failed:', e instanceof Error ? e.message : e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
