import type { NotificationType } from '@prisma/client';
import { db } from '../db';
import type { Db } from './types';

export interface NotifyArgs { type: NotificationType; title: string; body: string; entityType?: string; entityId?: string }

/** The people who approve things. Notifications are written in the same transaction as the thing they are about. */
export const ownerIds = async (client: Db) =>
  (await client.user.findMany({ where: { role: 'OWNER', isActive: true }, select: { id: true } })).map((u) => u.id);

/** Tell these people something. Skips the person who just did it (they know). */
export async function notify(client: Db, userIds: (string | null | undefined)[], n: NotifyArgs, except?: string): Promise<void> {
  const to = [...new Set(userIds.filter((u): u is string => !!u && u !== except))];
  for (const userId of to) await client.notification.create({ data: { userId, ...n } });
}

/** What the opening card tells a person who was away: their own unread notices, newest first. */
export const notifications = {
  async unread(userId: string, types?: NotificationType[], take = 5) {
    const rows = await db.notification.findMany({ where: { userId, readAt: null, ...(types ? { type: { in: types } } : {}) }, orderBy: { createdAt: 'desc' }, take });
    return rows.map((r) => ({ id: r.id, type: r.type, title: r.title, body: r.body }));
  },
  async markRead(userId: string, ids: string[]) {
    if (ids.length) await db.notification.updateMany({ where: { userId, id: { in: ids }, readAt: null }, data: { readAt: new Date() } });
  },
};
