import { Schema, idField, baseOptions, model } from './common.js';

const ConversationSchema = new Schema({
  id: idField,
  customerId: { type: String, required: true, index: true },
  roId: { type: String, index: true },
  locationId: { type: String, index: true },
  subject: { type: String, default: '' },
  status: { type: String, enum: ['open', 'closed'], default: 'open' },
  lastMessageAt: Date,
  lastMessagePreview: String,
  unreadForStaff: { type: Number, default: 0 },
  unreadForCustomer: { type: Number, default: 0 },
  assignedTo: String
}, baseOptions());
ConversationSchema.index({ locationId: 1, lastMessageAt: -1 });

export const MESSAGE_CHANNELS = ['portal', 'sms', 'email', 'internal_note'];
export const DELIVERY_STATUSES = ['not_applicable', 'queued', 'sent', 'delivered', 'failed', 'provider_not_configured', 'no_consent', 'no_destination'];

const MessageSchema = new Schema({
  id: idField,
  conversationId: { type: String, index: true },
  customerId: { type: String, index: true },
  roId: { type: String, index: true },
  direction: { type: String, enum: ['inbound', 'outbound', 'internal'], required: true },
  channel: { type: String, enum: MESSAGE_CHANNELS, required: true },
  body: { type: String, required: true, maxlength: 5000 },
  // legacy prototype field name for the body
  message: String,
  senderUserId: String,
  senderName: String,
  senderRole: String,
  visibility: { type: String, enum: ['customer', 'internal'], default: 'customer' },
  deliveryStatus: { type: String, enum: DELIVERY_STATUSES, default: 'not_applicable' },
  deliveryError: String,
  provider: String,
  providerRef: String,
  aiExecutionId: String, // when drafted with AI assistance (after human review)
  attachments: { type: [String], default: [] }, // evidence ids
  readAt: Date,
  timestamp: { type: Date, default: Date.now }
}, baseOptions());

const NotificationSchema = new Schema({
  id: idField,
  userId: { type: String, required: true, index: true },
  type: { type: String, required: true },
  title: { type: String, required: true },
  body: { type: String, default: '' },
  link: String,
  entityType: String,
  entityId: String,
  severity: { type: String, enum: ['info', 'success', 'warning', 'critical'], default: 'info' },
  readAt: Date,
  dedupeKey: { type: String, sparse: true, unique: true }
}, baseOptions());
NotificationSchema.index({ userId: 1, readAt: 1, createdAt: -1 });

export const Conversation = model('Conversation', ConversationSchema, 'conversations');
export const Message = model('Message', MessageSchema, 'messages');
export const Notification = model('Notification', NotificationSchema, 'notifications');
