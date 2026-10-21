import { AuditEvent } from '../models/index.js';
import { redactObject } from '../lib/redact.js';

// Append-only audit history for security, financial, permission, safety,
// approval, override and AI events. Writes join the caller's transaction.
export const audit = async (req, entry, session = null) => {
  const actor = req?.auth?.user;
  const doc = {
    eventType: entry.eventType,
    category: entry.category || 'operational',
    entityType: entry.entityType,
    entityId: entry.entityId,
    locationId: entry.locationId,
    actorId: entry.actorId || actor?.id || 'system',
    actorRole: entry.actorRole || actor?.role || 'system',
    actorName: entry.actorName || actor?.name,
    action: entry.action,
    reason: entry.reason,
    before: entry.before ? redactObject(entry.before) : undefined,
    after: entry.after ? redactObject(entry.after) : undefined,
    metadata: entry.metadata ? redactObject(entry.metadata) : undefined,
    ipAddress: req?.ip,
    correlationId: req?.correlationId
  };
  const [created] = await AuditEvent.create([doc], { session });
  return created;
};
