import mongoose from 'mongoose';
import { initStore } from '../data/store.js';

export const connectDB = async () => {
  // Always initialize store state
  initStore();

  const uri = process.env.MONGODB_URI;

  if (!uri || uri.trim() === '') {
    console.log('ℹ️ [FutureTech DB] No MONGODB_URI configured. Running high-performance in-memory persistence store.');
    console.log('💡 [FutureTech DB] To connect MongoDB Atlas or remote DB, set MONGODB_URI in backend/.env');
    return;
  }

  try {
    const conn = await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 4000
    });
    console.log(`🚀 [FutureTech DB] MongoDB Connected: ${conn.connection.host}`);
  } catch (error) {
    console.warn(`⚠️ [FutureTech DB] MongoDB connection failed (${error.message}).`);
    console.log('🔄 [FutureTech DB] Seamlessly continuing with integrated persistence store. All APIs operational!');
  }
};
