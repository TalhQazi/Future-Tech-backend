// Creates (or resets) one sign-in per role and prints the generated passwords once.
//   npm run create-logins
// Existing accounts with these emails keep their id and history; only the
// password is replaced (prototype passwords were public). Staff get every
// active location; the customer login is linked to a customer record.
import crypto from 'crypto';
import mongoose from 'mongoose';
import { assertConfig } from '../config/env.js';
import { ensureReady } from '../app.js';
import { User, Customer, Location, AuditEvent } from '../models/index.js';
import { hashPassword } from '../services/authService.js';

assertConfig();

const ACCOUNTS = [
  { role: 'admin', name: 'Corporate Admin', email: 'admin@futuretech.com' },
  { role: 'manager', name: 'Shop Manager', email: 'manager@futuretech.com' },
  { role: 'advisor', name: 'Service Advisor', email: 'advisor@futuretech.com' },
  { role: 'technician', name: 'Master Technician', email: 'tech@futuretech.com', specialty: 'Diagnostics' },
  { role: 'parts', name: 'Parts Specialist', email: 'parts@futuretech.com' },
  { role: 'accounting', name: 'Billing Controller', email: 'accounting@futuretech.com' },
  { role: 'executive', name: 'Corporate Executive', email: 'executive@futuretech.com' },
  { role: 'customer', name: 'Demo Customer', email: 'customer@futuretech.com' }
];

// 16 chars: letters + digits, always satisfies the password policy
const newPassword = () => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(14);
  const body = [...bytes].map(b => alphabet[b % alphabet.length]).join('');
  return `Ft${body.slice(0, 7)}7${body.slice(7)}`;
};

// Optional: --only=executive,advisor (touch only these roles) --password=... (fixed password)
const arg = (k) => process.argv.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const only = arg('only')?.split(',');

const main = async () => {
  await ensureReady();
  const locationIds = (await Location.find({ status: { $ne: 'inactive' } }).select('id').lean()).map(l => l.id);
  const results = [];
  for (const acct of ACCOUNTS.filter(a => !only || only.includes(a.role))) {
    const password = arg('password') || newPassword();
    const passwordHash = await hashPassword(password);
    const staff = acct.role !== 'customer';
    let user = await User.findOne({ email: acct.email });
    const set = {
      name: user?.name || acct.name, role: acct.role, status: 'active', passwordHash, passwordChangedAt: new Date(),
      failedLoginCount: 0, ...(acct.specialty && !user?.specialty ? { specialty: acct.specialty } : {}),
      ...(staff ? { locationIds, primaryLocationId: locationIds[0] } : {})
    };
    if (user) {
      await User.updateOne({ id: user.id }, { $set: set, $unset: { password: 1, lockedUntil: 1 }, $inc: { tokenVersion: 1 } });
    } else {
      user = await User.create({ ...set, email: acct.email, createdBy: 'create-logins' });
    }
    if (!staff) {
      let customer = user.customerId ? await Customer.findOne({ id: user.customerId }) : await Customer.findOne({ email: acct.email });
      if (!customer) customer = await Customer.create({ name: acct.name, email: acct.email, userId: user.id, homeLocationId: locationIds[0], createdBy: 'create-logins' });
      await User.updateOne({ id: user.id }, { $set: { customerId: customer.id } });
      await Customer.updateOne({ id: customer.id }, { $set: { userId: user.id } });
    }
    await AuditEvent.create({ eventType: 'LOGIN_PROVISIONED', category: 'security', entityType: 'User', entityId: user.id, actorId: 'create-logins', actorRole: 'system', action: `Provisioned ${acct.role} login ${acct.email}` });
    results.push({ role: acct.role, email: acct.email, password, mfa: ['admin', 'manager', 'accounting', 'executive'].includes(acct.role) ? 'enroll at first sign-in' : '-' });
  }
  console.table(results);
  console.log('Store these passwords securely; they are not saved anywhere else.');
};

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
