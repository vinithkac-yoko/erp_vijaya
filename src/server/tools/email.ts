import nodemailer, { type Transporter } from 'nodemailer';
import { db } from '../db';

/** What reaches the owner's inbox as well as the app: things that need him or tell him something (BUSINESS_FLOW §17). */
const EMAILED = ['PO_PENDING_APPROVAL', 'COUNT_PENDING_APPROVAL', 'RATE_CHANGE', 'NEGATIVE_STOCK_WARNING', 'MIN_LEVEL_BREACH', 'UNEXPLAINED_VARIANCE', 'JOB_VARIANCE'] as const;
const FRESH_MS = 24 * 60 * 60 * 1000;

/** Mail that "went out" when SMTP_URL is "json:" (the tests read it here). Never used in production. */
export const sentMail: { to: string; subject: string; text: string }[] = [];

let cached: { url: string; t: Transporter } | undefined;
function transport(env: NodeJS.ProcessEnv): Transporter | null {
  const url = env.SMTP_URL;
  if (!url) return null; // no email is configured: the app is the only place the owner is told
  if (cached?.url === url) return cached.t;
  const t = url === 'json:' ? nodemailer.createTransport({ jsonTransport: true }) : nodemailer.createTransport(url);
  cached = { url, t };
  return t;
}

/**
 * Emails the owner what is new for him, once. In the app he is told either way. A mail that fails to send changes nothing
 * and is tried again at the next save (for a day); email must never be the reason a save fails.
 */
export async function sendOwnerEmails(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const t = transport(env);
  if (!t) return 0;
  const owners = await db.user.findMany({ where: { role: 'OWNER', isActive: true }, select: { id: true, email: true } });
  const setting = (await db.setting.findUnique({ where: { key: 'notify.owner_email' } }))?.value?.trim();
  const rows = await db.notification.findMany({
    where: { userId: { in: owners.map((o) => o.id) }, emailSentAt: null, type: { in: [...EMAILED] }, createdAt: { gt: new Date(Date.now() - FRESH_MS) } },
    orderBy: { createdAt: 'asc' }, take: 20,
  });
  let sent = 0;
  for (const n of rows) {
    const to = setting || owners.find((o) => o.id === n.userId)?.email;
    if (!to || !to.includes('@')) continue;
    try {
      const link = env.APP_URL ? `\n\nOpen Vijaya Stores: ${env.APP_URL}` : '';
      const info = await t.sendMail({ from: env.NOTIFY_FROM || 'Vijaya Stores <no-reply@vijaya.local>', to, subject: n.title, text: `${n.body}${link}` });
      if (env.SMTP_URL === 'json:') sentMail.push({ to, subject: n.title, text: n.body });
      void info;
      await db.notification.update({ where: { id: n.id }, data: { emailSentAt: new Date() } });
      sent++;
    } catch (err) {
      console.error('[email] could not send:', err instanceof Error ? err.message.slice(0, 200) : 'unknown error');
    }
  }
  return sent;
}
