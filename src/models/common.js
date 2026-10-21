import mongoose from 'mongoose';
import { uuid } from '../lib/crypto.js';

export const { Schema } = mongoose;

// Canonical business identifier (UUID for new records; legacy ids are preserved).
export const idField = { type: String, required: true, unique: true, default: uuid, immutable: true };

export const baseOptions = (extra = {}) => ({
  timestamps: true,
  minimize: false,
  toJSON: {
    versionKey: true,
    transform: (_doc, ret) => {
      ret.version = ret.__v;
      delete ret.__v;
      delete ret._id;
      return ret;
    }
  },
  ...extra
});

export const centsField = (opts = {}) => ({
  type: Number,
  default: 0,
  validate: { validator: Number.isSafeInteger, message: 'Amounts are stored as integer cents' },
  ...opts
});

export const currencyField = { type: String, default: 'USD', uppercase: true, match: /^[A-Z]{3}$/ };

export const actorSubdoc = new Schema({
  userId: String,
  name: String,
  role: String
}, { _id: false });

export const sourceRefSubdoc = new Schema({
  type: { type: String, required: true },
  id: { type: String, required: true },
  version: Schema.Types.Mixed
}, { _id: false });

/**
 * Append-only enforcement: blocks every update/delete path at the model layer.
 * Corrections must be written as new documents (versions, reversals, addenda).
 */
export const immutablePlugin = (schema, { allowFields = [] } = {}) => {
  const block = function blockMutation(next) {
    const update = typeof this.getUpdate === 'function' ? this.getUpdate() : null;
    if (update && allowFields.length > 0) {
      const keys = Object.keys(update).flatMap(k => (k.startsWith('$') ? Object.keys(update[k] || {}) : [k]));
      if (keys.every(k => allowFields.includes(k.split('.')[0]))) return next();
    }
    next(new Error(`${this.model?.modelName || 'Record'} is immutable; write a new version instead`));
  };
  for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace',
    'deleteOne', 'deleteMany', 'findOneAndDelete']) {
    schema.pre(op, block);
  }
  schema.pre('save', function preventResave(next) {
    if (this.isNew) return next();
    const modified = this.modifiedPaths().filter(p => !allowFields.includes(p.split('.')[0]));
    if (modified.length === 0) return next();
    next(new Error(`${this.constructor.modelName} is immutable; write a new version instead`));
  });
};

export const model = (name, schema, collection) => mongoose.models[name] || mongoose.model(name, schema, collection);
