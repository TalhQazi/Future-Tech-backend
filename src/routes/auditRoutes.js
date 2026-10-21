import express from 'express';
import { db } from '../data/store.js';
import { protect, authorizeRoles } from '../middleware/auth.js';

const router = express.Router();

// GET /api/v1/audit
router.get('/', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const eventType = req.query.eventType;

  let logs = db.audit.find(limit);
  if (eventType) {
    logs = logs.filter(l => l.eventType === eventType);
  }

  res.json({ success: true, count: logs.length, auditLogs: logs });
});

export default router;
