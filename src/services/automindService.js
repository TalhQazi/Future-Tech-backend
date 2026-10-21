import crypto from 'crypto';
import { Device, DeviceCommand, DiagnosticSession, TelemetrySample, Vehicle } from '../models/index.js';
import { automind, STANDARD_COMMANDS } from '../adapters/automind.js';
import { env } from '../config/env.js';
import { audit } from './audit.js';
import { recordScan } from './futuretechService.js';
import { assertLocation, locationFilter, can, findRoForAccess } from '../security/access.js';
import { notFound, badRequest, forbidden, conflict, unauthorized } from '../lib/errors.js';
import { randomToken, timingSafeEqualStr, encryptSecret, decryptSecret } from '../lib/crypto.js';
import { toDTO } from '../lib/http.js';

const TELEMETRY_RETENTION_DAYS = 365;

export const status = () => automind.status();

export const listDevices = async (auth) => toDTO(await Device.find(locationFilter(auth)).sort({ label: 1 }).lean());

export const registerDevice = async (req, { serialNumber, label, locationId, model }) => {
  assertLocation(req.auth, locationId);
  const ingestKey = randomToken(32);
  const device = await Device.create({ serialNumber, label, locationId, model, ingestKeyEnc: encryptSecret(ingestKey), registeredBy: req.auth.userId });
  await audit(req, { eventType: 'DEVICE_REGISTERED', category: 'security', entityType: 'Device', entityId: device.id, locationId, action: `Registered AutoMind device ${serialNumber}` });
  // the ingest key is shown once for configuring the device bridge
  return { device: toDTO(device), ingestKey };
};

export const discover = async (req, id) => {
  const device = await Device.findOne({ id }).lean();
  if (!device) throw notFound('Device');
  assertLocation(req.auth, device.locationId);
  const [info, caps] = await Promise.all([automind.getDevice(device.serialNumber), automind.discoverCapabilities(device.serialNumber)]);
  const updated = await Device.findOneAndUpdate({ id }, {
    $set: {
      model: info.model || device.model, firmwareVersion: info.firmwareVersion || device.firmwareVersion,
      status: info.online ? 'online' : 'offline', lastSeenAt: info.online ? new Date() : device.lastSeenAt,
      capabilities: {
        discoveredAt: new Date(), protocols: caps.protocols || [], modules: caps.modules || [],
        supportedPids: caps.supportedPids || [], commands: caps.commands || []
      }
    }
  }, { new: true }).lean();
  return toDTO(updated);
};

const applyResult = async (req, cmd, result) => {
  if (cmd.command === 'READ_DTCS' && cmd.sessionId) {
    await recordScan(req, cmd.sessionId, {
      phase: cmd.params?.phase || 'pre_repair', source: 'device', deviceId: cmd.deviceId, commandId: cmd.id,
      modulesScanned: result.modules || [], dtcs: (result.dtcs || []).map(d => ({ code: d.code, module: d.module, status: d.status, description: d.description, freezeFrame: d.freezeFrame }))
    });
  }
  if (cmd.command === 'READ_PIDS' && result.samples?.length) {
    const expireAt = new Date(Date.now() + TELEMETRY_RETENTION_DAYS * 86400000);
    await TelemetrySample.insertMany(result.samples.map(s => ({ deviceId: cmd.deviceId, sessionId: cmd.sessionId, vehicleId: cmd.vehicleId, at: s.at ? new Date(s.at) : new Date(), pid: s.pid, name: s.name, value: s.value, unit: s.unit, expireAt })));
  }
};

export const sendCommand = async (req, deviceId, { sessionId, command, params = {}, authorizationReason }) => {
  const device = await Device.findOne({ id: deviceId }).lean();
  if (!device) throw notFound('Device');
  assertLocation(req.auth, device.locationId);
  if (device.status === 'disabled') throw conflict('Device is disabled');
  const def = device.capabilities?.commands?.find(c => c.code === command) || (STANDARD_COMMANDS[command] && { code: command, ...STANDARD_COMMANDS[command] });
  if (!def) throw badRequest('This device does not support that command');
  const privileged = Boolean(def.privileged || STANDARD_COMMANDS[command]?.privileged);
  if (privileged) {
    if (!can(req.auth, 'devices:command_privileged')) throw forbidden('This command changes vehicle state and requires a manager');
    if (!authorizationReason) throw badRequest('Record why this command is authorized');
  }
  let vehicle = null;
  let roId;
  if (sessionId) {
    const s = await DiagnosticSession.findOne({ id: sessionId }).lean();
    if (!s) throw notFound('Diagnostic session');
    const ro = await findRoForAccess(req.auth, s.roId);
    roId = ro.id;
    vehicle = await Vehicle.findOne({ id: ro.vehicleId }).lean();
  }
  const cmd = await DeviceCommand.create({
    deviceId, sessionId, roId, vehicleId: vehicle?.id, command, params, privileged,
    requestedBy: req.auth.userId, authorizedBy: privileged ? req.auth.userId : undefined, authorizationReason
  });
  await audit(req, { eventType: 'DEVICE_COMMAND', category: privileged ? 'override' : 'operational', entityType: 'Device', entityId: deviceId, locationId: device.locationId, action: `${command} requested on ${device.serialNumber}${privileged ? ' (privileged)' : ''}`, reason: authorizationReason });
  try {
    const res = await automind.sendCommand(device.serialNumber, { command, params, vin: vehicle?.vin, correlationId: cmd.id });
    const done = res.status === 'completed';
    await DeviceCommand.updateOne({ id: cmd.id }, { $set: { status: done ? 'succeeded' : 'sent', gatewayRef: res.commandRef, sentAt: new Date(), ...(done ? { result: res.result, completedAt: new Date() } : {}) } });
    if (done && res.result) await applyResult(req, { ...cmd.toObject(), roId }, res.result);
  } catch (err) {
    await DeviceCommand.updateOne({ id: cmd.id }, { $set: { status: err.code === 'AUTOMIND_NOT_CONFIGURED' ? 'unavailable' : 'failed', error: err.message, completedAt: new Date() } });
    throw err;
  }
  return toDTO(await DeviceCommand.findOne({ id: cmd.id }).lean());
};

export const refreshCommand = async (req, commandId) => {
  const cmd = await DeviceCommand.findOne({ id: commandId }).lean();
  if (!cmd) throw notFound('Command');
  const device = await Device.findOne({ id: cmd.deviceId }).lean();
  assertLocation(req.auth, device.locationId);
  if (cmd.status !== 'sent') return toDTO(cmd);
  const res = await automind.getCommand(cmd.gatewayRef);
  if (['completed', 'failed'].includes(res.status)) {
    const claimed = await DeviceCommand.findOneAndUpdate({ id: commandId, status: 'sent' }, { $set: { status: res.status === 'completed' ? 'succeeded' : 'failed', result: res.result, error: res.error, completedAt: new Date() } }, { new: true }).lean();
    if (claimed && res.status === 'completed' && res.result) await applyResult(req, claimed, res.result);
  }
  return toDTO(await DeviceCommand.findOne({ id: commandId }).lean());
};

export const listCommands = async (auth, { sessionId, deviceId }) => {
  const filter = {};
  if (sessionId) filter.sessionId = sessionId;
  if (deviceId) filter.deviceId = deviceId;
  return toDTO(await DeviceCommand.find(filter).sort({ requestedAt: -1 }).limit(200).lean());
};

export const telemetry = async (auth, { sessionId, pid, limit = 500 }) => {
  const s = await DiagnosticSession.findOne({ id: sessionId }).lean();
  if (!s) throw notFound('Diagnostic session');
  await findRoForAccess(auth, s.roId);
  const filter = { sessionId };
  if (pid) filter.pid = pid;
  return TelemetrySample.find(filter).sort({ at: -1 }).limit(Math.min(limit, 5000)).lean();
};

// Device push: X-AutoMind-Serial + X-AutoMind-Signature (hex HMAC-SHA256 of the
// raw body with the device ingest key) + X-AutoMind-Timestamp (unix seconds).
export const ingest = async (rawBody, headers) => {
  const serial = headers['x-automind-serial'];
  const ts = Number(headers['x-automind-timestamp']);
  const sig = headers['x-automind-signature'];
  if (!serial || !ts || !sig || Math.abs(Date.now() / 1000 - ts) > 300) throw unauthorized('Missing or stale device signature');
  const device = await Device.findOne({ serialNumber: serial }).select('+ingestKeyEnc').lean();
  if (!device || device.status === 'disabled') throw unauthorized('Unknown device');
  const expected = crypto.createHmac('sha256', decryptSecret(device.ingestKeyEnc)).update(`${ts}.${rawBody}`).digest('hex');
  const fallback = env.automind.ingestSecret ? crypto.createHmac('sha256', env.automind.ingestSecret).update(`${ts}.${rawBody}`).digest('hex') : null;
  if (!timingSafeEqualStr(expected, sig) && !(fallback && timingSafeEqualStr(fallback, sig))) throw unauthorized('Invalid device signature');
  const payload = JSON.parse(rawBody);
  await Device.updateOne({ id: device.id }, { $set: { status: 'online', lastSeenAt: new Date() } });
  if (payload.type === 'telemetry' && payload.sessionId && Array.isArray(payload.samples)) {
    const session = await DiagnosticSession.findOne({ id: payload.sessionId, deviceId: device.id }).lean();
    if (!session) throw badRequest('Device is not attached to this session');
    const expireAt = new Date(Date.now() + TELEMETRY_RETENTION_DAYS * 86400000);
    await TelemetrySample.insertMany(payload.samples.slice(0, 5000).map(s => ({ deviceId: device.id, sessionId: session.id, vehicleId: session.vehicleId, at: new Date(s.at || Date.now()), pid: s.pid, name: s.name, value: s.value, unit: s.unit, expireAt })));
    return { accepted: payload.samples.length };
  }
  if (payload.type === 'command_result' && payload.commandId) {
    const claimed = await DeviceCommand.findOneAndUpdate({ id: payload.commandId, deviceId: device.id, status: 'sent' }, { $set: { status: payload.status === 'completed' ? 'succeeded' : 'failed', result: payload.result, error: payload.error, completedAt: new Date() } }, { new: true }).lean();
    if (claimed && payload.status === 'completed' && payload.result) {
      await applyResult({ auth: { userId: claimed.requestedBy, role: 'technician', locationIds: [device.locationId], user: { id: claimed.requestedBy, name: 'AutoMind' } } }, claimed, payload.result);
    }
    return { accepted: Boolean(claimed) };
  }
  return { accepted: true };
};

export const attachDevice = async (req, sessionId, deviceId) => {
  const s = await DiagnosticSession.findOne({ id: sessionId }).lean();
  if (!s) throw notFound('Diagnostic session');
  await findRoForAccess(req.auth, s.roId);
  const device = await Device.findOne({ id: deviceId, locationId: s.locationId }).lean();
  if (!device) throw badRequest('Device is not registered at this location');
  await DiagnosticSession.updateOne({ id: sessionId }, { $set: { deviceId } });
  return { success: true };
};
