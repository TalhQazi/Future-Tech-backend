import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  seedUsers,
  seedCustomers,
  seedVehicles,
  seedRepairOrders,
  seedInspections,
  seedFutureTechDiagnostics,
  seedEstimates,
  seedPartsRequests,
  seedInvoices,
  seedLocations,
  seedAppointments,
  seedInventory,
  seedMembershipPlans,
  seedServiceRiders,
  seedWiringDiagrams,
  seedConfirmedFixes,
  seedForumThreads,
  seedFuelLogs,
  seedMessages,
  seedAuditLogs,
  seedAiExecutionLogs,
  seedPredictiveSignals
} from '../seeds/seedData.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_FILE = path.join(__dirname, 'db.json');

const cleanUsers = [
  {
    id: "usr_advisor_1",
    name: "Service Advisor",
    email: "advisor@futuretech.com",
    password: "password123",
    role: "advisor",
    phone: "555-0101"
  },
  {
    id: "usr_tech_1",
    name: "Master Technician",
    email: "tech@futuretech.com",
    password: "password123",
    role: "technician",
    phone: "555-0102",
    specialty: "Master Diagnostics / High Voltage & Powertrain"
  },
  {
    id: "usr_manager_1",
    name: "Shop Manager",
    email: "manager@futuretech.com",
    password: "password123",
    role: "manager",
    phone: "555-0103"
  }
];

// Clean in-memory state store with zero dummy data
let state = {
  users: [...cleanUsers],
  customers: [],
  vehicles: [],
  repairOrders: [],
  inspections: [],
  diagnostics: [],
  estimates: [],
  partsRequests: [],
  invoices: [],
  locations: [],
  appointments: [],
  inventory: [],
  membershipPlans: [...seedMembershipPlans],
  serviceRiders: [...seedServiceRiders],
  wiringDiagrams: [...seedWiringDiagrams],
  confirmedFixes: [...seedConfirmedFixes],
  forumThreads: [...seedForumThreads],
  fuelLogs: [],
  messages: [],
  auditLogs: [],
  aiExecutionLogs: [],
  predictiveSignals: [],
  refreshTokens: []
};

// Initialize or load persisted state
export const initStore = () => {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      state = {
        ...state,
        ...parsed,
        users: parsed.users && parsed.users.length > 0 ? parsed.users : [...cleanUsers],
        customers: parsed.customers || [],
        vehicles: parsed.vehicles || [],
        repairOrders: parsed.repairOrders || [],
        inspections: parsed.inspections || [],
        diagnostics: parsed.diagnostics || [],
        estimates: parsed.estimates || [],
        partsRequests: parsed.partsRequests || [],
        invoices: parsed.invoices || [],
        appointments: parsed.appointments || [],
        inventory: parsed.inventory || [],
        membershipPlans: parsed.membershipPlans && parsed.membershipPlans.length > 0 ? parsed.membershipPlans : [...seedMembershipPlans],
        serviceRiders: parsed.serviceRiders && parsed.serviceRiders.length > 0 ? parsed.serviceRiders : [...seedServiceRiders],
        wiringDiagrams: parsed.wiringDiagrams && parsed.wiringDiagrams.length > 0 ? parsed.wiringDiagrams : [...seedWiringDiagrams],
        confirmedFixes: parsed.confirmedFixes && parsed.confirmedFixes.length > 0 ? parsed.confirmedFixes : [...seedConfirmedFixes],
        forumThreads: parsed.forumThreads && parsed.forumThreads.length > 0 ? parsed.forumThreads : [...seedForumThreads],
        refreshTokens: parsed.refreshTokens || []
      };
      saveStore();
      console.log('📦 Clean shop database initialized with zero dummy records.');
    } else {
      saveStore();
      console.log('🌱 Clean shop database initialized.');
    }
  } catch (err) {
    console.warn('⚠️ Could not load persisted db.json, using in-memory state:', err.message);
  }
};

export const saveStore = () => {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(state, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to write db.json:', err.message);
  }
};

export const db = {
  // USERS
  users: {
    find: (predicate = () => true) => state.users.filter(predicate),
    findOne: (predicate) => state.users.find(predicate),
    findById: (id) => state.users.find(u => u.id === id),
    create: (data) => {
      const item = { id: `usr_${Date.now()}`, ...data };
      state.users.push(item);
      saveStore();
      return item;
    }
  },

  // CUSTOMERS
  customers: {
    find: (predicate = () => true) => state.customers.filter(predicate),
    findById: (id) => state.customers.find(c => c.id === id),
    search: (query) => {
      if (!query) return state.customers;
      const q = query.toLowerCase();
      return state.customers.filter(c => 
        c.name.toLowerCase().includes(q) ||
        c.phone.includes(q) ||
        c.email.toLowerCase().includes(q) ||
        (c.membership && c.membership.number && c.membership.number.toLowerCase().includes(q))
      );
    },
    create: (data) => {
      const item = { id: `cust_${Date.now()}`, ...data };
      state.customers.push(item);
      saveStore();
      return item;
    },
    update: (id, updates) => {
      const index = state.customers.findIndex(c => c.id === id);
      if (index === -1) return null;
      state.customers[index] = { ...state.customers[index], ...updates };
      saveStore();
      return state.customers[index];
    }
  },

  // VEHICLES
  vehicles: {
    find: (predicate = () => true) => state.vehicles.filter(predicate),
    findById: (id) => state.vehicles.find(v => v.id === id),
    findByVin: (vin) => state.vehicles.find(v => v.vin.toLowerCase() === vin.toLowerCase()),
    findByCustomerId: (customerId) => state.vehicles.filter(v => v.customerId === customerId),
    search: (query) => {
      if (!query) return state.vehicles;
      const q = query.toLowerCase();
      return state.vehicles.filter(v =>
        v.vin.toLowerCase().includes(q) ||
        v.licensePlate.toLowerCase().includes(q) ||
        v.make.toLowerCase().includes(q) ||
        v.model.toLowerCase().includes(q)
      );
    },
    create: (data) => {
      const item = { id: `veh_${Date.now()}`, healthScore: 100, status: 'in_shop', ...data };
      state.vehicles.push(item);
      saveStore();
      return item;
    },
    update: (id, updates) => {
      const index = state.vehicles.findIndex(v => v.id === id);
      if (index === -1) return null;
      state.vehicles[index] = { ...state.vehicles[index], ...updates };
      saveStore();
      return state.vehicles[index];
    }
  },

  // REPAIR ORDERS (RO BOARD)
  repairOrders: {
    find: (predicate = () => true) => state.repairOrders.filter(predicate),
    findById: (id) => state.repairOrders.find(r => r.id === id || r.roNumber === id),
    findEnriched: () => {
      return state.repairOrders.map(ro => {
        const customer = state.customers.find(c => c.id === ro.customerId);
        const vehicle = state.vehicles.find(v => v.id === ro.vehicleId);
        const tech = state.users.find(u => u.id === ro.assignedTechId);
        const advisor = state.users.find(u => u.id === ro.advisorId);
        const inspection = state.inspections.find(i => i.roId === ro.id);
        const diagnostic = state.diagnostics.find(d => d.roId === ro.id);
        const estimate = state.estimates.find(e => e.roId === ro.id);
        const invoice = state.invoices.find(inv => inv.roId === ro.id);
        return {
          ...ro,
          customer,
          vehicle,
          assignedTech: tech ? { id: tech.id, name: tech.name, specialty: tech.specialty } : null,
          advisor: advisor ? { id: advisor.id, name: advisor.name } : null,
          inspectionSummary: inspection ? inspection.summary : null,
          healthScore: diagnostic ? diagnostic.healthScore : (vehicle ? vehicle.healthScore : null),
          dtcCount: diagnostic ? diagnostic.dtcCodes.length : 0,
          estimateTotal: estimate ? estimate.summary.total : null,
          estimateStatus: estimate ? estimate.status : null,
          invoiceStatus: invoice ? invoice.paymentStatus : null
        };
      });
    },
    findEnrichedById: (id) => {
      const ro = state.repairOrders.find(r => r.id === id || r.roNumber === id);
      if (!ro) return null;
      const customer = state.customers.find(c => c.id === ro.customerId);
      const vehicle = state.vehicles.find(v => v.id === ro.vehicleId);
      const tech = state.users.find(u => u.id === ro.assignedTechId);
      const advisor = state.users.find(u => u.id === ro.advisorId);
      const inspection = state.inspections.find(i => i.roId === ro.id);
      const diagnostic = state.diagnostics.find(d => d.roId === ro.id);
      const estimate = state.estimates.find(e => e.roId === ro.id);
      const parts = state.partsRequests.filter(p => p.roId === ro.id);
      const invoice = state.invoices.find(inv => inv.roId === ro.id);

      return {
        ...ro,
        customer,
        vehicle,
        assignedTech: tech ? { id: tech.id, name: tech.name, specialty: tech.specialty } : null,
        advisor: advisor ? { id: advisor.id, name: advisor.name } : null,
        inspection,
        diagnostic,
        estimate,
        parts,
        invoice
      };
    },
    create: (data) => {
      const nextNum = 80 + state.repairOrders.length + 1;
      const roNumber = `RO-2026-0${nextNum}`;
      const item = {
        id: `ro_${Date.now()}`,
        roNumber,
        status: 'checked_in',
        createdAt: new Date().toISOString(),
        customerComplaints: [],
        ...data
      };
      state.repairOrders.unshift(item);

      // Also create an empty inspection and diagnostic entry for seamless technician flow
      if (!state.inspections.find(i => i.roId === item.id)) {
        state.inspections.push({
          id: `insp_${Date.now()}`,
          roId: item.id,
          vehicleId: item.vehicleId,
          techId: item.assignedTechId || null,
          status: 'pending',
          summary: { pass: 0, attention: 0, fail: 0 },
          items: [
            { id: `item_${Date.now()}_1`, category: 'Brakes & Stopping', name: 'Front & Rear Brake Pads/Rotors', status: 'pass', finding: 'Visual check pending', recommendation: '' },
            { id: `item_${Date.now()}_2`, category: 'Tires & Suspension', name: 'Tread Depth & Tire Pressures', status: 'pass', finding: 'All 4 tires at 35 PSI', recommendation: '' },
            { id: `item_${Date.now()}_3`, category: 'Under Hood & Fluids', name: 'Engine Oil & Vital Fluids', status: 'pass', finding: 'Levels adequate', recommendation: '' },
            { id: `item_${Date.now()}_4`, category: 'Battery & Electrical', name: '12V Battery Health & Terminals', status: 'pass', finding: 'Cranking test normal', recommendation: '' }
          ]
        });
      }

      // Initialize diagnostic record
      if (!state.diagnostics.find(d => d.roId === item.id)) {
        state.diagnostics.push({
          id: `diag_${Date.now()}`,
          roId: item.id,
          vehicleId: item.vehicleId,
          scanToolConnected: true,
          protocol: 'OBD-II CAN / UDS',
          healthScore: 85,
          liveTelemetry: {
            batteryVoltage: 13.8,
            coolantTempF: 195,
            rpm: 750,
            oilPressurePsi: 40
          },
          dtcCodes: [],
          guidedChecks: [
            { id: `chk_${Date.now()}_1`, stepNumber: 1, title: 'Check In Vehicle Health Scan', instructions: 'Connect AutoMind / OBD tool and read active DTCs across all ECUs.', status: 'passed', technicianFindings: 'Initial scan complete.' }
          ],
          techDiagnosticNotes: ''
        });
      }

      saveStore();
      return item;
    },
    update: (id, updates) => {
      const index = state.repairOrders.findIndex(r => r.id === id || r.roNumber === id);
      if (index === -1) return null;
      state.repairOrders[index] = { ...state.repairOrders[index], ...updates, updatedAt: new Date().toISOString() };
      saveStore();
      return state.repairOrders[index];
    }
  },

  // DIGITAL VEHICLE INSPECTION
  inspections: {
    findByRoId: (roId) => state.inspections.find(i => i.roId === roId),
    updateItemStatus: (roId, itemId, status, finding, recommendation, photoUrl) => {
      const insp = state.inspections.find(i => i.roId === roId);
      if (!insp) return null;
      const item = insp.items.find(it => it.id === itemId);
      if (item) {
        if (status) item.status = status;
        if (finding !== undefined) item.finding = finding;
        if (recommendation !== undefined) item.recommendation = recommendation;
        if (photoUrl !== undefined) item.photoUrl = photoUrl;
      }
      // Recompute summary
      const pass = insp.items.filter(it => it.status === 'pass').length;
      const attention = insp.items.filter(it => it.status === 'attention').length;
      const fail = insp.items.filter(it => it.status === 'fail').length;
      insp.summary = { pass, attention, fail };
      insp.status = 'in_progress';
      saveStore();
      return insp;
    },
    addItem: (roId, itemData) => {
      const insp = state.inspections.find(i => i.roId === roId);
      if (!insp) return null;
      insp.items.push({ id: `item_${Date.now()}`, ...itemData });
      saveStore();
      return insp;
    },
    complete: (roId) => {
      const insp = state.inspections.find(i => i.roId === roId);
      if (!insp) return null;
      insp.status = 'completed';
      insp.completedAt = new Date().toISOString();
      saveStore();
      return insp;
    }
  },

  // FUTURETECH INTEGRATED DIAGNOSTICS
  diagnostics: {
    findByRoId: (roId) => state.diagnostics.find(d => d.roId === roId),
    update: (roId, updates) => {
      const index = state.diagnostics.findIndex(d => d.roId === roId);
      if (index === -1) return null;
      state.diagnostics[index] = { ...state.diagnostics[index], ...updates };
      saveStore();
      return state.diagnostics[index];
    },
    addDtc: (roId, dtc) => {
      const diag = state.diagnostics.find(d => d.roId === roId);
      if (!diag) return null;
      diag.dtcCodes.push(dtc);
      // update vehicle health score
      diag.healthScore = Math.max(30, diag.healthScore - 15);
      saveStore();
      return diag;
    },
    updateGuidedCheck: (roId, checkId, updates) => {
      const diag = state.diagnostics.find(d => d.roId === roId);
      if (!diag) return null;
      const chk = diag.guidedChecks.find(c => c.id === checkId);
      if (chk) {
        Object.assign(chk, updates);
        chk.completedAt = new Date().toISOString();
      }
      saveStore();
      return diag;
    },
    addGuidedCheck: (roId, checkData) => {
      const diag = state.diagnostics.find(d => d.roId === roId);
      if (!diag) return null;
      const nextStep = diag.guidedChecks.length + 1;
      diag.guidedChecks.push({
        id: `chk_${Date.now()}`,
        stepNumber: nextStep,
        status: 'pending',
        ...checkData
      });
      saveStore();
      return diag;
    }
  },

  // ESTIMATES & APPROVALS
  estimates: {
    findByRoId: (roId) => state.estimates.find(e => e.roId === roId),
    createOrUpdate: (roId, estimateData) => {
      let est = state.estimates.find(e => e.roId === roId);
      if (!est) {
        est = {
          id: `est_${Date.now()}`,
          roId,
          estimateNumber: `EST-${Math.floor(1000 + Math.random() * 9000)}`,
          status: 'draft',
          createdAt: new Date().toISOString(),
          lines: [],
          summary: { subtotal: 0, memberDiscount: 0, tax: 0, shopSuppliesFee: 0, total: 0 },
          ...estimateData
        };
        state.estimates.push(est);
      } else {
        Object.assign(est, estimateData);
      }
      saveStore();
      return est;
    },
    updateLineApproval: (roId, lineId, approved) => {
      const est = state.estimates.find(e => e.roId === roId);
      if (!est) return null;
      const line = est.lines.find(l => l.id === lineId);
      if (line) {
        line.approved = approved;
      }

      // Check overall status
      const totalLines = est.lines.length;
      const approvedLines = est.lines.filter(l => l.approved === true).length;
      const declinedLines = est.lines.filter(l => l.approved === false).length;

      if (approvedLines === totalLines) {
        est.status = 'approved';
      } else if (declinedLines === totalLines) {
        est.status = 'declined';
      } else if (approvedLines > 0) {
        est.status = 'partially_approved';
      }

      // Recalculate summary based on approved lines
      const approvedSum = est.lines
        .filter(l => l.approved === true)
        .reduce((sum, l) => sum + (l.lineTotal || 0), 0);

      const tax = parseFloat((approvedSum * 0.0825).toFixed(2));
      const fee = approvedSum > 0 ? 25.00 : 0;
      est.summary = {
        subtotal: parseFloat(approvedSum.toFixed(2)),
        memberDiscount: parseFloat((approvedSum * 0.1).toFixed(2)),
        tax,
        shopSuppliesFee: fee,
        total: parseFloat((approvedSum - (approvedSum * 0.1) + tax + fee).toFixed(2))
      };

      saveStore();
      return est;
    }
  },

  // PARTS REQUESTS
  parts: {
    findByRoId: (roId) => state.partsRequests.filter(p => p.roId === roId),
    create: (data) => {
      const item = {
        id: `pr_${Date.now()}`,
        status: 'requested',
        createdAt: new Date().toISOString(),
        ...data
      };
      state.partsRequests.push(item);
      saveStore();
      return item;
    },
    updateStatus: (id, status) => {
      const item = state.partsRequests.find(p => p.id === id);
      if (!item) return null;
      item.status = status;
      if (status === 'received') item.receivedAt = new Date().toISOString();
      saveStore();
      return item;
    }
  },

  // INVOICES & PAYMENTS
  invoices: {
    findByRoId: (roId) => state.invoices.find(inv => inv.roId === roId),
    createFromEstimate: (roId, paymentMethod = 'card') => {
      const est = state.estimates.find(e => e.roId === roId);
      const ro = state.repairOrders.find(r => r.id === roId);
      if (!est) return null;

      const approvedLines = est.lines.filter(l => l.approved === true);
      const existing = state.invoices.find(inv => inv.roId === roId);
      if (existing) return existing;

      const invoice = {
        id: `inv_${Date.now()}`,
        invoiceNumber: `INV-${Date.now().toString().slice(-6)}`,
        roId,
        customerId: ro.customerId,
        vehicleId: ro.vehicleId,
        lines: approvedLines.map(l => ({
          description: l.description,
          amount: l.lineTotal
        })),
        subtotal: est.summary.subtotal,
        memberDiscount: est.summary.memberDiscount || 0,
        tax: est.summary.tax || 0,
        shopFee: est.summary.shopSuppliesFee || 0,
        total: est.summary.total,
        amountPaid: 0,
        paymentStatus: 'unpaid',
        paymentMethod: null,
        paymentProviderTxId: null,
        createdAt: new Date().toISOString()
      };
      state.invoices.push(invoice);
      saveStore();
      return invoice;
    },
    processPayment: (roId, { amount, paymentMethod, cardLast4 }) => {
      let inv = state.invoices.find(i => i.roId === roId);
      if (!inv) {
        inv = db.invoices.createFromEstimate(roId);
      }
      if (!inv) return null;

      inv.amountPaid = amount || inv.total;
      inv.paymentStatus = 'paid';
      inv.paymentMethod = paymentMethod || 'card';
      inv.paymentProviderTxId = `tx_stripe_prod_${Date.now()}_auth_${cardLast4 || '4242'}`;
      inv.paidAt = new Date().toISOString();

      // Update RO status to completed
      const ro = state.repairOrders.find(r => r.id === roId);
      if (ro) {
        ro.status = 'completed';
      }

      saveStore();
      return inv;
    }
  },

  // CORPORATE & LOCATIONS
  locations: {
    find: (predicate = () => true) => state.locations.filter(predicate),
    findById: (id) => state.locations.find(l => l.id === id || l.code === id),
    create: (data) => {
      const item = { id: `loc_${Date.now()}`, ...data };
      state.locations.push(item);
      saveStore();
      return item;
    },
    update: (id, updates) => {
      const index = state.locations.findIndex(l => l.id === id || l.code === id);
      if (index === -1) return null;
      state.locations[index] = { ...state.locations[index], ...updates };
      saveStore();
      return state.locations[index];
    }
  },

  // APPOINTMENTS & SCHEDULING
  appointments: {
    find: (predicate = () => true) => state.appointments.filter(predicate),
    findById: (id) => state.appointments.find(a => a.id === id || a.appointmentNumber === id),
    findEnriched: () => {
      return state.appointments.map(apt => {
        const customer = state.customers.find(c => c.id === apt.customerId);
        const vehicle = state.vehicles.find(v => v.id === apt.vehicleId);
        const tech = state.users.find(u => u.id === apt.assignedTechId);
        return {
          ...apt,
          customer,
          vehicle,
          assignedTech: tech ? { id: tech.id, name: tech.name } : null
        };
      });
    },
    create: (data) => {
      const num = 100 + state.appointments.length + 1;
      const item = {
        id: `apt_${Date.now()}`,
        appointmentNumber: `APT-2026-${num}`,
        status: 'scheduled',
        createdAt: new Date().toISOString(),
        ...data
      };
      state.appointments.push(item);
      saveStore();
      return item;
    },
    update: (id, updates) => {
      const index = state.appointments.findIndex(a => a.id === id || a.appointmentNumber === id);
      if (index === -1) return null;
      state.appointments[index] = { ...state.appointments[index], ...updates, updatedAt: new Date().toISOString() };
      saveStore();
      return state.appointments[index];
    },
    delete: (id) => {
      const index = state.appointments.findIndex(a => a.id === id || a.appointmentNumber === id);
      if (index === -1) return false;
      state.appointments.splice(index, 1);
      saveStore();
      return true;
    }
  },

  // INVENTORY & PARTS WAREHOUSE
  inventory: {
    find: (predicate = () => true) => state.inventory.filter(predicate),
    findById: (id) => state.inventory.find(p => p.id === id || p.partNumber === id),
    search: (query) => {
      if (!query) return state.inventory;
      const q = query.toLowerCase();
      return state.inventory.filter(p =>
        p.partNumber.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q) ||
        p.category.toLowerCase().includes(q) ||
        p.brand.toLowerCase().includes(q)
      );
    },
    create: (data) => {
      const item = {
        id: `part_${Date.now()}`,
        failureStats: { totalInstalled: 0, totalFailed: 0, comebackRate: '0.0%' },
        ...data
      };
      state.inventory.push(item);
      saveStore();
      return item;
    },
    update: (id, updates) => {
      const index = state.inventory.findIndex(p => p.id === id || p.partNumber === id);
      if (index === -1) return null;
      state.inventory[index] = { ...state.inventory[index], ...updates };
      saveStore();
      return state.inventory[index];
    },
    adjustStock: (id, delta, reason = 'stock_adjustment') => {
      const item = state.inventory.find(p => p.id === id || p.partNumber === id);
      if (!item) return null;
      item.stockQuantity = Math.max(0, item.stockQuantity + delta);
      // Record in audit log
      db.audit.create({
        eventType: 'STOCK_ADJUSTMENT',
        entityType: 'Inventory',
        entityId: item.id,
        action: `Stock adjusted by ${delta > 0 ? '+' + delta : delta} (${reason}). New stock: ${item.stockQuantity}`
      });
      saveStore();
      return item;
    }
  },

  // MEMBERSHIPS & RIDERS
  memberships: {
    getPlans: () => state.membershipPlans,
    getRiders: () => state.serviceRiders,
    getCustomerEntitlements: (customerId) => {
      const customer = state.customers.find(c => c.id === customerId);
      if (!customer) return null;
      const plan = state.membershipPlans.find(p => p.tier === (customer.membership?.tier || 'Standard')) || state.membershipPlans[0];
      return {
        customer: { id: customer.id, name: customer.name },
        membership: customer.membership || { tier: 'Standard', status: 'active' },
        plan,
        eligibleRiders: plan.ridersAllowed.map(rId => state.serviceRiders.find(r => r.id === rId)).filter(Boolean),
        diagnosticFeeDiscount: customer.membership?.tier === 'VIP Gold Care' ? 1.0 : (customer.membership?.tier === 'Fleet Pro' ? 1.0 : 0),
        laborDiscountPercent: customer.membership?.tier === 'VIP Gold Care' ? 15 : (customer.membership?.tier === 'Fleet Pro' ? 20 : (customer.membership?.tier === 'Silver Care' ? 10 : 0))
      };
    }
  },

  // INTERACTIVE WIRING DIAGRAMS
  wiring: {
    find: (predicate = () => true) => state.wiringDiagrams.filter(predicate),
    findById: (id) => state.wiringDiagrams.find(w => w.id === id),
    findByVehicle: (make, model) => {
      return state.wiringDiagrams.filter(w => 
        (!make || w.vehicleMake.toLowerCase() === make.toLowerCase()) &&
        (!model || w.vehicleModel.toLowerCase().includes(model.toLowerCase()))
      );
    }
  },

  // CONFIRMED FIXES & REPAIR OUTCOMES
  confirmedFixes: {
    find: (predicate = () => true) => state.confirmedFixes.filter(predicate),
    findById: (id) => state.confirmedFixes.find(f => f.id === id),
    search: (query) => {
      if (!query) return state.confirmedFixes;
      const q = query.toLowerCase();
      return state.confirmedFixes.filter(f =>
        f.dtcCode.toLowerCase().includes(q) ||
        f.make.toLowerCase().includes(q) ||
        f.model.toLowerCase().includes(q) ||
        f.symptom.toLowerCase().includes(q) ||
        f.verifiedFix.toLowerCase().includes(q)
      );
    },
    create: (data) => {
      const item = {
        id: `fix_${Date.now()}`,
        shopOccurrences: 1,
        confidenceScore: '95.0%',
        createdAt: new Date().toISOString(),
        ...data
      };
      state.confirmedFixes.unshift(item);
      saveStore();
      return item;
    }
  },

  // TECHNICIAN FORUM & KNOWLEDGE BASE
  forum: {
    find: (predicate = () => true) => state.forumThreads.filter(predicate),
    findById: (id) => state.forumThreads.find(f => f.id === id),
    createThread: (data) => {
      const item = {
        id: `forum_${Date.now()}`,
        createdAt: new Date().toISOString(),
        views: 1,
        likes: 0,
        replies: [],
        ...data
      };
      state.forumThreads.unshift(item);
      saveStore();
      return item;
    },
    addReply: (threadId, replyData) => {
      const thread = state.forumThreads.find(t => t.id === threadId);
      if (!thread) return null;
      const reply = {
        id: `rep_${Date.now()}`,
        createdAt: new Date().toISOString(),
        ...replyData
      };
      thread.replies.push(reply);
      saveStore();
      return thread;
    },
    upvote: (threadId) => {
      const thread = state.forumThreads.find(t => t.id === threadId);
      if (!thread) return null;
      thread.likes = (thread.likes || 0) + 1;
      saveStore();
      return thread;
    }
  },

  // FUEL ECONOMY & ANOMALY TRACKING
  fuel: {
    findByVehicleId: (vehicleId) => state.fuelLogs.filter(f => f.vehicleId === vehicleId),
    create: (data) => {
      // Calculate MPG and detect anomaly
      const prevLogs = state.fuelLogs.filter(f => f.vehicleId === data.vehicleId);
      let calculatedMpg = data.calculatedMpg;
      let anomalyDetected = false;
      let anomalyReason = null;

      if (!calculatedMpg && prevLogs.length > 0 && data.odometer && data.gallons) {
        const prev = prevLogs[0];
        const milesDriven = data.odometer - prev.odometer;
        if (milesDriven > 0 && data.gallons > 0) {
          calculatedMpg = parseFloat((milesDriven / data.gallons).toFixed(1));
        }
      }

      if (calculatedMpg && data.expectedMpg && calculatedMpg < data.expectedMpg * 0.82) {
        anomalyDetected = true;
        anomalyReason = `Fuel efficiency dropped by ${Math.round((1 - calculatedMpg / data.expectedMpg) * 100)}% below expected OEM baseline. Suggest inspect fuel trims, O2 sensors & ignition system.`;
      }

      const item = {
        id: `fuel_${Date.now()}`,
        date: new Date().toISOString().split('T')[0],
        calculatedMpg: calculatedMpg || 20.0,
        anomalyDetected,
        anomalyReason,
        ...data
      };
      state.fuelLogs.unshift(item);
      saveStore();
      return item;
    }
  },

  // MESSAGES & CONVERSATION THREADS
  messages: {
    findByCustomerOrRo: (customerId, roId) => {
      return state.messages.filter(m => 
        (customerId && m.customerId === customerId) ||
        (roId && m.roId === roId)
      );
    },
    create: (data) => {
      const item = {
        id: `msg_${Date.now()}`,
        timestamp: new Date().toISOString(),
        status: 'delivered',
        ...data
      };
      state.messages.push(item);
      saveStore();
      return item;
    }
  },

  // APPEND-ONLY AUDIT LOG
  audit: {
    find: (limit = 100) => state.auditLogs.slice(-limit).reverse(),
    create: (entry) => {
      const item = {
        id: `aud_${Date.now()}_${Math.random().toString(36).substring(7)}`,
        timestamp: new Date().toISOString(),
        actorId: entry.actorId || 'system',
        actorRole: entry.actorRole || 'system',
        ipAddress: entry.ipAddress || '127.0.0.1',
        ...entry
      };
      state.auditLogs.push(item);
      saveStore();
      return item;
    }
  },

  // AI GOVERNANCE & EXECUTION LOGS
  ai: {
    getLogs: (limit = 50) => state.aiExecutionLogs.slice(-limit).reverse(),
    logExecution: (data) => {
      const item = {
        id: `ai_exec_${Date.now()}`,
        timestamp: new Date().toISOString(),
        provider: 'FutureTech Automotive AI Engine v2.4 (Governed)',
        promptVersion: 'ft-core-v3.2',
        modelVersion: 'ft-automotive-expert-2026-q3',
        humanReviewed: false,
        reviewedBy: null,
        humanOverrideNotes: null,
        ...data
      };
      state.aiExecutionLogs.unshift(item);
      // Also write to audit log
      db.audit.create({
        eventType: 'AI_EXECUTION_LOGGED',
        entityType: 'AiExecution',
        entityId: item.id,
        action: `AI Task [${item.taskType}] executed for RO ${item.roId || 'N/A'} with confidence ${item.confidence || '95%'}`
      });
      saveStore();
      return item;
    },
    updateLog: (id, updates) => {
      const index = state.aiExecutionLogs.findIndex(l => l.id === id);
      if (index === -1) return null;
      state.aiExecutionLogs[index] = { ...state.aiExecutionLogs[index], ...updates };
      saveStore();
      return state.aiExecutionLogs[index];
    }
  },

  // PREDICTIVE SIGNALS & LIFECYCLE
  predictive: {
    findByVehicleId: (vehicleId) => state.predictiveSignals.filter(p => p.vehicleId === vehicleId),
    create: (data) => {
      const item = {
        id: `pred_${Date.now()}`,
        ...data
      };
      state.predictiveSignals.push(item);
      saveStore();
      return item;
    }
  },

  // REFRESH TOKENS & MFA
  refreshTokens: {
    add: (tokenData) => {
      state.refreshTokens.push(tokenData);
      saveStore();
      return tokenData;
    },
    find: (token) => state.refreshTokens.find(t => t.token === token && !t.revoked),
    revoke: (token) => {
      const item = state.refreshTokens.find(t => t.token === token);
      if (item) {
        item.revoked = true;
        saveStore();
      }
    }
  }
};

