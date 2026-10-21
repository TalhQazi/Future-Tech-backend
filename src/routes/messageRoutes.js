import express from 'express';
import { db } from '../data/store.js';

const router = express.Router();

// GET /api/v1/messages
router.get('/', (req, res) => {
  const { customerId, roId } = req.query;
  const messages = db.messages.findByCustomerOrRo(customerId, roId);
  res.json({ success: true, count: messages.length, messages });
});

// POST /api/v1/messages (Send 2-way SMS or internal note)
router.post('/', (req, res) => {
  const { customerId, roId, direction, channel, senderName, message } = req.body;

  if (!message) {
    return res.status(400).json({ success: false, message: 'Message content is required' });
  }

  const newMsg = db.messages.create({
    customerId: customerId || 'cust_1',
    roId: roId || null,
    direction: direction || 'outbound',
    channel: channel || 'sms',
    senderName: senderName || 'Service Advisor',
    message
  });

  res.status(201).json({ success: true, messageRecord: newMsg });
});

export default router;
