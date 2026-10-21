import { initStore, saveStore } from '../data/store.js';

console.log('Seeding FutureTech 2.0 database...');
initStore();
saveStore();
console.log('✅ Seed completed successfully!');
process.exit(0);
