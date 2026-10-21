import 'dotenv/config';
import mongoose from 'mongoose';
import {
  User,
  Customer,
  Vehicle,
  Location,
  Appointment,
  RepairOrder,
  Inspection,
  Estimate,
  Inventory,
  Invoice,
  DiagnosticSession,
  AuditLog
} from '../models/index.js';

import {
  seedUsers,
  seedCustomers,
  seedVehicles,
  seedLocations,
  seedAppointments,
  seedRepairOrders,
  seedInspections,
  seedEstimates,
  seedInventory,
  seedInvoices,
  seedFutureTechDiagnostics,
  seedAuditLogs
} from './seedData.js';

export const seedAtlas = async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('❌ MONGODB_URI not found in .env');
    process.exit(1);
  }

  console.log('🔄 Connecting to MongoDB Atlas...');
  await mongoose.connect(uri);
  console.log(`✅ Connected to MongoDB Atlas: ${mongoose.connection.host}`);

  try {
    console.log('🌱 Seeding MongoDB Atlas collections...');

    // 1. Users
    for (const u of seedUsers) {
      await User.findOneAndUpdate({ id: u.id }, u, { upsert: true, new: true });
    }
    console.log(`✓ Users seeded (${seedUsers.length})`);

    // 2. Customers
    for (const c of seedCustomers) {
      await Customer.findOneAndUpdate({ id: c.id }, c, { upsert: true, new: true });
    }
    console.log(`✓ Customers seeded (${seedCustomers.length})`);

    // 3. Vehicles
    for (const v of seedVehicles) {
      await Vehicle.findOneAndUpdate({ id: v.id }, v, { upsert: true, new: true });
    }
    console.log(`✓ Vehicles seeded (${seedVehicles.length})`);

    // 4. Locations
    for (const l of seedLocations) {
      await Location.findOneAndUpdate({ id: l.id }, l, { upsert: true, new: true });
    }
    console.log(`✓ Locations seeded (${seedLocations.length})`);

    // 5. Appointments
    for (const a of seedAppointments) {
      await Appointment.findOneAndUpdate({ id: a.id }, a, { upsert: true, new: true });
    }
    console.log(`✓ Appointments seeded (${seedAppointments.length})`);

    // 6. Repair Orders
    for (const ro of seedRepairOrders) {
      await RepairOrder.findOneAndUpdate({ id: ro.id }, ro, { upsert: true, new: true });
    }
    console.log(`✓ Repair Orders seeded (${seedRepairOrders.length})`);

    // 7. Inspections
    for (const insp of seedInspections) {
      await Inspection.findOneAndUpdate({ id: insp.id }, insp, { upsert: true, new: true });
    }
    console.log(`✓ Inspections seeded (${seedInspections.length})`);

    // 8. Estimates
    for (const est of seedEstimates) {
      await Estimate.findOneAndUpdate({ id: est.id }, est, { upsert: true, new: true });
    }
    console.log(`✓ Estimates seeded (${seedEstimates.length})`);

    // 9. Inventory
    for (const inv of seedInventory) {
      await Inventory.findOneAndUpdate({ id: inv.id }, inv, { upsert: true, new: true });
    }
    console.log(`✓ Inventory seeded (${seedInventory.length})`);

    // 10. Invoices
    for (const inv of seedInvoices) {
      await Invoice.findOneAndUpdate({ id: inv.id }, inv, { upsert: true, new: true });
    }
    console.log(`✓ Invoices seeded (${seedInvoices.length})`);

    // 11. Diagnostics
    for (const diag of seedFutureTechDiagnostics) {
      await DiagnosticSession.findOneAndUpdate({ id: diag.id }, diag, { upsert: true, new: true });
    }
    console.log(`✓ Diagnostics sessions seeded (${seedFutureTechDiagnostics.length})`);

    // 12. Audit Logs
    for (const log of seedAuditLogs) {
      await AuditLog.findOneAndUpdate({ id: log.id }, log, { upsert: true, new: true });
    }
    console.log(`✓ Audit logs seeded (${seedAuditLogs.length})`);

    console.log('🎉 MongoDB Atlas successfully populated with all FutureTech 2.0 shop collections!');
  } catch (err) {
    console.error('Seeding error:', err);
  } finally {
    await mongoose.disconnect();
    console.log('🔌 Disconnected from MongoDB Atlas');
  }
};

seedAtlas();
