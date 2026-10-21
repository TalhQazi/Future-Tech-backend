// Creates the first corporate administrator.
//   BOOTSTRAP_ADMIN_EMAIL=... BOOTSTRAP_ADMIN_NAME="..." BOOTSTRAP_ADMIN_PASSWORD=... npm run create-admin
// The admin must enroll MFA at first sign-in. Refuses to overwrite an existing account.
import { assertConfig } from '../config/env.js';
import mongoose from 'mongoose';
import { ensureReady } from '../app.js';
import { User, AuditEvent, Location } from '../models/index.js';
import { hashPassword, passwordPolicyError } from '../services/authService.js';

assertConfig();
const email = (process.env.BOOTSTRAP_ADMIN_EMAIL || '').toLowerCase().trim();
const name = (process.env.BOOTSTRAP_ADMIN_NAME || 'Corporate Administrator').trim();
const password = process.env.BOOTSTRAP_ADMIN_PASSWORD || '';

const main = async () => {
  if (!email) throw new Error('Set BOOTSTRAP_ADMIN_EMAIL');
  const policy = passwordPolicyError(password);
  if (policy) throw new Error(policy);
  await ensureReady();
  if (await User.exists({ email })) throw new Error('An account with this email already exists');
  const locationIds = (await Location.find().select('id').lean()).map(l => l.id);
  const user = await User.create({ name, email, role: 'admin', passwordHash: await hashPassword(password), locationIds, primaryLocationId: locationIds[0], passwordChangedAt: new Date(), createdBy: 'bootstrap' });
  await AuditEvent.create({ eventType: 'ADMIN_BOOTSTRAPPED', category: 'permission', entityType: 'User', entityId: user.id, actorId: 'bootstrap', actorRole: 'system', action: `Created corporate administrator ${email}` });
  console.log(`Created admin ${email}. Sign in and enroll MFA.`);
};

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
