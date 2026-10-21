import { Migration, Location, Part, User, InspectionTemplate } from './models/index.js';
import { legacyDollarsToCents } from './lib/money.js';

// Additive, idempotent data migrations. They only add or derive fields and
// never delete or overwrite business data. Each runs once (tracked by name).

const US_STATE_TZ = {
  CA: 'America/Los_Angeles', WA: 'America/Los_Angeles', OR: 'America/Los_Angeles', NV: 'America/Los_Angeles',
  AZ: 'America/Phoenix', CO: 'America/Denver', UT: 'America/Denver', NM: 'America/Denver',
  TX: 'America/Chicago', IL: 'America/Chicago', MN: 'America/Chicago', MO: 'America/Chicago',
  NY: 'America/New_York', FL: 'America/New_York', GA: 'America/New_York', NJ: 'America/New_York', MA: 'America/New_York'
};

const MIGRATIONS = [
  {
    name: '2026-10-locations-v2',
    async up() {
      const locs = await Location.find({ taxRateBps: { $exists: false } }).lean();
      for (const l of locs) {
        await Location.updateOne({ _id: l._id }, {
          $set: {
            status: l.status || 'active',
            timezone: US_STATE_TZ[(l.state || '').toUpperCase()] || process.env.DEFAULT_TIMEZONE || 'America/New_York',
            currency: 'USD',
            taxRateBps: Math.round((Number(l.salesTaxRate) || 0) * 10000),
            laborTaxable: false, partsTaxable: true, feesTaxable: false,
            laborRates: {
              standardCents: legacyDollarsToCents(l.laborRateStandard),
              diagnosticCents: legacyDollarsToCents(l.laborRateDiagnostics),
              evCents: legacyDollarsToCents(l.laborRateEv)
            },
            'bays': (l.bays || []).map(b => ({ ...b, active: b.active !== false }))
          }
        });
      }
      return { updated: locs.length };
    }
  },
  {
    name: '2026-10-parts-v2',
    async up() {
      const parts = await Part.find({ unitCostCents: { $exists: false } }).lean();
      for (const p of parts) {
        await Part.updateOne({ _id: p._id }, {
          $set: {
            unitCostCents: legacyDollarsToCents(p.costPrice), listPriceCents: legacyDollarsToCents(p.retailPrice),
            taxable: true, active: true, unitOfMeasure: 'each', coreChargeCents: 0
          }
        });
      }
      return { updated: parts.length };
    }
  },
  {
    name: '2026-10-users-v2',
    async up() {
      const locationIds = (await Location.find({ status: { $ne: 'inactive' } }).select('id').lean()).map(l => l.id);
      const users = await User.find({ $or: [{ status: { $exists: false } }, { locationIds: { $exists: false } }] }).lean();
      for (const u of users) {
        const set = { status: u.status || 'active', tokenVersion: u.tokenVersion || 0 };
        if (!u.locationIds && u.role !== 'customer') {
          set.locationIds = locationIds; // prototype users had no location scoping
          set.primaryLocationId = locationIds[0];
        }
        if (!u.mfa) set.mfa = { enabled: false, lastUsedCounter: 0, recoveryCodeHashes: [] };
        await User.updateOne({ _id: u._id }, { $set: set });
      }
      return { updated: users.length };
    }
  },
  {
    name: '2026-10-starter-inspection-template',
    async up() {
      if (await InspectionTemplate.exists({})) return { skipped: true };
      const section = (key, name, items) => ({ key, name, items: items.map(([k, n, hints = []]) => ({ key: k, name: n, measurementHints: hints })) });
      await InspectionTemplate.create({
        name: 'Multi-point inspection (starter)',
        version: 1,
        createdBy: 'system',
        sections: [
          section('brakes', 'Brakes', [['brake_pads_front', 'Front brake pads', [{ label: 'Pad thickness', unit: 'mm' }]], ['brake_pads_rear', 'Rear brake pads', [{ label: 'Pad thickness', unit: 'mm' }]], ['rotors', 'Rotors / drums'], ['brake_fluid', 'Brake fluid condition']]),
          section('tires', 'Tires & wheels', [['tread_lf', 'Tread depth LF', [{ label: 'Tread', unit: '32nds' }]], ['tread_rf', 'Tread depth RF', [{ label: 'Tread', unit: '32nds' }]], ['tread_lr', 'Tread depth LR', [{ label: 'Tread', unit: '32nds' }]], ['tread_rr', 'Tread depth RR', [{ label: 'Tread', unit: '32nds' }]], ['tire_pressure', 'Tire pressures', [{ label: 'Pressure', unit: 'psi' }]]]),
          section('fluids', 'Under hood & fluids', [['engine_oil', 'Engine oil level/condition'], ['coolant', 'Coolant level/condition'], ['belts_hoses', 'Belts & hoses'], ['air_filter', 'Engine air filter']]),
          section('electrical', 'Battery & electrical', [['battery', 'Battery test', [{ label: 'Open-circuit voltage', unit: 'V' }]], ['lights', 'Exterior lights'], ['wipers', 'Wiper blades']]),
          section('chassis', 'Steering & suspension', [['steering', 'Steering components'], ['suspension', 'Shocks / struts'], ['cv_boots', 'CV boots / axles']])
        ]
      });
      return { created: 1 };
    }
  }
];

export const runMigrations = async () => {
  const done = new Set((await Migration.find().select('name').lean()).map(m => m.name));
  for (const m of MIGRATIONS) {
    if (done.has(m.name)) continue;
    const summary = await m.up();
    try {
      await Migration.create({ name: m.name, summary });
      console.log(`[migrations] applied ${m.name}`, JSON.stringify(summary));
    } catch (err) {
      if (err.code !== 11000) throw err; // another instance applied it concurrently
    }
  }
};
