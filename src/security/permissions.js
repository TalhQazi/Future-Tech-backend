// Role-based permissions. Contextual checks (location, customer ownership,
// repair-order access) are applied in addition, in security/access.js.

export const PERMISSIONS = [
  'users:read', 'users:manage', 'locations:read', 'locations:manage', 'corporate:manage',
  'customers:read', 'customers:write', 'customers:pii',
  'vehicles:read', 'vehicles:write', 'vehicles:transfer',
  'appointments:read', 'appointments:write',
  'ros:read', 'ros:write', 'ros:dispatch', 'ros:close', 'ros:qc', 'ros:safety', 'ros:override',
  'inspections:read', 'inspections:write', 'inspections:complete', 'findings:correct',
  'evidence:read', 'evidence:write',
  'catalog:read', 'catalog:manage',
  'estimates:read', 'estimates:write', 'estimates:present', 'approvals:record',
  'memberships:read', 'memberships:sell', 'memberships:plans',
  'inventory:read', 'inventory:write', 'inventory:adjust', 'purchasing:manage', 'transfers:manage', 'parts:request',
  'jobs:execute', 'time:clock', 'time:correct',
  'invoices:read', 'invoices:write', 'invoices:post', 'payments:record', 'refunds:request', 'refunds:approve',
  'adjustments:create', 'reconciliation:manage',
  'messages:read', 'messages:send', 'messages:internal',
  'analytics:location', 'analytics:corporate', 'audit:read',
  'diagnostics:read', 'diagnostics:write', 'devices:manage', 'devices:command', 'devices:command_privileged',
  'techdata:read', 'techdata:manage', 'techdata:review',
  'fixes:read', 'fixes:verify', 'parts_intel:read', 'parts_intel:write',
  'forum:read', 'forum:write', 'forum:moderate',
  'fuel:read', 'fuel:write', 'predictive:read', 'predictive:manage',
  'ai:use', 'ai:review', 'ai:admin',
  'portal:access'
];

const ADVISOR = [
  'users:read', 'locations:read',
  'customers:read', 'customers:write', 'customers:pii',
  'vehicles:read', 'vehicles:write', 'vehicles:transfer',
  'appointments:read', 'appointments:write',
  'ros:read', 'ros:write', 'ros:dispatch', 'ros:safety',
  'inspections:read', 'evidence:read', 'evidence:write',
  'catalog:read', 'estimates:read', 'estimates:write', 'estimates:present', 'approvals:record',
  'memberships:read', 'memberships:sell',
  'inventory:read', 'parts:request',
  'invoices:read', 'invoices:write', 'invoices:post', 'payments:record', 'refunds:request',
  'messages:read', 'messages:send', 'messages:internal',
  'diagnostics:read', 'techdata:read', 'fixes:read', 'parts_intel:read',
  'forum:read', 'forum:write', 'fuel:read', 'fuel:write', 'predictive:read',
  'ai:use', 'ai:review'
];

const TECHNICIAN = [
  'users:read', 'locations:read',
  'customers:read', 'vehicles:read', 'appointments:read',
  'ros:read', 'ros:safety',
  'inspections:read', 'inspections:write', 'inspections:complete', 'findings:correct',
  'evidence:read', 'evidence:write',
  'catalog:read', 'estimates:read',
  'inventory:read', 'parts:request',
  'jobs:execute', 'time:clock',
  'messages:read', 'messages:internal',
  'diagnostics:read', 'diagnostics:write', 'devices:command',
  'techdata:read', 'fixes:read', 'parts_intel:read', 'parts_intel:write',
  'forum:read', 'forum:write', 'fuel:read', 'predictive:read',
  'ai:use'
];

const PARTS = [
  'users:read', 'locations:read',
  'vehicles:read', 'ros:read', 'estimates:read', 'catalog:read',
  'inventory:read', 'inventory:write', 'inventory:adjust', 'purchasing:manage', 'transfers:manage', 'parts:request',
  'parts_intel:read', 'parts_intel:write',
  'messages:read', 'messages:internal', 'forum:read'
];

const ACCOUNTING = [
  'users:read', 'locations:read',
  'customers:read', 'customers:pii', 'vehicles:read', 'ros:read', 'estimates:read', 'catalog:read',
  'memberships:read', 'memberships:sell',
  'inventory:read',
  'invoices:read', 'invoices:write', 'invoices:post', 'payments:record', 'refunds:request', 'refunds:approve',
  'adjustments:create', 'reconciliation:manage',
  'messages:read', 'messages:send', 'messages:internal',
  'analytics:location', 'audit:read'
];

const MANAGER = [...new Set([
  ...ADVISOR, ...TECHNICIAN, ...PARTS, ...ACCOUNTING,
  'users:manage', 'locations:manage', 'ros:close', 'ros:qc', 'ros:override', 'time:correct',
  'catalog:manage', 'devices:manage', 'devices:command_privileged',
  'techdata:manage', 'techdata:review', 'fixes:verify', 'forum:moderate', 'predictive:manage',
  'analytics:location', 'audit:read', 'ai:review'
])].filter(p => p !== 'portal:access');

const ADMIN = PERMISSIONS.filter(p => p !== 'portal:access');

const CUSTOMER = ['portal:access'];

export const ROLE_PERMISSIONS = Object.freeze({
  advisor: new Set(ADVISOR),
  technician: new Set(TECHNICIAN),
  parts: new Set(PARTS),
  accounting: new Set(ACCOUNTING),
  manager: new Set(MANAGER),
  admin: new Set(ADMIN),
  customer: new Set(CUSTOMER)
});

export const hasPermission = (role, permission) => Boolean(ROLE_PERMISSIONS[role]?.has(permission));

export const permissionsFor = (role) => [...(ROLE_PERMISSIONS[role] || [])].sort();

// Which roles a manager may create/edit; only admins manage managers and admins.
export const MANAGEABLE_ROLES = Object.freeze({
  admin: ['advisor', 'technician', 'parts', 'accounting', 'manager', 'admin'],
  manager: ['advisor', 'technician', 'parts', 'accounting']
});
