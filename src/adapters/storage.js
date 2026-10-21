import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { notFound } from '../lib/errors.js';

// Evidence storage behind a replaceable interface:
//   put({ buffer, contentType, filename, metadata }) -> { driver, key }
//   openRead({ driver, key }) -> Readable stream
// GridFS (default) keeps evidence in the same MongoDB deployment, which also
// works on serverless hosts without a persistent disk.

const gridfs = {
  name: 'gridfs',
  bucket() {
    return new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'evidence' });
  },
  async put({ buffer, contentType, filename, metadata }) {
    const bucket = this.bucket();
    const id = new mongoose.Types.ObjectId();
    await new Promise((resolve, reject) => {
      const upload = bucket.openUploadStreamWithId(id, filename || id.toString(), { contentType, metadata });
      upload.on('error', reject);
      upload.on('finish', resolve);
      upload.end(buffer);
    });
    return { driver: 'gridfs', key: id.toString() };
  },
  async openRead({ key }) {
    const id = new mongoose.Types.ObjectId(key);
    const files = await this.bucket().find({ _id: id }).limit(1).toArray();
    if (files.length === 0) throw notFound('Stored file');
    return this.bucket().openDownloadStream(id);
  }
};

const local = {
  name: 'local',
  dir() {
    const dir = path.resolve(env.storage.localDir);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  },
  async put({ buffer, metadata }) {
    const key = `${metadata?.sha256 || Date.now()}-${new mongoose.Types.ObjectId().toString()}`;
    await fs.promises.writeFile(path.join(this.dir(), key), buffer, { flag: 'wx' }); // never overwrite
    return { driver: 'local', key };
  },
  async openRead({ key }) {
    if (!/^[A-Za-z0-9-]+$/.test(key)) throw notFound('Stored file');
    const file = path.join(this.dir(), key);
    if (!fs.existsSync(file)) throw notFound('Stored file');
    return fs.createReadStream(file);
  }
};

const drivers = { gridfs, local };

export const storage = {
  driverName: () => (drivers[env.storage.driver] ? env.storage.driver : 'gridfs'),
  put: (args) => drivers[storage.driverName()].put(args),
  openRead: (ref) => {
    const driver = drivers[ref.driver];
    if (!driver) throw notFound('Storage driver');
    return driver.openRead(ref);
  },
  status: () => ({ configured: true, driver: storage.driverName(), maxUploadBytes: env.storage.maxUploadBytes })
};
