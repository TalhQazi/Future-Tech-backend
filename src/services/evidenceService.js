import crypto from 'crypto';
import { withTransaction } from '../config/db.js';
import { Evidence, Finding, RepairOrder, ForumThread } from '../models/index.js';
import { storage } from '../adapters/storage.js';
import { ALLOWED_TYPES, sniffMatches } from '../middleware/upload.js';
import { audit } from './audit.js';
import { findRoForAccess, assertLocation } from '../security/access.js';
import { notFound, badRequest, conflict, forbidden } from '../lib/errors.js';
import { toDTO } from '../lib/http.js';

export const uploadEvidence = async (req, file, meta) => {
  if (!file) throw badRequest('A file is required');
  const rule = ALLOWED_TYPES[file.mimetype];
  if (!rule || !sniffMatches(file.mimetype, file.buffer)) throw badRequest('File content does not match its declared type');

  if (meta.clientId) {
    const existing = await Evidence.findOne({ clientId: meta.clientId }).lean();
    if (existing) return { evidence: toDTO(existing), duplicate: true }; // offline queue replay
  }

  let ro = null;
  if (meta.roId) ro = await findRoForAccess(req.auth, meta.roId);
  let finding = null;
  if (meta.findingId) {
    finding = await Finding.findOne({ id: meta.findingId }).lean();
    if (!finding) throw notFound('Finding');
    if (ro && finding.roId !== ro.id) throw badRequest('Finding does not belong to this repair order');
    if (!ro) ro = await findRoForAccess(req.auth, finding.roId);
    if (finding.locked) throw conflict('This finding is locked. Attach evidence to a correction instead.', 'FINDINGS_LOCKED');
  }
  if (meta.forumThreadId && !(await ForumThread.exists({ id: meta.forumThreadId }))) throw notFound('Forum thread');
  if (!ro && !meta.forumThreadId && !meta.sessionId) throw badRequest('Evidence must be linked to a repair order, finding, diagnostic session or forum thread');

  let superseded = null;
  if (meta.supersedesId) {
    superseded = await Evidence.findOne({ id: meta.supersedesId }).lean();
    if (!superseded) throw notFound('Evidence to supersede');
    if (superseded.status !== 'current') throw conflict('That evidence was already superseded');
    if (ro && superseded.roId && superseded.roId !== ro.id) throw badRequest('Superseded evidence belongs to another repair order');
  }

  const sha256 = crypto.createHash('sha256').update(file.buffer).digest('hex');
  const stored = await storage.put({
    buffer: file.buffer,
    contentType: file.mimetype,
    filename: file.originalname,
    metadata: { sha256, roId: ro?.id, uploadedBy: req.auth.userId }
  });

  const evidence = await withTransaction(async (session) => {
    const [created] = await Evidence.create([{
      kind: meta.kind || rule.kind,
      contentType: file.mimetype,
      sizeBytes: file.size,
      sha256,
      storage: stored,
      originalName: (file.originalname || '').slice(0, 200),
      caption: meta.caption || '',
      roId: ro?.id,
      vehicleId: ro?.vehicleId || meta.vehicleId,
      findingId: finding?.id,
      inspectionId: finding?.inspectionId,
      sessionId: meta.sessionId,
      forumThreadId: meta.forumThreadId,
      locationId: ro?.locationId,
      visibility: meta.forumThreadId ? 'internal' : (meta.visibility || 'customer'),
      capturedAt: meta.capturedAt ? new Date(meta.capturedAt) : new Date(),
      capturedBy: req.auth.userId,
      capturedByName: req.auth.user.name,
      clientId: meta.clientId,
      supersedesId: superseded?.id
    }], { session });
    if (finding) await Finding.updateOne({ id: finding.id, locked: false }, { $addToSet: { evidenceIds: created.id } }, { session });
    if (superseded) {
      await Evidence.updateOne({ id: superseded.id, status: 'current' }, { $set: { status: 'superseded', supersededById: created.id } }, { session });
      if (superseded.findingId) {
        await Finding.updateOne({ id: superseded.findingId, locked: false }, { $addToSet: { evidenceIds: created.id } }, { session });
      }
    }
    if (meta.forumThreadId) await ForumThread.updateOne({ id: meta.forumThreadId }, { $addToSet: { evidenceIds: created.id } }, { session });
    await audit(req, {
      eventType: superseded ? 'EVIDENCE_SUPERSEDED' : 'EVIDENCE_CAPTURED', category: 'data', entityType: 'Evidence', entityId: created.id, locationId: ro?.locationId,
      action: `${superseded ? `New version of evidence ${superseded.id}` : 'Captured evidence'} (${created.kind}, ${created.sizeBytes} bytes, sha256 ${sha256.slice(0, 12)}…)`,
      reason: meta.reason
    }, session);
    return created;
  });
  return { evidence: toDTO(evidence.toObject()), duplicate: false };
};

const assertEvidenceAccess = async (auth, evidence) => {
  if (evidence.roId) {
    const ro = await RepairOrder.findOne({ id: evidence.roId }).select('id locationId customerId').lean();
    if (!ro) throw notFound('Evidence');
    if (auth.role === 'customer') {
      if (ro.customerId !== auth.customerId || evidence.visibility !== 'customer') throw forbidden();
      if (evidence.findingId) {
        const f = await Finding.findOne({ id: evidence.findingId }).select('locked').lean();
        if (!f?.locked) throw forbidden(); // only published (locked) inspection evidence
      }
    } else {
      assertLocation(auth, ro.locationId);
    }
    return;
  }
  if (auth.role === 'customer') throw forbidden();
};

export const getEvidence = async (auth, id) => {
  const ev = await Evidence.findOne({ id }).lean();
  if (!ev) throw notFound('Evidence');
  await assertEvidenceAccess(auth, ev);
  return toDTO(ev);
};

export const streamEvidence = async (auth, id, res) => {
  const ev = await Evidence.findOne({ id }).lean();
  if (!ev) throw notFound('Evidence');
  await assertEvidenceAccess(auth, ev);
  const stream = await storage.openRead(ev.storage);
  res.setHeader('Content-Type', ev.contentType);
  res.setHeader('Content-Length', String(ev.sizeBytes));
  res.setHeader('Cache-Control', 'private, max-age=3600, immutable');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `inline; filename="evidence-${ev.id}"`);
  res.setHeader('ETag', `"${ev.sha256}"`);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
};

export const listEvidence = async (auth, { roId, findingId, vehicleId }) => {
  const filter = {};
  if (roId) {
    const ro = await findRoForAccess(auth, roId);
    filter.roId = ro.id;
  } else if (findingId) {
    const f = await Finding.findOne({ id: findingId }).lean();
    if (!f) throw notFound('Finding');
    await findRoForAccess(auth, f.roId);
    filter.findingId = findingId;
  } else if (vehicleId && auth.role !== 'customer') {
    filter.vehicleId = vehicleId;
    if (auth.role !== 'admin') filter.locationId = { $in: auth.locationIds };
  } else {
    throw badRequest('roId, findingId or vehicleId is required');
  }
  if (auth.role === 'customer') Object.assign(filter, { visibility: 'customer', status: 'current' });
  return toDTO(await Evidence.find(filter).sort({ capturedAt: -1 }).limit(500).lean());
};
