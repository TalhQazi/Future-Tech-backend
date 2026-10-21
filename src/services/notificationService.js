import { Notification, User } from '../models/index.js';
import { toDTO } from '../lib/http.js';
import { notFound } from '../lib/errors.js';

// In-app notifications for staff and portal users.

export const notifyUsers = async (userIds, payload, session = null) => {
  const unique = [...new Set(userIds.filter(Boolean))];
  if (!unique.length) return [];
  const docs = unique.map(userId => ({
    userId,
    type: payload.type,
    title: payload.title,
    body: payload.body || '',
    link: payload.link,
    entityType: payload.entityType,
    entityId: payload.entityId,
    severity: payload.severity || 'info',
    dedupeKey: payload.dedupeKey ? `${payload.dedupeKey}:${userId}` : undefined
  }));
  try {
    return await Notification.insertMany(docs, { session, ordered: false });
  } catch (err) {
    if (err?.code === 11000 || err?.writeErrors) return []; // duplicates are expected on retries
    throw err;
  }
};

export const notifyRoles = async (locationId, roles, payload, session = null) => {
  const filter = { role: { $in: roles }, status: 'active' };
  if (locationId) filter.$or = [{ locationIds: locationId }, { role: 'admin' }];
  const users = await User.find(filter).select('id role').lean();
  const targets = users.filter(u => roles.includes(u.role));
  return notifyUsers(targets.map(u => u.id), payload, session);
};

export const listNotifications = async (auth, { unreadOnly, limit = 50 }) => {
  const filter = { userId: auth.userId };
  if (unreadOnly) filter.readAt = null;
  const [items, unread] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1 }).limit(Math.min(limit, 200)).lean(),
    Notification.countDocuments({ userId: auth.userId, readAt: null })
  ]);
  return { notifications: toDTO(items), unreadCount: unread };
};

export const markRead = async (auth, id) => {
  const res = await Notification.updateOne({ id, userId: auth.userId }, { $set: { readAt: new Date() } });
  if (res.matchedCount === 0) throw notFound('Notification');
};

export const markAllRead = async (auth) => {
  await Notification.updateMany({ userId: auth.userId, readAt: null }, { $set: { readAt: new Date() } });
};
