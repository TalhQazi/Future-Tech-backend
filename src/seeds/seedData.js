export const seedUsers = [
  {
    id: "usr_advisor_1",
    name: "Sarah Jenkins",
    email: "advisor@futuretech.com",
    password: "password123", // In production hashed via bcrypt
    role: "advisor",
    phone: "555-0101",
    avatar: "https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?w=150&auto=format&fit=crop&q=80"
  },
  {
    id: "usr_tech_1",
    name: "Marcus Vance",
    email: "tech@futuretech.com",
    password: "password123",
    role: "technician",
    phone: "555-0102",
    specialty: "Master Diagnostics / High Voltage & Powertrain",
    avatar: "https://images.unsplash.com/photo-1560250097-0b93528c311a?w=150&auto=format&fit=crop&q=80"
  },
  {
    id: "usr_manager_1",
    name: "Dave Reynolds",
    email: "manager@futuretech.com",
    password: "password123",
    role: "manager",
    phone: "555-0103",
    avatar: "https://images.unsplash.com/photo-1519085360753-af0119f7cbe7?w=150&auto=format&fit=crop&q=80"
  },
  {
    id: "usr_cust_1",
    name: "Elena Rostova",
    email: "customer@futuretech.com",
    password: "password123",
    role: "customer",
    phone: "555-0192",
    avatar: "https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=150&auto=format&fit=crop&q=80"
  }
];

export const seedCustomers = [
  {
    id: "cust_1",
    userId: "usr_cust_1",
    name: "Elena Rostova",
    phone: "555-0192",
    email: "elena.rostova@example.com",
    address: "742 Evergreen Terrace, Bayview, CA",
    membership: {
      tier: "VIP Gold Care",
      status: "active",
      number: "MBR-88291",
      renewDate: "2027-01-15",
      benefits: ["Free Diagnostics ($149 val)", "15% Off Labor", "Complimentary Loaner Vehicle", "Priority Bay Scheduling"]
    },
    notes: "Customer prefers text updates. Always inspect tire pressure on right rear."
  },
  {
    id: "cust_2",
    name: "Michael Chang",
    phone: "555-0381",
    email: "mchang.transport@example.com",
    address: "1204 Industrial Pkwy, Bayview, CA",
    membership: {
      tier: "Fleet Pro",
      status: "active",
      number: "MBR-44102",
      renewDate: "2026-11-30",
      benefits: ["Dedicated Tech", "Consolidated Monthly Invoicing", "Same-Day Turnaround Guarantee"]
    },
    notes: "Contractor fleet. Keep old parts in box for quarterly review."
  },
  {
    id: "cust_3",
    name: "Sarah Connor",
    phone: "555-0842",
    email: "sarah.c@skytech.io",
    address: "492 Foothill Blvd, Oakland, CA",
    membership: {
      tier: "Standard",
      status: "inactive",
      number: "MBR-10293",
      renewDate: "2025-08-10",
      benefits: ["Standard Shop Warranty"]
    },
    notes: "Walk-in referral from Mike's transmission."
  }
];

export const seedVehicles = [
  {
    id: "veh_1",
    customerId: "cust_1",
    vin: "WA1VAAF75ND019284",
    make: "Audi",
    model: "Q7 3.0T Quattro",
    year: 2022,
    trim: "Prestige AWD",
    licensePlate: "8XYZ21",
    mileage: 42150,
    color: "Daytona Gray Pearl",
    engine: "3.0L Turbocharged V6 Mild Hybrid",
    healthScore: 68,
    status: "in_shop",
    lastServiceDate: "2026-06-12"
  },
  {
    id: "veh_2",
    customerId: "cust_2",
    vin: "1FTFW1ED4MFA92831",
    make: "Ford",
    model: "F-150 PowerBoost",
    year: 2021,
    trim: "Lariat 4x4",
    licensePlate: "TRK-992",
    mileage: 64800,
    color: "Agate Black",
    engine: "3.5L V6 Full Hybrid",
    healthScore: 84,
    status: "in_shop",
    lastServiceDate: "2026-08-04"
  },
  {
    id: "veh_3",
    customerId: "cust_3",
    vin: "2T3C1RFV9LW094821",
    make: "Toyota",
    model: "RAV4 Hybrid",
    year: 2020,
    trim: "XSE AWD",
    licensePlate: "7ABC345",
    mileage: 38200,
    color: "Blueprint Blue",
    engine: "2.5L 4-Cylinder Hybrid",
    healthScore: 92,
    status: "in_shop",
    lastServiceDate: "2026-04-18"
  },
  {
    id: "veh_4",
    customerId: "cust_1",
    vin: "7SAYGDEE1PF829103",
    make: "Tesla",
    model: "Model Y",
    year: 2023,
    trim: "Long Range Dual Motor",
    licensePlate: "EV-4402",
    mileage: 18900,
    color: "Deep Blue Metallic",
    engine: "Dual Electric AC Induction/PMAC",
    healthScore: 95,
    status: "ready_for_pickup",
    lastServiceDate: "2026-09-01"
  }
];

export const seedRepairOrders = [
  {
    id: "ro_1",
    roNumber: "RO-2026-081",
    customerId: "cust_1",
    vehicleId: "veh_1",
    advisorId: "usr_advisor_1",
    assignedTechId: "usr_tech_1",
    bayNumber: "Bay 3 (Diagnostics Lift)",
    status: "in_progress", // checked_in, inspection, estimate_pending, work_authorized, in_progress, ready_for_payment, completed
    odometerIn: 42150,
    fuelLevel: "3/4",
    customerComplaints: [
      "Check engine light flashing on acceleration highway speeds",
      "Noticeable engine shudder / hesitation between 45-60 mph",
      "Routine 40,000-mile multi-point digital inspection requested"
    ],
    advisorNotes: "VIP Member customer. Needs loaner car returned by 5:30 PM. Advised Marcus to pull live freeze frame on Cyl 2 misfire.",
    createdAt: "2026-10-13T08:30:00.000Z",
    targetCompletion: "2026-10-13T17:00:00.000Z"
  },
  {
    id: "ro_2",
    roNumber: "RO-2026-082",
    customerId: "cust_2",
    vehicleId: "veh_2",
    advisorId: "usr_advisor_1",
    assignedTechId: "usr_tech_1",
    bayNumber: "Bay 1 (Alignment & Suspension)",
    status: "inspection",
    odometerIn: 64800,
    fuelLevel: "1/2",
    customerComplaints: [
      "Squealing metallic noise from front left wheel when braking",
      "Slight steering wobble during moderate deceleration",
      "Rough idle upon first morning cold start"
    ],
    advisorNotes: "Fleet commercial truck - driver has heavy payload route tomorrow morning.",
    createdAt: "2026-10-13T09:15:00.000Z",
    targetCompletion: "2026-10-13T16:00:00.000Z"
  },
  {
    id: "ro_3",
    roNumber: "RO-2026-083",
    customerId: "cust_3",
    vehicleId: "veh_3",
    advisorId: "usr_advisor_1",
    assignedTechId: "usr_tech_1",
    bayNumber: "Bay 2",
    status: "estimate_pending",
    odometerIn: 38200,
    fuelLevel: "Full",
    customerComplaints: [
      "Scheduled factory maintenance: Oil & Filter change",
      "Brake pedal feel soft",
      "Cabin air smells musty when A/C turns on"
    ],
    advisorNotes: "Estimate sent to customer phone via portal link. Awaiting line-item approval.",
    createdAt: "2026-10-13T10:00:00.000Z",
    targetCompletion: "2026-10-13T15:00:00.000Z"
  },
  {
    id: "ro_4",
    roNumber: "RO-2026-084",
    customerId: "cust_1",
    vehicleId: "veh_4",
    advisorId: "usr_advisor_1",
    assignedTechId: "usr_tech_1",
    bayNumber: "Bay 4 (EV Clean Room)",
    status: "ready_for_payment",
    odometerIn: 18900,
    fuelLevel: "88% SOC",
    customerComplaints: [
      "Annual EV Health Checkup + Cabin BioDefense Filter Replacement",
      "Check tire wear pattern and perform cross-rotation"
    ],
    advisorNotes: "All work completed and road tested. Customer notified via portal SMS.",
    createdAt: "2026-10-13T07:45:00.000Z",
    targetCompletion: "2026-10-13T12:00:00.000Z"
  }
];

export const seedInspections = [
  {
    id: "insp_1",
    roId: "ro_1",
    vehicleId: "veh_1",
    techId: "usr_tech_1",
    status: "completed",
    completedAt: "2026-10-13T10:30:00.000Z",
    summary: { pass: 14, attention: 2, fail: 2 },
    items: [
      {
        id: "item_1",
        category: "Under Hood & Fluids",
        name: "Ignition System & Coil Packs",
        status: "fail",
        finding: "Ignition coil #2 showing internal dielectric breakdown and secondary arc tracing. Causing P0302 misfire.",
        recommendation: "Replace ignition coil #2 and install 6 new OEM Bosch iridium spark plugs.",
        photoUrl: "https://images.unsplash.com/photo-1486006920555-c77dce18193b?w=600&auto=format&fit=crop&q=80"
      },
      {
        id: "item_2",
        category: "Brakes & Stopping",
        name: "Front Brake Pads & Rotors",
        status: "fail",
        finding: "Front inner pads measured at 2.8mm (minimum discard is 3.0mm). Rotor lip has 1.2mm ridge.",
        recommendation: "Replace front brake pads & ceramic compound rotors with wear sensors.",
        photoUrl: "https://images.unsplash.com/photo-1558981403-c5f9899a28bc?w=600&auto=format&fit=crop&q=80"
      },
      {
        id: "item_3",
        category: "Brakes & Stopping",
        name: "Rear Brake Pads & Rotors",
        status: "pass",
        finding: "Rear pads measured at 7.0mm. Rotors smooth, no heat discoloration.",
        recommendation: "Satisfactory. Re-inspect at next 10,000 mi service."
      },
      {
        id: "item_4",
        category: "Tires & Suspension",
        name: "Tire Tread Depth & Condition",
        status: "attention",
        finding: "Right front tire shows slight inner shoulder feathering. Depth: 5/32nds. Other tires 6/32nds.",
        recommendation: "Perform 4-wheel computerized alignment to protect tire lifespan.",
        photoUrl: "https://images.unsplash.com/photo-1578844251758-2f71da64c96f?w=600&auto=format&fit=crop&q=80"
      },
      {
        id: "item_5",
        category: "Battery & Electrical",
        name: "12V AGM Starter & 48V Hybrid Battery",
        status: "pass",
        finding: "12V battery test: 820 CCA rated, tested 805 CCA. 48V lithium pack health at 96% state-of-health.",
        recommendation: "Charging system normal, no parasitic draw detected."
      },
      {
        id: "item_6",
        category: "Under Hood & Fluids",
        name: "Engine Oil & Filter Condition",
        status: "attention",
        finding: "Oil level at lower mark, dark amber color with slight fuel dilution odor from misfire.",
        recommendation: "Complete synthetic oil change (0W-20 508.00 spec) + filter cartridge.",
        photoUrl: "https://images.unsplash.com/photo-1635770311752-6d6006f851d7?w=600&auto=format&fit=crop&q=80"
      },
      {
        id: "item_7",
        category: "Exterior & Lighting",
        name: "Headlights, Signal Lamps & Wiper Blades",
        status: "pass",
        finding: "All LED matrix functions operational. Wiper blades clear without streaking.",
        recommendation: "Pass."
      }
    ]
  },
  {
    id: "insp_2",
    roId: "ro_2",
    vehicleId: "veh_2",
    techId: "usr_tech_1",
    status: "in_progress",
    summary: { pass: 5, attention: 1, fail: 1 },
    items: [
      {
        id: "item_201",
        category: "Brakes & Stopping",
        name: "Front Left Brake Assembly",
        status: "fail",
        finding: "Front left pad worn down to metal backing plate. Heavy scoring on brake disc surface.",
        recommendation: "Immediate replacement of front pads and vented rotors required.",
        photoUrl: "https://images.unsplash.com/photo-1558981403-c5f9899a28bc?w=600&auto=format&fit=crop&q=80"
      },
      {
        id: "item_202",
        category: "Tires & Suspension",
        name: "Front Wheel Bearing & Tie Rods",
        status: "pass",
        finding: "Ball joints, tie rod ends, and wheel bearings tight with zero play.",
        recommendation: "Suspension components intact."
      }
    ]
  }
];

export const seedFutureTechDiagnostics = [
  {
    id: "diag_1",
    roId: "ro_1",
    vehicleId: "veh_1",
    scanToolConnected: true,
    protocol: "CAN Bus ISO 15765-4 / UDS",
    ecuDetected: "Bosch MD1CP004 ECM + Hybrid Gateway",
    healthScore: 68,
    liveTelemetry: {
      batteryVoltage: 14.1,
      coolantTempF: 198,
      rpm: 780,
      oilPressurePsi: 38,
      fuelRailPsi: 2150,
      shortTermFuelTrimPercent: "+14.2%"
    },
    dtcCodes: [
      {
        code: "P0302",
        system: "Powertrain / Ignition",
        description: "Cylinder 2 Misfire Detected",
        severity: "critical", // critical, warning, advisory
        status: "active",
        milTriggered: true,
        freezeFrame: {
          rpm: "2,140 RPM",
          vehicleSpeed: "52 MPH",
          coolantTemp: "198°F",
          engineLoad: "64.2%",
          fuelTrimBank1: "+14.2%",
          manifoldPressure: "18.4 PSI"
        },
        possibleCauses: [
          "Defective Ignition Coil on Cylinder 2",
          "Fouled or worn spark plug electrode",
          "Direct injection fuel injector clogging or spray imbalance",
          "Intake runner valve carbon accumulation"
        ]
      },
      {
        code: "P0171",
        system: "Fuel & Air Metering",
        description: "System Too Lean (Bank 1)",
        severity: "warning",
        status: "pending",
        milTriggered: false,
        freezeFrame: {
          rpm: "1,850 RPM",
          vehicleSpeed: "44 MPH",
          coolantTemp: "194°F",
          longTermFuelTrim: "+18.5%"
        },
        possibleCauses: [
          "Unmetered air past MAF sensor",
          "PCV diaphragm failure",
          "Secondary effect of Cyl 2 raw oxygen entering exhaust"
        ]
      },
      {
        code: "U0100",
        system: "Network & Gateway",
        description: "Lost Communication with ECM/PCM (Historical Event)",
        severity: "advisory",
        status: "history",
        milTriggered: false,
        freezeFrame: null,
        possibleCauses: [
          "Intermittent 12V bus voltage dip during cold start",
          "CAN wiring connector high resistance (cleared after self-test)"
        ]
      }
    ],
    guidedChecks: [
      {
        id: "chk_1",
        stepNumber: 1,
        title: "Ignition Coil Swap Isolation Test",
        instructions: "Swap Ignition Coil #2 with Ignition Coil #1. Clear active DTC, run bi-directional road load simulation cycle, observe misfire counter.",
        status: "passed",
        technicianFindings: "Misfire counter immediately transferred from Cyl 2 to Cyl 1. Confirms defective coil #2 internal secondary winding breakdown.",
        completedAt: "2026-10-13T09:40:00.000Z"
      },
      {
        id: "chk_2",
        stepNumber: 2,
        title: "Spark Plug Gap & Micro-Inspection",
        instructions: "Remove spark plugs #1 through #6. Check electrode wear, ceramic insulator integrity, and measure gap against 0.7mm OEM spec.",
        status: "failed",
        technicianFindings: "Plugs show severe center electrode erosion; gap enlarged to 1.15mm (spec: 0.7mm). Carbon build-up on porcelain. Replace full set of 6.",
        completedAt: "2026-10-13T10:05:00.000Z"
      },
      {
        id: "chk_3",
        stepNumber: 3,
        title: "Intake Smoke Test & Vacuum Integrity",
        instructions: "Introduce mineral oil smoke at throttle inlet at 1.5 PSI. Inspect PCV breather hoses, intercooler couplings, and intake gasket seams.",
        status: "passed",
        technicianFindings: "Zero smoke leakage detected. PCV valve membrane intact. Lean code P0171 was caused by unburned O2 from misfiring cylinder.",
        completedAt: "2026-10-13T10:20:00.000Z"
      }
    ],
    techDiagnosticNotes: "Root cause verified: Faulty ignition coil #2 compounded by worn spark plugs (42k miles on high boost). After coil & spark plug renewal, vehicle will perform adaptation re-learn and fuel trim resets."
  }
];

export const seedEstimates = [
  {
    id: "est_1",
    roId: "ro_1",
    estimateNumber: "EST-8101",
    status: "approved", // draft, sent, approved, partially_approved, declined
    createdAt: "2026-10-13T10:45:00.000Z",
    customerApprovedAt: "2026-10-13T11:05:00.000Z",
    customerSignature: "Elena Rostova (Digital Auth via SMS)",
    lines: [
      {
        id: "line_1",
        type: "part",
        description: "OEM Ignition Coil Pack (Cylinder 2 Replacement)",
        partNumber: "BOS-0221604115",
        quantity: 1,
        unitPrice: 118.50,
        laborHours: 0,
        laborRate: 0,
        approved: true,
        lineTotal: 118.50,
        notes: "OEM Bosch high-output coil pack"
      },
      {
        id: "line_2",
        type: "part",
        description: "Bosch Double Iridium Spark Plugs (Full Set of 6)",
        partNumber: "BOS-9614-6PK",
        quantity: 6,
        unitPrice: 19.50,
        laborHours: 0,
        laborRate: 0,
        approved: true,
        lineTotal: 117.00,
        notes: "Factory spec laser-welded iridium"
      },
      {
        id: "line_3",
        type: "labor",
        description: "Diagnostic Labor & Ignition Tune (Plugs + Coil Installation + Adaptation)",
        partNumber: "LAB-TUNE-V6",
        quantity: 1,
        unitPrice: 0,
        laborHours: 1.8,
        laborRate: 175.00,
        approved: true,
        lineTotal: 315.00,
        notes: "FutureTech guided troubleshooting + test validation"
      },
      {
        id: "line_4",
        type: "part",
        description: "Front Ceramic Brake Pad Set & Electronic Wear Sensors",
        partNumber: "BRK-AUD-F42",
        quantity: 1,
        unitPrice: 185.00,
        laborHours: 0,
        laborRate: 0,
        approved: true,
        lineTotal: 185.00,
        notes: "Low-dust premium ceramic compound"
      },
      {
        id: "line_5",
        type: "part",
        description: "Front Vented Geomet-Coated Brake Rotors (Pair)",
        partNumber: "ROT-375MM-PR",
        quantity: 2,
        unitPrice: 165.00,
        laborHours: 0,
        laborRate: 0,
        approved: true,
        lineTotal: 330.00,
        notes: "375mm high-carbon rotors"
      },
      {
        id: "line_6",
        type: "labor",
        description: "Front Brake Service Labor (Pads, Rotors, Caliper Slide Lube & Bleed)",
        partNumber: "LAB-BRK-FRT",
        quantity: 1,
        unitPrice: 0,
        laborHours: 2.0,
        laborRate: 175.00,
        approved: true,
        lineTotal: 350.00,
        notes: "Torque to factory specifications"
      },
      {
        id: "line_7",
        type: "labor",
        description: "4-Wheel Precision Laser Computerized Alignment",
        partNumber: "LAB-ALIGN-4W",
        quantity: 1,
        unitPrice: 0,
        laborHours: 1.2,
        laborRate: 175.00,
        approved: false, // Customer chose to decline alignment this visit
        lineTotal: 210.00,
        notes: "Recommended due to feathering on right front tire"
      }
    ],
    summary: {
      subtotal: 1415.50, // for approved lines: 118.50 + 117 + 315 + 185 + 330 + 350 = 1415.50
      memberDiscount: 147.75, // 15% VIP labor discount on approved labor ($665 * 15% = $99.75) + free diagnostic credit ($48)
      tax: 62.45,
      shopSuppliesFee: 35.00,
      total: 1365.20
    }
  },
  {
    id: "est_3",
    roId: "ro_3",
    estimateNumber: "EST-8103",
    status: "sent",
    createdAt: "2026-10-13T10:15:00.000Z",
    customerApprovedAt: null,
    lines: [
      {
        id: "line_301",
        type: "part",
        description: "Toyota Genuine 0W-16 Synthetic Motor Oil (5 Qts)",
        partNumber: "OIL-0W16-5Q",
        quantity: 1,
        unitPrice: 48.00,
        laborHours: 0,
        laborRate: 0,
        approved: null,
        lineTotal: 48.00
      },
      {
        id: "line_302",
        type: "part",
        description: "OEM Toyota Oil Filter & Drain Plug Washer",
        partNumber: "FLT-04152-YZZA1",
        quantity: 1,
        unitPrice: 12.50,
        laborHours: 0,
        laborRate: 0,
        approved: null,
        lineTotal: 12.50
      },
      {
        id: "line_303",
        type: "labor",
        description: "Synthetic Lube, Oil & Filter Service + DVI Inspection",
        partNumber: "LAB-LOF-SYN",
        quantity: 1,
        unitPrice: 0,
        laborHours: 0.6,
        laborRate: 160.00,
        approved: null,
        lineTotal: 96.00
      },
      {
        id: "line_304",
        type: "part",
        description: "HEPA Cabin Air Filter with Activated Carbon",
        partNumber: "CAB-87139-0E040",
        quantity: 1,
        unitPrice: 34.00,
        laborHours: 0,
        laborRate: 0,
        approved: null,
        lineTotal: 34.00
      }
    ],
    summary: {
      subtotal: 190.50,
      memberDiscount: 0,
      tax: 8.51,
      shopSuppliesFee: 12.00,
      total: 211.01
    }
  }
];

export const seedPartsRequests = [
  {
    id: "pr_1",
    roId: "ro_1",
    techId: "usr_tech_1",
    partName: "Bosch Ignition Coil Pack (Cyl 2)",
    partNumber: "BOS-0221604115",
    quantity: 1,
    urgency: "urgent",
    status: "received", // requested, ordered, received, installed
    bayNumber: "Bay 3",
    vendor: "WorldPac Parts",
    cost: 72.00,
    retail: 118.50,
    orderedAt: "2026-10-13T10:10:00.000Z",
    receivedAt: "2026-10-13T11:15:00.000Z"
  },
  {
    id: "pr_2",
    roId: "ro_1",
    techId: "usr_tech_1",
    partName: "Bosch Double Iridium Spark Plugs Set",
    partNumber: "BOS-9614-6PK",
    quantity: 6,
    urgency: "normal",
    status: "received",
    bayNumber: "Bay 3",
    vendor: "WorldPac Parts",
    cost: 65.00,
    retail: 117.00,
    orderedAt: "2026-10-13T10:10:00.000Z",
    receivedAt: "2026-10-13T11:15:00.000Z"
  },
  {
    id: "pr_3",
    roId: "ro_1",
    techId: "usr_tech_1",
    partName: "Front Brake Pads & Rotor Kit",
    partNumber: "BRK-AUD-F42",
    quantity: 1,
    urgency: "normal",
    status: "installed",
    bayNumber: "Bay 3",
    vendor: "Audi OEM Direct",
    cost: 310.00,
    retail: 515.00,
    orderedAt: "2026-10-13T11:10:00.000Z",
    receivedAt: "2026-10-13T12:00:00.000Z"
  }
];

export const seedInvoices = [
  {
    id: "inv_4",
    invoiceNumber: "INV-2026-084",
    roId: "ro_4",
    customerId: "cust_1",
    vehicleId: "veh_4",
    lines: [
      { description: "EV Annual Multi-Point Diagnostic Health Scan", amount: 0, note: "Complimentary with VIP Gold Care" },
      { description: "Tesla Model Y High-Efficiency BioDefense HEPA Filter", amount: 75.00 },
      { description: "Labor - HEPA Filter Replacement & Clean Duct System", amount: 65.00 },
      { description: "Tire Rotation & Pressure Sensor Calibration", amount: 35.00 }
    ],
    subtotal: 175.00,
    memberDiscount: 20.00,
    tax: 6.75,
    shopFee: 10.00,
    total: 171.75,
    amountPaid: 171.75,
    paymentStatus: "paid", // unpaid, paid, refunded
    paymentMethod: "card",
    paymentProviderTxId: "tx_mock_stripe_99214_success",
    paidAt: "2026-10-13T11:45:00.000Z"
  }
];

export const seedLocations = [
  {
    id: "loc_flagship",
    name: "FutureTech & Membership Auto Flagship",
    code: "FT-BAY-01",
    address: "850 AutoMall Boulevard, Suite 100",
    city: "Bayview",
    state: "CA",
    zip: "94016",
    phone: "(615) 555-0100",
    email: "bayview@futuretech.com",
    baysCount: 8,
    bays: [
      { id: "bay_1", name: "Bay 1 - Alignment & Suspension", type: "alignment", occupiedRoId: "ro_2" },
      { id: "bay_2", name: "Bay 2 - Express Service & Lube", type: "lube", occupiedRoId: "ro_3" },
      { id: "bay_3", name: "Bay 3 - Master Diagnostics Lift", type: "diagnostics", occupiedRoId: "ro_1" },
      { id: "bay_4", name: "Bay 4 - EV / Hybrid High Voltage Clean Room", type: "ev_hybrid", occupiedRoId: "ro_4" },
      { id: "bay_5", name: "Bay 5 - Heavy Powertrain & Transmission", type: "powertrain", occupiedRoId: null },
      { id: "bay_6", name: "Bay 6 - Brake & Tire Precision", type: "general", occupiedRoId: null },
      { id: "bay_7", name: "Bay 7 - ADAS Calibration & Vision Bay", type: "adas", occupiedRoId: null },
      { id: "bay_8", name: "Bay 8 - Quick Intake & DVI Station", type: "intake", occupiedRoId: null }
    ],
    salesTaxRate: 0.0825,
    laborRateStandard: 175.00,
    laborRateDiagnostics: 195.00,
    laborRateEv: 215.00,
    operatingHours: "Mon-Fri: 7:30 AM - 6:00 PM, Sat: 8:00 AM - 4:00 PM, Sun: Closed"
  },
  {
    id: "loc_oakland",
    name: "FutureTech East Bay Service Center",
    code: "FT-OAK-02",
    address: "2200 Broadway Center",
    city: "Oakland",
    state: "CA",
    zip: "94612",
    phone: "(510) 555-0200",
    email: "oakland@futuretech.com",
    baysCount: 6,
    bays: [
      { id: "bay_o1", name: "Bay 1 - Quick Service", type: "lube", occupiedRoId: null },
      { id: "bay_o2", name: "Bay 2 - Master Tech Lift", type: "diagnostics", occupiedRoId: null },
      { id: "bay_o3", name: "Bay 3 - Brake & Chassis", type: "general", occupiedRoId: null },
      { id: "bay_o4", name: "Bay 4 - Electrical & CAN Diagnostic", type: "diagnostics", occupiedRoId: null },
      { id: "bay_o5", name: "Bay 5 - General Mechanical", type: "general", occupiedRoId: null },
      { id: "bay_o6", name: "Bay 6 - Alignment Center", type: "alignment", occupiedRoId: null }
    ],
    salesTaxRate: 0.0925,
    laborRateStandard: 185.00,
    laborRateDiagnostics: 210.00,
    laborRateEv: 225.00,
    operatingHours: "Mon-Fri: 8:00 AM - 6:00 PM, Sat: 8:00 AM - 2:00 PM, Sun: Closed"
  }
];

export const seedAppointments = [
  {
    id: "apt_1",
    appointmentNumber: "APT-2026-101",
    customerId: "cust_1",
    vehicleId: "veh_1",
    scheduledDate: "2026-10-14",
    scheduledTime: "08:30 AM",
    serviceRequested: "Check Engine Light Diagnostics & Ignition Misfire Investigation",
    status: "checked_in", // scheduled, confirmed, checked_in, completed, cancelled
    assignedBay: "Bay 3 (Diagnostics Lift)",
    assignedTechId: "usr_tech_1",
    estimatedHours: 2.5,
    customerNotes: "VIP Gold member. Requires loaner vehicle.",
    roId: "ro_1"
  },
  {
    id: "apt_2",
    appointmentNumber: "APT-2026-102",
    customerId: "cust_2",
    vehicleId: "veh_2",
    scheduledDate: "2026-10-14",
    scheduledTime: "09:15 AM",
    serviceRequested: "Front Brake Squeal & Heavy Load Rotor Inspection",
    status: "checked_in",
    assignedBay: "Bay 1 (Alignment & Suspension)",
    assignedTechId: "usr_tech_1",
    estimatedHours: 2.0,
    customerNotes: "Fleet contractor commercial truck. Fast turnaround requested.",
    roId: "ro_2"
  },
  {
    id: "apt_3",
    appointmentNumber: "APT-2026-103",
    customerId: "cust_3",
    vehicleId: "veh_3",
    scheduledDate: "2026-10-14",
    scheduledTime: "10:00 AM",
    serviceRequested: "40,000-Mile Factory Lube, Oil, Filter & DVI Inspection",
    status: "checked_in",
    assignedBay: "Bay 2",
    assignedTechId: "usr_tech_1",
    estimatedHours: 1.0,
    customerNotes: "Customer waiting in lounge.",
    roId: "ro_3"
  },
  {
    id: "apt_4",
    appointmentNumber: "APT-2026-104",
    customerId: "cust_1",
    vehicleId: "veh_1",
    scheduledDate: "2026-10-15",
    scheduledTime: "01:30 PM",
    serviceRequested: "Follow-Up 4-Wheel Computerized Precision Laser Alignment",
    status: "scheduled",
    assignedBay: "Bay 1 (Alignment & Suspension)",
    assignedTechId: "usr_tech_1",
    estimatedHours: 1.5,
    customerNotes: "Recommended alignment declined during initial misfire repair.",
    roId: null
  },
  {
    id: "apt_5",
    appointmentNumber: "APT-2026-105",
    customerId: "cust_2",
    vehicleId: "veh_2",
    scheduledDate: "2026-10-16",
    scheduledTime: "11:00 AM",
    serviceRequested: "Fleet Pro Quarterly Multipoint Safety & Telematics Sync",
    status: "confirmed",
    assignedBay: "Bay 5",
    assignedTechId: "usr_tech_1",
    estimatedHours: 1.8,
    customerNotes: "Fleet preventative schedule.",
    roId: null
  }
];

export const seedInventory = [
  {
    id: "part_1",
    partNumber: "BOS-0221604115",
    description: "OEM Ignition Coil Pack (Audi 3.0T V6 / EA839)",
    category: "Ignition & Electrical",
    brand: "Bosch Original",
    supplier: "WorldPac Parts Wholesale",
    costPrice: 72.00,
    retailPrice: 118.50,
    stockQuantity: 14,
    minStockLevel: 4,
    binLocation: "Aisle 3, Shelf B, Bin 12",
    warrantyMonths: 24,
    failureStats: { totalInstalled: 182, totalFailed: 3, comebackRate: "1.6%" }
  },
  {
    id: "part_2",
    partNumber: "BOS-9614-6PK",
    description: "Double Iridium Spark Plugs (Laser Welded 0.7mm Gap)",
    category: "Ignition & Electrical",
    brand: "Bosch",
    supplier: "WorldPac Parts Wholesale",
    costPrice: 65.00,
    retailPrice: 117.00,
    stockQuantity: 28,
    minStockLevel: 8,
    binLocation: "Aisle 3, Shelf B, Bin 14",
    warrantyMonths: 36,
    failureStats: { totalInstalled: 410, totalFailed: 1, comebackRate: "0.2%" }
  },
  {
    id: "part_3",
    partNumber: "BRK-AUD-F42",
    description: "Front Ceramic Brake Pad Set with Electronic Wear Sensors",
    category: "Braking System",
    brand: "Akebono Euro Ultra-Premium",
    supplier: "Audi OEM Direct",
    costPrice: 110.00,
    retailPrice: 185.00,
    stockQuantity: 8,
    minStockLevel: 3,
    binLocation: "Aisle 1, Shelf D, Bin 02",
    warrantyMonths: 24,
    failureStats: { totalInstalled: 94, totalFailed: 0, comebackRate: "0.0%" }
  },
  {
    id: "part_4",
    partNumber: "ROT-375MM-PR",
    description: "Front Vented Geomet-Coated 375mm High-Carbon Brake Rotors (Pair)",
    category: "Braking System",
    brand: "Zimmermann Coat Z",
    supplier: "Audi OEM Direct",
    costPrice: 195.00,
    retailPrice: 330.00,
    stockQuantity: 5,
    minStockLevel: 2,
    binLocation: "Aisle 1, Shelf E (Heavy Floor)",
    warrantyMonths: 24,
    failureStats: { totalInstalled: 78, totalFailed: 1, comebackRate: "1.3%" }
  },
  {
    id: "part_5",
    partNumber: "OIL-0W16-5Q",
    description: "Toyota Genuine 0W-16 Ultra Synthetic Motor Oil (5-Quart Jug)",
    category: "Fluids & Filters",
    brand: "Toyota Genuine",
    supplier: "San Leandro Toyota Wholesale",
    costPrice: 28.00,
    retailPrice: 48.00,
    stockQuantity: 42,
    minStockLevel: 12,
    binLocation: "Aisle 4, Shelf A, Bulk Staging",
    warrantyMonths: 12,
    failureStats: { totalInstalled: 620, totalFailed: 0, comebackRate: "0.0%" }
  },
  {
    id: "part_6",
    partNumber: "FLT-04152-YZZA1",
    description: "OEM Toyota Oil Filter Cartridge with Viton O-Rings",
    category: "Fluids & Filters",
    brand: "Denso",
    supplier: "San Leandro Toyota Wholesale",
    costPrice: 6.20,
    retailPrice: 12.50,
    stockQuantity: 55,
    minStockLevel: 15,
    binLocation: "Aisle 4, Shelf B, Bin 08",
    warrantyMonths: 12,
    failureStats: { totalInstalled: 712, totalFailed: 0, comebackRate: "0.0%" }
  },
  {
    id: "part_7",
    partNumber: "CAB-87139-0E040",
    description: "HEPA Activated Carbon Cabin Air Filter with Polyphenol Anti-Allergen",
    category: "HVAC & Filters",
    brand: "Denso CabinPro",
    supplier: "San Leandro Toyota Wholesale",
    costPrice: 16.50,
    retailPrice: 34.00,
    stockQuantity: 19,
    minStockLevel: 6,
    binLocation: "Aisle 4, Shelf C, Bin 18",
    warrantyMonths: 12,
    failureStats: { totalInstalled: 230, totalFailed: 0, comebackRate: "0.0%" }
  },
  {
    id: "part_8",
    partNumber: "BAT-AGM-H8",
    description: "Group 49 (H8) AGM High Performance 900 CCA Starter Battery",
    category: "Battery & Electrical",
    brand: "Interstate MTX AGM",
    supplier: "Interstate Commercial",
    costPrice: 175.00,
    retailPrice: 289.00,
    stockQuantity: 9,
    minStockLevel: 3,
    binLocation: "Aisle 2, Battery Rack B",
    warrantyMonths: 48,
    failureStats: { totalInstalled: 145, totalFailed: 2, comebackRate: "1.4%" }
  }
];

export const seedMembershipPlans = [
  {
    id: "plan_standard",
    name: "Standard Membership",
    tier: "Standard",
    monthlyPrice: 0,
    annualPrice: 0,
    benefits: [
      "12-Month / 12,000-Mile Nationwide Parts & Labor Warranty",
      "Digital Vehicle Inspection (DVI) text summary",
      "Standard shop repair labor rate"
    ],
    ridersAllowed: []
  },
  {
    id: "plan_silver",
    name: "Silver Maintenance Shield",
    tier: "Silver Care",
    monthlyPrice: 19.99,
    annualPrice: 219.00,
    benefits: [
      "2 Included Synthetic Oil Changes & Filter annually",
      "10% Discount on all mechanical labor operations",
      "Free 24/7 Roadside Assistance & Tire Hazard towing (up to 15 miles)",
      "24-Month / 24,000-Mile Extended Warranty"
    ],
    ridersAllowed: ["rider_tire", "rider_battery"]
  },
  {
    id: "plan_gold",
    name: "VIP Gold Care",
    tier: "VIP Gold Care",
    monthlyPrice: 39.99,
    annualPrice: 439.00,
    benefits: [
      "100% Free Diagnostics on all visits ($149-$215 value per scan)",
      "15% Discount on all labor operations",
      "3 Included Synthetic Oil & Filter services annually",
      "Complimentary Luxury Loaner Vehicle on any service exceeding 2.5 hours",
      "Priority Bay Dispatch & Same-Day Emergency Service Guarantee",
      "36-Month / 36,000-Mile Bumper-to-Bumper Warranty"
    ],
    ridersAllowed: ["rider_tire", "rider_battery", "rider_loaner", "rider_ev_hybrid"]
  },
  {
    id: "plan_fleet_pro",
    name: "Fleet Pro Commercial",
    tier: "Fleet Pro",
    monthlyPrice: 79.00,
    annualPrice: 850.00,
    benefits: [
      "Dedicated ASE Master Technician for company vehicle roster",
      "Consolidated Net-30 Invoicing & Tax Summaries",
      "Guaranteed 4-Hour Rapid Turnaround on all Tier 1 repairs",
      "20% Labor Discount + Wholesale parts cost + 15% markup",
      "Quarterly Telematics & Safety Audit with Fleet Manager Dashboard"
    ],
    ridersAllowed: ["rider_tire", "rider_battery", "rider_loaner", "rider_ev_hybrid", "rider_fleet_priority"]
  }
];

export const seedServiceRiders = [
  {
    id: "rider_tire",
    name: "Tire Hazard & Wheel Protection Rider",
    monthlyFee: 9.99,
    coverageDescription: "Full replacement cost for puncture, curb blowout, or bent rim up to $450/incident with $0 deductible."
  },
  {
    id: "rider_battery",
    name: "Battery & Electrical Shield",
    monthlyFee: 6.99,
    coverageDescription: "Free annual AGM/Lead-Acid testing, terminal cleaning, and 100% replacement battery if CCA falls below 70%."
  },
  {
    id: "rider_loaner",
    name: "Guaranteed Zero-Deductible Loaner Rider",
    monthlyFee: 14.99,
    coverageDescription: "Guaranteed immediate loaner vehicle on all appointments, even routine lube and tire service."
  },
  {
    id: "rider_ev_hybrid",
    name: "High Voltage Hybrid & EV Battery Guard",
    monthlyFee: 19.99,
    coverageDescription: "Annual cell impedance degradation scan, thermal loop flush discount, and high-voltage contactor inspection."
  }
];

export const seedWiringDiagrams = [
  {
    id: "wire_audi_q7_can",
    vehicleMake: "Audi",
    vehicleModel: "Q7 3.0T",
    yearRange: "2020-2024",
    subsystem: "Powertrain CAN-FD & Engine Management",
    diagramTitle: "Bosch MD1CP004 ECM to Ignition Coil & Injector Circuitry",
    nodes: [
      { id: "ecm", label: "Engine Control Module (J623)", x: 120, y: 150, type: "controller", pins: ["Pin 12 (CAN-H)", "Pin 13 (CAN-L)", "Pin 28 (Coil 1 Trg)", "Pin 29 (Coil 2 Trg)", "Pin 30 (Coil 3 Trg)"] },
      { id: "gateway", label: "Central Diagnostic Gateway (J533)", x: 380, y: 70, type: "gateway", pins: ["Pin 6 (OBD CAN-H)", "Pin 14 (OBD CAN-L)", "Pin 32 (CAN-FD Bus)"] },
      { id: "coil_1", label: "Ignition Coil #1 (N70)", x: 620, y: 90, type: "actuator", pins: ["Pin 1 (12V B+)", "Pin 2 (Ground)", "Pin 3 (Trigger)", "Pin 4 (Feedback)"] },
      { id: "coil_2", label: "Ignition Coil #2 (N127) [FAULT NODE]", x: 620, y: 190, type: "fault_actuator", pins: ["Pin 1 (12V B+)", "Pin 2 (Ground)", "Pin 3 (Trigger)", "Pin 4 (Feedback)"] },
      { id: "coil_3", label: "Ignition Coil #3 (N291)", x: 620, y: 290, type: "actuator", pins: ["Pin 1 (12V B+)", "Pin 2 (Ground)", "Pin 3 (Trigger)", "Pin 4 (Feedback)"] },
      { id: "fuse_box", label: "Engine Bay Fuse Box (SB14 20A)", x: 380, y: 310, type: "power", pins: ["Terminal 30 (Bat)", "Terminal 87 (Relay Out)"] }
    ],
    circuits: [
      { from: "ecm", to: "gateway", name: "Powertrain CAN 500 kbps", color: "#00d2ff", active: true, testPoint: "TP-CAN1: 2.5V Bias, 120 Ohm termination OK" },
      { from: "ecm", to: "coil_1", name: "Cyl 1 Spark Trigger Pulse", color: "#00e676", active: true, testPoint: "TP-N70: 5V square wave 3.2ms dwell" },
      { from: "ecm", to: "coil_2", name: "Cyl 2 Spark Trigger Pulse [SUSPECT INTERMITTENT]", color: "#ffb300", active: true, testPoint: "TP-N127: Normal trigger present, internal coil arc to ground" },
      { from: "ecm", to: "coil_3", name: "Cyl 3 Spark Trigger Pulse", color: "#00e676", active: true, testPoint: "TP-N291: 5V square wave 3.2ms dwell" },
      { from: "fuse_box", to: "coil_1", name: "12V Ignition Power Rail", color: "#ff5252", active: true, testPoint: "TP-B14: 13.9V measured with engine running" },
      { from: "fuse_box", to: "coil_2", name: "12V Ignition Power Rail", color: "#ff5252", active: true, testPoint: "TP-B14: 13.9V measured with engine running" },
      { from: "fuse_box", to: "coil_3", name: "12V Ignition Power Rail", color: "#ff5252", active: true, testPoint: "TP-B14: 13.9V measured with engine running" }
    ]
  },
  {
    id: "wire_ford_f150_hybrid",
    vehicleMake: "Ford",
    vehicleModel: "F-150 PowerBoost",
    yearRange: "2021-2024",
    subsystem: "Hybrid Powertrain & High Voltage DC/DC",
    diagramTitle: "High Voltage Contactor & Inverter Interface Circuit",
    nodes: [
      { id: "becm", label: "Battery Energy Control Module (BECM)", x: 100, y: 140, type: "controller", pins: ["Pin 4 (HVIL In)", "Pin 5 (HVIL Out)", "Pin 21 (Precharge)"] },
      { id: "pack", label: "1.5 kWh Li-Ion Traction Battery", x: 340, y: 140, type: "power", pins: ["HV Positive", "HV Negative", "Contactor A", "Contactor B"] },
      { id: "inverter", label: "Electric Machine Inverter (TRAC)", x: 600, y: 140, type: "actuator", pins: ["U-Phase", "V-Phase", "W-Phase", "Motor Resolver"] }
    ],
    circuits: [
      { from: "becm", to: "pack", name: "High Voltage Interlock Loop (HVIL)", color: "#9d4edd", active: true, testPoint: "HVIL Circuit: Continuity 0.2 Ohms (Closed loop)" },
      { from: "pack", to: "inverter", name: "288V High Voltage DC Bus", color: "#ff9100", active: true, testPoint: "DC Bus: 294.2V nominal, zero insulation leakage" }
    ]
  }
];

export const seedConfirmedFixes = [
  {
    id: "fix_1",
    dtcCode: "P0302",
    make: "Audi",
    model: "Q7 / S4 / S5 3.0T V6 (EA839)",
    yearRange: "2018-2023",
    symptom: "Flashing MIL on highway acceleration, slight engine vibration under load",
    verifiedFix: "Replace defective Cylinder 2 ignition coil and complete set of 6 spark plugs (due to center electrode gap erosion widening beyond 1.1mm). Clean contact pin on harness plug.",
    partsReplaced: ["Ignition Coil Pack (BOS-0221604115)", "Set of 6 Bosch Iridium Spark Plugs (BOS-9614-6PK)"],
    laborHours: 1.8,
    confidenceScore: "98.4%",
    shopOccurrences: 47,
    verifiedByShopMaster: "Marcus Vance, ASE Master L1 Diagnostic Tech"
  },
  {
    id: "fix_2",
    dtcCode: "P0171",
    make: "Ford",
    model: "F-150 / Expedition 3.5L EcoBoost",
    yearRange: "2017-2022",
    symptom: "Check Engine Light on, LTFT +18% to +22% at idle, normal trims at 2500 RPM",
    verifiedFix: "Inspect PCV vacuum hose elbow behind throttle body for dry-rot cracking. Replace PCV breather valve and vacuum tube assembly.",
    partsReplaced: ["PCV Breather Assembly & Hose (FL3Z-6A664-A)"],
    laborHours: 1.2,
    confidenceScore: "96.1%",
    shopOccurrences: 89,
    verifiedByShopMaster: "Marcus Vance, ASE Master Tech"
  },
  {
    id: "fix_3",
    dtcCode: "U0100",
    make: "Toyota",
    model: "RAV4 / Camry Hybrid 2.5L",
    yearRange: "2019-2024",
    symptom: "Intermittent ABS/Trac warning flashes upon startup, historical U0100 stored in ECM",
    verifiedFix: "Inspect auxiliary 12V AGM battery health. Low 12V voltage (<11.8V) during cold crank causes momentary gateway brownout. Replace auxiliary battery and clean grounding strap (G101).",
    partsReplaced: ["12V Auxiliary AGM Battery (Group S34B24R)"],
    laborHours: 0.8,
    confidenceScore: "94.8%",
    shopOccurrences: 62,
    verifiedByShopMaster: "Dave Reynolds, Master Tech"
  }
];

export const seedForumThreads = [
  {
    id: "forum_1",
    title: "Audi EA839 3.0T Cylinder 2 & 5 Misfire Under Heavy Boost - Coil breakdown vs Injector fouling",
    category: "Diagnostics & Powertrain",
    authorName: "Marcus Vance",
    authorRole: "Master Diagnostic Technician",
    authorAvatar: "https://images.unsplash.com/photo-1560250097-0b93528c311a?w=150&auto=format&fit=crop&q=80",
    createdAt: "2026-10-10T14:20:00.000Z",
    tags: ["Audi", "3.0T", "P0302", "Misfire", "Ignition"],
    views: 312,
    likes: 28,
    problemSummary: "Encountering intermittent P0302 on 2021-2023 Audi Q7 3.0T with 40k-50k miles. Customers report hesitation when merging onto highway under 50%+ throttle. Freeze frame indicates misfire occurs right at 2,100 RPM at peak boost pressure.",
    confirmedSolution: "Swap test confirms coil secondary dielectric breakdown. When plug gaps widen over 40k miles to ~1.15mm, required ignition ionization voltage spikes from 14kV to over 28kV, causing coil body to punch internal arc. ALWAYS replace all 6 plugs when replacing the failed coil pack.",
    replies: [
      {
        id: "rep_1",
        authorName: "Carlos Mendez",
        authorRole: "Senior Diagnostic Tech (Oakland)",
        authorAvatar: "https://images.unsplash.com/photo-1570295999919-56ceb5ecca61?w=150&auto=format&fit=crop&q=80",
        createdAt: "2026-10-10T16:45:00.000Z",
        message: "Spot on Marcus. We saw 3 of these last month. The factory plug spec is 0.7mm (+/- 0.05). If you just swap the coil without replacing plugs, the new coil fails within 90 days. Great write-up!"
      }
    ]
  },
  {
    id: "forum_2",
    title: "Tesla Model Y / 3 12V AGM Low Voltage Warning after software update - Parasitic draw isolation",
    category: "EV & High Voltage",
    authorName: "Marcus Vance",
    authorRole: "Master Diagnostic Technician",
    authorAvatar: "https://images.unsplash.com/photo-1560250097-0b93528c311a?w=150&auto=format&fit=crop&q=80",
    createdAt: "2026-10-08T09:10:00.000Z",
    tags: ["Tesla", "Model Y", "12V Battery", "EV", "Sentry Mode"],
    views: 450,
    likes: 41,
    problemSummary: "Vehicle alerts customer via app '12V battery requires service soon'. DC-DC converter output reads 14.4V while driving, but resting voltage drops to 11.9V overnight.",
    confirmedSolution: "Third-party USB dashcam plugged into center console port was preventing car from entering deep sleep. Car's high-voltage contactor was cycling 40 times per day to keep 12V charged. Unplugged USB accessory, load tested 12V battery (replaced with Interstate MTX AGM), problem completely resolved.",
    replies: []
  }
];

export const seedFuelLogs = [
  {
    id: "fuel_1",
    vehicleId: "veh_1",
    date: "2026-10-05",
    odometer: 41820,
    gallons: 16.4,
    totalCost: 78.50,
    calculatedMpg: 18.2,
    expectedMpg: 22.0,
    anomalyDetected: true,
    anomalyReason: "MPG dropped 17.2% below historical average. Direct correlation with active P0302 misfire and fuel trim enrichment (+14.2%)."
  },
  {
    id: "fuel_2",
    vehicleId: "veh_1",
    date: "2026-09-22",
    odometer: 41480,
    gallons: 15.2,
    totalCost: 72.80,
    calculatedMpg: 22.4,
    expectedMpg: 22.0,
    anomalyDetected: false,
    anomalyReason: null
  },
  {
    id: "fuel_3",
    vehicleId: "veh_2",
    date: "2026-10-04",
    odometer: 64250,
    gallons: 26.5,
    totalCost: 119.25,
    calculatedMpg: 20.8,
    expectedMpg: 21.0,
    anomalyDetected: false,
    anomalyReason: null
  }
];

export const seedMessages = [
  {
    id: "msg_1",
    customerId: "cust_1",
    roId: "ro_1",
    direction: "outbound",
    channel: "sms",
    senderName: "Sarah Jenkins (Advisor)",
    message: "Hi Elena! Marcus completed your Audi Q7 digital inspection. Good news: your VIP Gold membership covers the full $149 diagnostic fee! We found that Cylinder 2 has an ignition coil arc and worn spark plugs. You can view the live photos and approve lines here: https://futuretech.io/portal/ro_1",
    timestamp: "2026-10-13T10:48:00.000Z",
    status: "delivered"
  },
  {
    id: "msg_2",
    customerId: "cust_1",
    roId: "ro_1",
    direction: "inbound",
    channel: "sms",
    senderName: "Elena Rostova",
    message: "Thank you Sarah! I just reviewed the photos on my phone and digitally approved the ignition coil and spark plugs. I skipped the alignment for now. Will the car be ready by 5:00 PM for pickup?",
    timestamp: "2026-10-13T11:06:00.000Z",
    status: "read"
  },
  {
    id: "msg_3",
    customerId: "cust_1",
    roId: "ro_1",
    direction: "outbound",
    channel: "sms",
    senderName: "Sarah Jenkins (Advisor)",
    message: "Yes absolutely! Marcus has the parts in Bay 3 and will finish around 3:30 PM. We'll have your Q7 washed and waiting out front for you.",
    timestamp: "2026-10-13T11:10:00.000Z",
    status: "delivered"
  }
];

export const seedAuditLogs = [
  {
    id: "aud_1",
    timestamp: "2026-10-13T08:30:15.000Z",
    eventType: "RO_CHECKED_IN",
    entityType: "RepairOrder",
    entityId: "ro_1",
    actorId: "usr_advisor_1",
    actorRole: "advisor",
    action: "Opened Repair Order RO-2026-081 for Audi Q7 3.0T. Odometer recorded: 42,150.",
    ipAddress: "192.168.1.45"
  },
  {
    id: "aud_2",
    timestamp: "2026-10-13T10:30:00.000Z",
    eventType: "INSPECTION_LOCKED",
    entityType: "Inspection",
    entityId: "insp_1",
    actorId: "usr_tech_1",
    actorRole: "technician",
    action: "Completed DVI inspection. 14 Pass, 2 Attention, 2 Fail. Photos and findings cryptographically locked.",
    ipAddress: "192.168.1.103"
  },
  {
    id: "aud_3",
    timestamp: "2026-10-13T11:05:22.000Z",
    eventType: "ESTIMATE_CUSTOMER_APPROVAL",
    entityType: "Estimate",
    entityId: "est_1",
    actorId: "cust_1",
    actorRole: "customer",
    action: "Customer Elena Rostova digitally approved lines 1-6 ($1,365.20), declined line 7 (Alignment $210.00). Digital Signature stored.",
    ipAddress: "172.56.21.99"
  },
  {
    id: "aud_4",
    timestamp: "2026-10-13T11:45:00.000Z",
    eventType: "FINANCIAL_PAYMENT_PROCESSED",
    entityType: "Invoice",
    entityId: "inv_4",
    actorId: "usr_advisor_1",
    actorRole: "advisor",
    action: "Processed Stripe payment of $171.75 for RO-2026-084. Card ending 4242. Receipt INV-2026-084 issued.",
    ipAddress: "192.168.1.45"
  }
];

export const seedAiExecutionLogs = [
  {
    id: "ai_exec_1",
    timestamp: "2026-10-13T10:35:00.000Z",
    provider: "FutureTech Automotive AI Engine v2.4 (Governed)",
    promptVersion: "ft-service-writer-v3.1",
    modelVersion: "ft-automotive-expert-2026-q3",
    taskType: "service_writer",
    roId: "ro_1",
    inputHash: "sha256_9b83a01f5c6e8",
    structuredOutput: {
      summary: "Audi Q7 3.0T Cylinder 2 Misfire (P0302)",
      customerPlainEnglishExplanation: "Your Audi's engine has 6 cylinders working together. Cylinder #2 is not sparking properly because its ignition coil has broken down inside, and the spark plugs have worn out over 42,000 miles. We will install a new high-output coil and 6 fresh laser-welded iridium spark plugs so your engine runs smooth and efficient again.",
      recommendedLineItems: [
        { type: "part", desc: "OEM Ignition Coil Pack (Cylinder 2)", estPrice: 118.50 },
        { type: "part", desc: "Bosch Double Iridium Spark Plugs (Set of 6)", estPrice: 117.00 },
        { type: "labor", desc: "Diagnostic Labor & Ignition Tune", estHours: 1.8 }
      ],
      safetyCriticalClassification: "non_safety_mechanical_driveability"
    },
    confidence: "98.7%",
    humanReviewed: true,
    reviewedBy: "Sarah Jenkins (Advisor)",
    humanOverrideNotes: "Approved without modification. Text sent to customer."
  }
];

export const seedPredictiveSignals = [
  {
    id: "pred_1",
    vehicleId: "veh_1",
    component: "Electric Engine Water Pump & Thermostat Housing",
    failureRiskScore: 78,
    milesToFailureEstimate: "4,500 - 6,000 miles",
    evidenceSummary: "Thermal delta sensor differential on EA839 3.0T engine block exceeds standard baseline by 14%. Impeller speed fluctuation observed during stop-and-go driving.",
    recommendedAction: "Perform visual coolant level & pink silicate crystallization check during next oil service.",
    contractualCoverageCheck: "Covered 100% under VIP Gold Care Mechanical Protection Rider"
  },
  {
    id: "pred_2",
    vehicleId: "veh_1",
    component: "12V AGM Auxiliary Battery",
    failureRiskScore: 42,
    milesToFailureEstimate: "12,000 miles (approx 10 months)",
    evidenceSummary: "Battery tested 805 CCA out of 820 CCA rated. Voltage drop during initial cold crank remained within safe spec at 10.4V.",
    recommendedAction: "Retest state-of-health at next scheduled maintenance.",
    contractualCoverageCheck: "Covered under Battery Shield"
  }
];

