import express from 'express';
import { db } from '../data/store.js';
import { protect, authorizeRoles } from '../middleware/auth.js';

const router = express.Router();

// GET /api/v1/locations
router.get('/', (req, res) => {
  const locations = db.locations.find();
  res.json({ success: true, count: locations.length, locations });
});

// GET /api/v1/locations/:id
router.get('/:id', (req, res) => {
  const loc = db.locations.findById(req.params.id);
  if (!loc) {
    return res.status(404).json({ success: false, message: 'Location not found' });
  }
  res.json({ success: true, location: loc });
});

// PUT /api/v1/locations/:id (Manager / Admin configuration)
router.put('/:id', protect, authorizeRoles('manager', 'admin'), (req, res) => {
  const updated = db.locations.update(req.params.id, req.body);
  if (!updated) {
    return res.status(404).json({ success: false, message: 'Location not found' });
  }

  db.audit.create({
    eventType: 'LOCATION_SETTINGS_UPDATED',
    entityType: 'Location',
    entityId: req.params.id,
    actorId: req.user.id,
    actorRole: req.user.role,
    action: `Updated settings for location ${updated.name}`
  });

  res.json({ success: true, location: updated });
});

// GET /api/v1/locations/:id/bays
router.get('/:id/bays', (req, res) => {
  const loc = db.locations.findById(req.params.id);
  if (!loc) {
    return res.status(404).json({ success: false, message: 'Location not found' });
  }

  // Enrich bays with current RO details if occupied
  const enrichedBays = (loc.bays || []).map(bay => {
    let activeRo = null;
    if (bay.occupiedRoId) {
      activeRo = db.repairOrders.findEnrichedById(bay.occupiedRoId);
    }
    return { ...bay, activeRo };
  });

  res.json({ success: true, bays: enrichedBays });
});

export default router;
