import multer from 'multer';
import { env } from '../config/env.js';
import { badRequest } from '../lib/errors.js';

// Allowed evidence types. The declared MIME type must also match the file's
// magic bytes so a renamed executable cannot be stored as a "photo".
export const ALLOWED_TYPES = {
  'image/jpeg': { kind: 'photo', magic: [[0xff, 0xd8, 0xff]] },
  'image/png': { kind: 'photo', magic: [[0x89, 0x50, 0x4e, 0x47]] },
  'image/webp': { kind: 'photo', magic: [[0x52, 0x49, 0x46, 0x46]] },
  'image/heic': { kind: 'photo', magic: null },
  'video/mp4': { kind: 'video', magic: null },
  'video/quicktime': { kind: 'video', magic: null },
  'video/webm': { kind: 'video', magic: [[0x1a, 0x45, 0xdf, 0xa3]] },
  'audio/mpeg': { kind: 'audio', magic: null },
  'application/pdf': { kind: 'document', magic: [[0x25, 0x50, 0x44, 0x46]] }
};

const ftypBrands = (buf) => (buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp');

export const sniffMatches = (contentType, buffer) => {
  const rule = ALLOWED_TYPES[contentType];
  if (!rule) return false;
  if (['video/mp4', 'video/quicktime', 'image/heic'].includes(contentType)) return ftypBrands(buffer);
  if (contentType === 'audio/mpeg') return buffer.length > 3 && (buffer.toString('ascii', 0, 3) === 'ID3' || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0));
  return rule.magic.some(sig => sig.every((b, i) => buffer[i] === b));
};

export const evidenceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.storage.maxUploadBytes, files: 1, fields: 20 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_TYPES[file.mimetype]) return cb(badRequest(`File type ${file.mimetype} is not allowed`));
    cb(null, true);
  }
});
