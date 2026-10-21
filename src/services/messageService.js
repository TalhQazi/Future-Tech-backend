import { Conversation, Message, Customer, RepairOrder } from '../models/index.js';
import { audit } from './audit.js';
import { enqueueJob, registerJobHandler } from './jobService.js';
import { notifyUsers, notifyRoles } from './notificationService.js';
import { hasConsent } from './customerService.js';
import { notificationAdapters } from '../adapters/notifications.js';
import { assertLocation, locationFilter, assertCustomerScope, findRoForAccess } from '../security/access.js';
import { notFound, badRequest, forbidden } from '../lib/errors.js';
import { toDTO } from '../lib/http.js';
import { env } from '../config/env.js';

const getOrCreateConversation = async ({ customerId, roId, locationId, subject }) => {
  const filter = roId ? { customerId, roId } : { customerId, roId: null, locationId };
  return Conversation.findOneAndUpdate(filter, { $setOnInsert: { ...filter, subject: subject || '' } }, { upsert: true, new: true });
};

const touch = (conversationId, body, direction) => Conversation.updateOne({ id: conversationId }, {
  $set: { lastMessageAt: new Date(), lastMessagePreview: body.slice(0, 140), status: 'open' },
  $inc: direction === 'inbound' ? { unreadForStaff: 1 } : direction === 'outbound' ? { unreadForCustomer: 1 } : {}
});

export const listConversations = async (auth, { locationId, customerId, unreadOnly }) => {
  const filter = {};
  if (auth.role === 'customer') filter.customerId = auth.customerId;
  else {
    Object.assign(filter, locationFilter(auth));
    if (locationId) { assertLocation(auth, locationId); filter.locationId = locationId; }
    if (customerId) filter.customerId = customerId;
    if (unreadOnly === 'true') filter.unreadForStaff = { $gt: 0 };
  }
  const items = await Conversation.find(filter).sort({ lastMessageAt: -1 }).limit(200).lean();
  const customers = await Customer.find({ id: { $in: items.map(c => c.customerId) } }).select('id name').lean();
  const ros = await RepairOrder.find({ id: { $in: items.map(c => c.roId).filter(Boolean) } }).select('id roNumber').lean();
  return items.map(c => ({ ...toDTO(c), customerName: customers.find(x => x.id === c.customerId)?.name, roNumber: ros.find(r => r.id === c.roId)?.roNumber }));
};

export const getThread = async (auth, conversationId) => {
  const conv = await Conversation.findOne({ id: conversationId }).lean();
  if (!conv) throw notFound('Conversation');
  if (auth.role === 'customer') assertCustomerScope(auth, conv.customerId);
  else if (conv.locationId) assertLocation(auth, conv.locationId);
  const filter = { conversationId };
  if (auth.role === 'customer') filter.visibility = 'customer';
  const messages = await Message.find(filter).sort({ timestamp: 1 }).limit(1000).lean();
  await Conversation.updateOne({ id: conversationId }, { $set: auth.role === 'customer' ? { unreadForCustomer: 0 } : { unreadForStaff: 0 } });
  return { conversation: toDTO(conv), messages: toDTO(messages) };
};

/**
 * Sends a message. Staff: channel portal | sms | email | internal_note.
 * Customers always post inbound portal messages.
 */
export const sendMessage = async (req, { customerId, roId, channel, body }) => {
  const { auth } = req;
  if (!body?.trim()) throw badRequest('Message cannot be empty');
  let ro = null;
  if (roId) ro = await findRoForAccess(auth, roId);
  const isCustomer = auth.role === 'customer';
  customerId = isCustomer ? auth.customerId : (ro?.customerId || customerId);
  if (!customerId) throw badRequest('customerId or roId is required');
  const customer = await Customer.findOne({ id: customerId }).lean();
  if (!customer) throw notFound('Customer');
  const locationId = ro?.locationId || (isCustomer ? customer.homeLocationId : auth.primaryLocationId);
  if (!isCustomer && locationId) assertLocation(auth, locationId);
  if (isCustomer) channel = 'portal';
  if (channel === 'internal_note' && isCustomer) throw forbidden();
  if (['sms', 'email', 'portal'].includes(channel) && !isCustomer && auth.role === 'technician') throw forbidden('Technicians can only add internal notes');

  const conv = await getOrCreateConversation({ customerId, roId: ro?.id || null, locationId, subject: ro ? ro.roNumber : '' });
  const direction = isCustomer ? 'inbound' : channel === 'internal_note' ? 'internal' : 'outbound';
  let deliveryStatus = 'not_applicable';
  if (channel === 'sms') deliveryStatus = !customer.phone ? 'no_destination' : !hasConsent(customer, 'sms_transactional') ? 'no_consent' : 'queued';
  if (channel === 'email') deliveryStatus = !customer.email ? 'no_destination' : 'queued';

  const msg = await Message.create({
    conversationId: conv.id, customerId, roId: ro?.id, direction, channel, body: body.trim(),
    senderUserId: auth.userId, senderName: auth.user.name, senderRole: auth.role,
    visibility: channel === 'internal_note' ? 'internal' : 'customer', deliveryStatus
  });
  await touch(conv.id, msg.body, direction);
  if (deliveryStatus === 'queued') await enqueueJob('message.deliver', { messageId: msg.id }, `deliver:${msg.id}`);
  if (isCustomer) {
    await notifyRoles(locationId, ['advisor'], { type: 'customer_message', title: `Message from ${customer.name}`, body: msg.body.slice(0, 120), link: '#/app/messages', entityType: 'Conversation', entityId: conv.id });
  } else if (direction === 'outbound' && customer.userId) {
    await notifyUsers([customer.userId], { type: 'shop_message', title: 'New message from the shop', body: msg.body.slice(0, 120), link: '#/portal/messages' });
  }
  if (direction !== 'internal') await audit(req, { eventType: 'MESSAGE_SENT', entityType: 'Conversation', entityId: conv.id, locationId, action: `${direction} ${channel} message (${deliveryStatus})` });
  return toDTO(msg.toObject());
};

registerJobHandler('message.deliver', async ({ messageId }) => {
  const msg = await Message.findOne({ id: messageId }).lean();
  if (!msg || msg.deliveryStatus !== 'queued') return { skipped: true }; // idempotent
  const customer = await Customer.findOne({ id: msg.customerId }).lean();
  const result = msg.channel === 'sms'
    ? await notificationAdapters.sms.send({ to: customer.phone, body: msg.body })
    : await notificationAdapters.email.send({ to: customer.email, subject: 'Message from your service center', body: msg.body });
  if (result.status === 'failed' && result.retryable) throw new Error(result.error);
  await Message.updateOne({ id: messageId, deliveryStatus: 'queued' }, { $set: { deliveryStatus: result.status, deliveryError: result.error, provider: result.provider, providerRef: result.providerRef } });
  return result;
});

export const notifyCustomerOfEstimate = async (req, ro, estimate, version) => {
  const customer = await Customer.findOne({ id: ro.customerId }).lean();
  const link = `${env.appBaseUrl}/#/portal/ro/${ro.id}`;
  const body = `Your estimate for ${ro.roNumber} is ready for review (version ${version.versionNumber}). Review and approve online: ${link}`;
  const channel = customer.userId ? 'portal' : customer.preferredContact === 'email' ? 'email' : 'sms';
  const msg = await sendMessage(req, { roId: ro.id, channel, body });
  return { channel, deliveryStatus: msg.deliveryStatus };
};
