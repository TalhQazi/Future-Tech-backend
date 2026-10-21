import { env } from '../config/env.js';
import { User, Customer, Location } from '../models/index.js';
import { STAFF_ROLES } from '../models/identity.js';
import { MANAGEABLE_ROLES } from '../security/permissions.js';
import { isAdmin, assertLocation } from '../security/access.js';
import { audit } from './audit.js';
import { publicUser, logoutAllSessions, assertNotSelfPrivilegeChange } from './authService.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { forbidden, notFound, conflict, badRequest } from '../lib/errors.js';
import { escapeRegex } from '../lib/http.js';
import { notificationAdapters } from '../adapters/notifications.js';

const INVITE_DAYS = 7;

const assertCanManageRole = (auth, role) => {
  const allowed = MANAGEABLE_ROLES[auth.role] || [];
  if (!allowed.includes(role)) throw forbidden(`Your role cannot manage ${role} accounts`);
};

// Managers may only assign locations they belong to; admins any active location.
const assertAssignableLocations = async (auth, locationIds) => {
  if (!locationIds?.length) return;
  const found = await Location.countDocuments({ id: { $in: locationIds }, status: { $ne: 'inactive' } });
  if (found !== new Set(locationIds).size) throw badRequest('One or more locations do not exist');
  if (!isAdmin(auth)) locationIds.forEach(id => assertLocation(auth, id));
};

const assertCanSeeUser = (auth, user) => {
  if (isAdmin(auth)) return;
  if (user.role === 'customer') throw forbidden();
  const shared = (user.locationIds || []).some(id => auth.locationIds.includes(id));
  if (!shared) throw forbidden('This user is not assigned to your locations');
};

export const listUsers = async (auth, { q, role, locationId, status }) => {
  const filter = { role: { $in: STAFF_ROLES } };
  if (role) filter.role = role;
  if (status) filter.status = status;
  if (locationId) filter.locationIds = locationId;
  if (!isAdmin(auth)) filter.locationIds = locationId ? { $in: auth.locationIds.filter(l => l === locationId) } : { $in: auth.locationIds };
  if (q) {
    const rx = new RegExp(escapeRegex(q), 'i');
    filter.$or = [{ name: rx }, { email: rx }];
  }
  const users = await User.find(filter).sort({ name: 1 }).limit(500).lean();
  return users.map(publicUser);
};

const sendInviteEmail = async (user, token) => {
  const link = `${env.appBaseUrl}/#/accept-invite?token=${encodeURIComponent(token)}&email=${encodeURIComponent(user.email)}`;
  const delivery = await notificationAdapters.email.send({
    to: user.email,
    subject: 'You have been invited to FutureTech Shop OS',
    body: `Hello ${user.name},\n\nYou have been invited to FutureTech Shop OS. Set your password here (valid ${INVITE_DAYS} days):\n${link}\n`
  });
  return { link, delivery: delivery.status };
};

// Creates a staff account in "invited" state. The one-time link is emailed when
// email is configured and returned once to the inviting user otherwise.
export const inviteStaff = async (req, input) => {
  const { auth } = req;
  assertCanManageRole(auth, input.role);
  const locationIds = input.locationIds?.length ? input.locationIds : [];
  if (input.role !== 'admin' && locationIds.length === 0) throw badRequest('Assign at least one location');
  await assertAssignableLocations(auth, locationIds);
  const email = input.email.toLowerCase().trim();
  if (await User.exists({ email })) throw conflict('An account with this email already exists', 'EMAIL_IN_USE');

  const token = randomToken(32);
  const user = await User.create({
    name: input.name.trim(),
    email,
    role: input.role,
    status: 'invited',
    phone: input.phone || '',
    specialty: input.specialty || '',
    locationIds,
    primaryLocationId: locationIds[0],
    laborCostRateCents: input.laborCostRateCents ?? null,
    certifications: input.certifications || [],
    inviteTokenHash: sha256(token),
    inviteExpiresAt: new Date(Date.now() + INVITE_DAYS * 86400000),
    createdBy: auth.userId
  });
  const invite = await sendInviteEmail(user, token);
  await audit(req, {
    eventType: 'USER_INVITED', category: 'permission', entityType: 'User', entityId: user.id,
    action: `Invited ${user.role} ${user.name} (locations: ${locationIds.join(', ') || 'all'}; email delivery: ${invite.delivery})`
  });
  return {
    user: publicUser(user),
    inviteDelivery: invite.delivery,
    // Shown once so the manager can share it when email is not configured
    inviteLink: invite.delivery === 'sent' ? undefined : invite.link
  };
};

export const resendInvite = async (req, userId) => {
  const user = await User.findOne({ id: userId });
  if (!user) throw notFound('User');
  if (user.status !== 'invited') throw conflict('This user has already accepted the invitation');
  assertCanManageRole(req.auth, user.role);
  assertCanSeeUser(req.auth, user);
  const token = randomToken(32);
  await User.updateOne({ id: user.id }, { $set: { inviteTokenHash: sha256(token), inviteExpiresAt: new Date(Date.now() + INVITE_DAYS * 86400000) } });
  const invite = await sendInviteEmail(user, token);
  await audit(req, { eventType: 'USER_INVITE_RESENT', category: 'permission', entityType: 'User', entityId: user.id, action: `Invitation re-issued (email delivery: ${invite.delivery})` });
  return { inviteDelivery: invite.delivery, inviteLink: invite.delivery === 'sent' ? undefined : invite.link };
};

export const updateUser = async (req, userId, input) => {
  const { auth } = req;
  const user = await User.findOne({ id: userId });
  if (!user || user.role === 'customer') throw notFound('User');
  assertCanSeeUser(auth, user);
  assertCanManageRole(auth, user.role);

  const before = { role: user.role, status: user.status, locationIds: user.locationIds };
  const set = {};
  if (input.name !== undefined) set.name = input.name.trim();
  if (input.phone !== undefined) set.phone = input.phone;
  if (input.specialty !== undefined) set.specialty = input.specialty;
  if (input.certifications !== undefined) set.certifications = input.certifications;
  if (input.laborCostRateCents !== undefined) set.laborCostRateCents = input.laborCostRateCents;

  let privilegeChanged = false;
  if (input.role !== undefined && input.role !== user.role) {
    assertNotSelfPrivilegeChange(auth, userId);
    assertCanManageRole(auth, input.role);
    set.role = input.role;
    privilegeChanged = true;
  }
  if (input.locationIds !== undefined) {
    assertNotSelfPrivilegeChange(auth, userId);
    await assertAssignableLocations(auth, input.locationIds);
    if (!isAdmin(auth)) {
      // managers cannot remove locations they do not manage
      const untouchable = (user.locationIds || []).filter(id => !auth.locationIds.includes(id));
      set.locationIds = [...new Set([...untouchable, ...input.locationIds])];
    } else {
      set.locationIds = input.locationIds;
    }
    set.primaryLocationId = set.locationIds.includes(user.primaryLocationId) ? user.primaryLocationId : set.locationIds[0];
    privilegeChanged = true;
  }
  if (input.status !== undefined && input.status !== user.status) {
    assertNotSelfPrivilegeChange(auth, userId);
    if (!['active', 'disabled'].includes(input.status)) throw badRequest('Status must be active or disabled');
    if (user.status === 'invited' && input.status === 'active') throw badRequest('Invited users activate by accepting their invitation');
    set.status = input.status;
    privilegeChanged = true;
  }

  const updated = await User.findOneAndUpdate({ id: userId }, { $set: set }, { new: true });
  if (privilegeChanged) {
    // Role/location/status changes take effect immediately: revoke sessions.
    await logoutAllSessions(req, userId, 'privileges_changed');
    await audit(req, {
      eventType: 'USER_PRIVILEGES_CHANGED', category: 'permission', entityType: 'User', entityId: userId,
      action: `Changed access for ${updated.name}`, before, after: { role: updated.role, status: updated.status, locationIds: updated.locationIds },
      reason: input.reason
    });
  } else {
    await audit(req, { eventType: 'USER_PROFILE_UPDATED', category: 'data', entityType: 'User', entityId: userId, action: `Updated profile of ${updated.name}` });
  }
  return publicUser(updated);
};

export const resetUserMfa = async (req, userId, reason) => {
  const user = await User.findOne({ id: userId });
  if (!user) throw notFound('User');
  assertNotSelfPrivilegeChange(req.auth, userId);
  assertCanSeeUser(req.auth, user);
  assertCanManageRole(req.auth, user.role);
  await User.updateOne({ id: userId }, {
    $set: { 'mfa.enabled': false, mfaEnabled: false, 'mfa.recoveryCodeHashes': [], 'mfa.lastUsedCounter': 0 },
    $unset: { 'mfa.secretEnc': 1, 'mfa.pendingSecretEnc': 1 }
  });
  await logoutAllSessions(req, userId, 'mfa_reset');
  await audit(req, { eventType: 'MFA_RESET', category: 'security', entityType: 'User', entityId: userId, action: `Reset MFA for ${user.name}; user must re-enroll at next sign-in`, reason });
  return { success: true };
};

export const revokeUserSessions = async (req, userId) => {
  const user = await User.findOne({ id: userId });
  if (!user) throw notFound('User');
  assertCanSeeUser(req.auth, user);
  if (req.auth.userId !== userId) assertCanManageRole(req.auth, user.role);
  await logoutAllSessions(req, userId, 'revoked_by_admin');
  await audit(req, { eventType: 'SESSIONS_REVOKED', category: 'security', entityType: 'User', entityId: userId, action: `Revoked all sessions for ${user.name}` });
  return { success: true };
};

// Staff invite a customer to the portal for an existing customer record.
export const inviteCustomerToPortal = async (req, customerId) => {
  const customer = await Customer.findOne({ id: customerId });
  if (!customer) throw notFound('Customer');
  if (!customer.email) throw badRequest('Add an email address to the customer before inviting them to the portal');
  if (customer.userId) {
    const existing = await User.findOne({ id: customer.userId });
    if (existing && existing.status === 'active') throw conflict('This customer already has an active portal account');
  }
  const email = customer.email.toLowerCase();
  const other = await User.findOne({ email });
  if (other && other.customerId !== customer.id) throw conflict('That email is already used by another account', 'EMAIL_IN_USE');

  const token = randomToken(32);
  const user = other || await User.create({ name: customer.name, email, role: 'customer', status: 'invited', customerId: customer.id, phone: customer.phone, createdBy: req.auth.userId });
  await User.updateOne({ id: user.id }, { $set: { status: 'invited', inviteTokenHash: sha256(token), inviteExpiresAt: new Date(Date.now() + INVITE_DAYS * 86400000) } });
  await Customer.updateOne({ id: customer.id }, { $set: { userId: user.id } });
  const invite = await sendInviteEmail(user, token);
  await audit(req, { eventType: 'PORTAL_INVITE_SENT', category: 'security', entityType: 'Customer', entityId: customer.id, action: `Customer portal invitation issued (email delivery: ${invite.delivery})` });
  return { inviteDelivery: invite.delivery, inviteLink: invite.delivery === 'sent' ? undefined : invite.link };
};
