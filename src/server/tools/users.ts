import { z } from 'zod';
import { ToolError } from '../errors';
import { hashPassword, MIN_PASSWORD_LENGTH } from '../auth/password';
import { defineTool } from './define';
import { id, pick, req, tidy } from './helpers';

const ROLE_LABEL = { OWNER: 'Owner', STOREKEEPER: 'Storekeeper' } as const;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const password = z.string({ required_error: 'Type a password.' }).min(MIN_PASSWORD_LENGTH, `The password needs at least ${MIN_PASSWORD_LENGTH} characters.`).max(100, 'That password is too long.');

// ── list_users ─────────────────────────────────────────────────────────────────────────────────────
export const listUsers = defineTool({
  name: 'list_users', kind: 'read', roles: ['OWNER'],
  input: z.object({}),
  handler: async (ctx) => {
    const users = await ctx.db.user.findMany({ orderBy: [{ isActive: 'desc' }, { name: 'asc' }], select: { id: true, name: true, email: true, role: true, isActive: true } });
    // never the password hash: it is not even selected
    return { rows: users.map((u) => ({ id: u.id, name: u.name, login: u.email, role: ROLE_LABEL[u.role], active: u.isActive })) };
  },
  view: (d) => [{
    kind: 'table',
    columns: [{ key: 'name', label: 'Name' }, { key: 'role', label: 'Role' }, { key: 'login', label: 'Login' }, { key: 'status', label: 'Status' }],
    rows: d.rows.map((r) => ({ name: r.name, role: r.role, login: r.login, status: r.active ? 'Active' : 'Stopped' })),
  }],
});

// ── create_user ────────────────────────────────────────────────────────────────────────────────────
export const createUser = defineTool({
  name: 'create_user', kind: 'write', roles: ['OWNER'],
  input: z.object({
    name: req('name', 100),
    login: z.string({ required_error: 'Type the email.' }).trim().toLowerCase().min(1, 'Type the email.').max(150),
    role: pick(['STOREKEEPER', 'OWNER'] as const, 'Choose storekeeper or owner.'),
    password,
  }),
  agentHidden: ['password'],
  form: {
    title: 'Add a login', verb: 'Add login', intro: 'You choose the first password. Tell the person, and they can ask you to change it later.',
    fields: [
      { name: 'name', label: 'Full name', type: 'text', required: true },
      { name: 'login', label: 'Email', type: 'email', required: true, hint: 'They log in with this.', autoComplete: 'off' },
      { name: 'role', label: 'Role', type: 'select', required: true, options: [{ value: 'STOREKEEPER', label: 'Storekeeper' }, { value: 'OWNER', label: 'Owner' }] },
      { name: 'password', label: 'First password', type: 'password', required: true, hint: `At least ${MIN_PASSWORD_LENGTH} characters.`, autoComplete: 'new-password' },
    ],
  },
  stamp: 'LOGIN ADDED',
  describe: (a) => [`${a.name} — ${a.role}`, `Logs in with ${a.login}`],
  handler: async (ctx, input) => {
    if (!EMAIL.test(input.login)) throw new ToolError('INVALID_EMAIL', 'That does not look like an email address.', undefined, 'login');
    if (await ctx.db.user.findUnique({ where: { email: input.login }, select: { id: true } })) throw new ToolError('EMAIL_EXISTS', 'Someone already has that email.', undefined, 'login');
    const u = await ctx.db.user.create({ data: { name: tidy(input.name), email: input.login, role: input.role, passwordHash: await hashPassword(input.password) } });
    return { data: { id: u.id, name: u.name, role: ROLE_LABEL[u.role] }, audit: { entityType: 'User', entityId: u.id, action: 'CREATE', after: { name: u.name, login: u.email, role: ROLE_LABEL[u.role] } } };
  },
});

// ── reset_user_password ────────────────────────────────────────────────────────────────────────────
export const resetUserPassword = defineTool({
  name: 'reset_user_password', kind: 'write', roles: ['OWNER'],
  input: z.object({ userId: id('person'), password }),
  agentHidden: ['password'],
  form: {
    title: 'New password for someone', verb: 'Save new password', intro: 'For someone who forgot theirs. Tell them the new password.',
    fields: [
      { name: 'userId', label: 'Person', type: 'user', required: true },
      { name: 'password', label: 'New password', type: 'password', required: true, hint: `At least ${MIN_PASSWORD_LENGTH} characters.`, autoComplete: 'new-password' },
    ],
  },
  stamp: 'PASSWORD CHANGED',
  describe: (a) => [`New password set for ${a.name}`],
  handler: async (ctx, input) => {
    const u = await ctx.db.user.findUnique({ where: { id: input.userId }, select: { id: true, name: true } });
    if (!u) throw new ToolError('NOT_FOUND', "Couldn't find that person.", undefined, 'userId');
    await ctx.db.user.update({ where: { id: u.id }, data: { passwordHash: await hashPassword(input.password) } });
    // the audit says THAT it changed, never to what
    return { data: { name: u.name }, audit: { entityType: 'User', entityId: u.id, action: 'UPDATE', after: { name: u.name, credentialChanged: true } } };
  },
});

// ── deactivate_user ────────────────────────────────────────────────────────────────────────────────
export const deactivateUser = defineTool({
  name: 'deactivate_user', kind: 'write', roles: ['OWNER'],
  input: z.object({ userId: id('person') }),
  form: {
    title: 'Stop a login', verb: 'Stop this login', intro: 'They can no longer log in. Their past work stays in the history. The last owner cannot be stopped.',
    fields: [{ name: 'userId', label: 'Person', type: 'user', required: true }],
  },
  stamp: 'LOGIN STOPPED',
  describe: (a) => [`${a.name} can no longer log in.`],
  handler: async (ctx, input) => {
    const u = await ctx.db.user.findUnique({ where: { id: input.userId } });
    if (!u) throw new ToolError('NOT_FOUND', "Couldn't find that person.", undefined, 'userId');
    if (!u.isActive) throw new ToolError('ALREADY_INACTIVE', `${u.name} is already stopped.`, undefined, 'userId');
    if (u.id === ctx.session.userId) throw new ToolError('USER_SELF', "You can't stop your own login.", undefined, 'userId');
    if (u.role === 'OWNER') {
      const others = await ctx.db.user.count({ where: { role: 'OWNER', isActive: true, NOT: { id: u.id } } });
      if (others === 0) throw new ToolError('LAST_OWNER', 'That is the last active owner. Add another owner first.', undefined, 'userId');
    }
    await ctx.db.user.update({ where: { id: u.id }, data: { isActive: false } });
    return { data: { name: u.name }, audit: { entityType: 'User', entityId: u.id, action: 'UPDATE', before: { name: u.name, active: true }, after: { name: u.name, active: false } } };
  },
});
