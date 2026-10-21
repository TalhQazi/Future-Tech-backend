import express from 'express';
import { db } from '../data/store.js';

const router = express.Router();

// GET /api/v1/futuretech/automind/status (Hardware device adapter status & discovery)
router.get('/automind/status', (req, res) => {
  res.json({
    success: true,
    device: {
      model: 'AutoMind OBD-Pro Link (CAN-FD / DoIP / J2534)',
      serialNumber: 'AM-PRO-2026-98124',
      firmwareVersion: 'v4.18.2-rtos',
      connected: true,
      voltage: 14.1,
      protocol: 'CAN-FD (ISO 11898-1:2015) 500k/2M baud',
      supportedPidsCount: 164,
      supportedControllers: [
        '0x7E0 (ECM - Engine Control)',
        '0x7E1 (TCM - Transmission)',
        '0x7E2 (BECM - Hybrid / EV Battery)',
        '0x7E3 (ABS/ESC - Chassis Safety)',
        '0x7E4 (Gateway / BCM)'
      ],
      biDirectionalControlSupported: true
    }
  });
});

// GET /api/v1/futuretech/ro/:roId
router.get('/ro/:roId', (req, res) => {
  const diag = db.diagnostics.findByRoId(req.params.roId);
  if (!diag) {
    return res.status(404).json({ success: false, message: 'FutureTech diagnostic record not found for this RO' });
  }
  res.json({ success: true, diagnostic: diag });
});

// PUT /api/v1/futuretech/ro/:roId (Update diagnostic telemetry or notes)
router.put('/ro/:roId', (req, res) => {
  const { techDiagnosticNotes, healthScore, scanToolConnected, liveTelemetry } = req.body;
  const updates = {};
  if (techDiagnosticNotes !== undefined) updates.techDiagnosticNotes = techDiagnosticNotes;
  if (healthScore !== undefined) updates.healthScore = healthScore;
  if (scanToolConnected !== undefined) updates.scanToolConnected = scanToolConnected;
  if (liveTelemetry !== undefined) updates.liveTelemetry = liveTelemetry;

  const diag = db.diagnostics.update(req.params.roId, updates);
  if (!diag) {
    return res.status(404).json({ success: false, message: 'Diagnostic record not found' });
  }
  res.json({ success: true, diagnostic: diag });
});

// POST /api/v1/futuretech/ro/:roId/dtc (Add or trigger a DTC fault code)
router.post('/ro/:roId/dtc', (req, res) => {
  const { code, system, description, severity, freezeFrame, possibleCauses } = req.body;
  if (!code || !description) {
    return res.status(400).json({ success: false, message: 'DTC Code and description are required' });
  }

  const dtc = {
    code: code.toUpperCase().trim(),
    system: system || 'Powertrain',
    description,
    severity: severity || 'warning',
    status: 'active',
    milTriggered: true,
    freezeFrame: freezeFrame || {
      rpm: '1,950 RPM',
      vehicleSpeed: '45 MPH',
      coolantTemp: '196°F',
      engineLoad: '55%'
    },
    possibleCauses: possibleCauses || ['Sensor circuit out of calibration', 'Wiring harness connection']
  };

  const diag = db.diagnostics.addDtc(req.params.roId, dtc);

  db.audit.create({
    eventType: 'DTC_LOGGED',
    entityType: 'DiagnosticSession',
    entityId: req.params.roId,
    action: `Logged trouble code ${dtc.code} (${dtc.description})`
  });

  res.status(201).json({ success: true, diagnostic: diag });
});

// POST /api/v1/futuretech/ro/:roId/dtc/clear (Clear DTC codes & reset readiness monitors)
router.post('/ro/:roId/dtc/clear', (req, res) => {
  const diag = db.diagnostics.findByRoId(req.params.roId);
  if (!diag) {
    return res.status(404).json({ success: false, message: 'Diagnostic session not found' });
  }

  // Clear DTCs, boost health score
  diag.dtcCodes = [];
  diag.healthScore = 98;
  diag.techDiagnosticNotes += '\n[Post-Repair Verification]: Cleared DTCs via AutoMind command 0x04. Readiness test cycle in progress.';

  db.audit.create({
    eventType: 'DTC_CLEARED',
    entityType: 'DiagnosticSession',
    entityId: req.params.roId,
    action: `AutoMind cleared all active DTCs for RO ${req.params.roId}`
  });

  res.json({ success: true, diagnostic: diag, message: 'DTCs successfully cleared across all ECUs. MIL light turned OFF.' });
});

// POST /api/v1/futuretech/ro/:roId/actuator-test (AutoMind bi-directional command)
router.post('/ro/:roId/actuator-test', (req, res) => {
  const { command, component, durationSeconds } = req.body;

  const results = {
    commandIssued: command || 'ACTUATE_COMPONENT',
    component: component || 'Electric Fuel Pump Relay',
    durationSeconds: durationSeconds || 5,
    status: 'success',
    observedResponse: component === 'Fuel Pump' ? 'Rail pressure increased to 2,400 PSI' : 'Component energized normally with 1.4A current draw',
    pass: true,
    timestamp: new Date().toISOString()
  };

  res.json({ success: true, result: results, message: `AutoMind command executed on ${results.component}: Response verified normal.` });
});

// POST /api/v1/futuretech/ro/:roId/spec-eval (Evaluate manual/sensor measurement against authoritative OEM spec)
router.post('/ro/:roId/spec-eval', (req, res) => {
  const { component, observedValue, unit, minSpec, maxSpec } = req.body;

  const val = parseFloat(observedValue);
  const min = parseFloat(minSpec);
  const max = parseFloat(maxSpec);

  let passed = true;
  let status = 'pass';
  let message = 'Measurement is within authoritative factory specification.';

  if (!isNaN(min) && val < min) {
    passed = false;
    status = 'fail';
    message = `Observed value ${val} ${unit} is BELOW factory minimum specification (${min} ${unit}). Renewal recommended.`;
  } else if (!isNaN(max) && val > max) {
    passed = false;
    status = 'fail';
    message = `Observed value ${val} ${unit} EXCEEDS factory maximum tolerance (${max} ${unit}). Out of calibration.`;
  }

  res.json({
    success: true,
    evaluation: {
      component,
      observedValue: val,
      unit,
      minSpec: min,
      maxSpec: max,
      passed,
      status,
      message,
      evaluatedAt: new Date().toISOString()
    }
  });
});

// PUT /api/v1/futuretech/ro/:roId/guided-checks/:checkId (Update step findings or mark passed/failed)
router.put('/ro/:roId/guided-checks/:checkId', (req, res) => {
  const { status, technicianFindings } = req.body;
  const updates = {};
  if (status !== undefined) updates.status = status;
  if (technicianFindings !== undefined) updates.technicianFindings = technicianFindings;

  const diag = db.diagnostics.updateGuidedCheck(req.params.roId, req.params.checkId, updates);
  if (!diag) {
    return res.status(404).json({ success: false, message: 'Diagnostic or step not found' });
  }
  res.json({ success: true, diagnostic: diag });
});

// POST /api/v1/futuretech/ro/:roId/guided-checks (Add custom guided test)
router.post('/ro/:roId/guided-checks', (req, res) => {
  const { title, instructions, technicianFindings } = req.body;
  if (!title) {
    return res.status(400).json({ success: false, message: 'Check title is required' });
  }

  const diag = db.diagnostics.addGuidedCheck(req.params.roId, {
    title,
    instructions: instructions || 'Perform physical probe and verify sensor voltage signal.',
    technicianFindings: technicianFindings || ''
  });

  res.status(201).json({ success: true, diagnostic: diag });
});

// POST /api/v1/futuretech/ro/:roId/simulate-scan (Simulate AutoMind OBD live scan)
router.post('/ro/:roId/simulate-scan', (req, res) => {
  const updates = {
    scanToolConnected: true,
    liveTelemetry: {
      batteryVoltage: +(13.8 + (Math.random() * 0.6 - 0.3)).toFixed(2),
      coolantTempF: Math.floor(190 + Math.random() * 10),
      rpm: Math.floor(750 + Math.random() * 40),
      oilPressurePsi: Math.floor(36 + Math.random() * 6),
      fuelRailPsi: Math.floor(2100 + Math.random() * 80),
      ambientTempF: 72
    }
  };

  const diag = db.diagnostics.update(req.params.roId, updates);
  res.json({ success: true, diagnostic: diag, message: 'AutoMind hardware telemetry stream refreshed' });
});

export default router;
