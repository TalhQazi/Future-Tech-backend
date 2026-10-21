import { MongoClient } from 'mongodb';

const uri = 'mongodb+srv://talhanizami01_db_user:O7Ux3QhIVe1OgzGP@cluster0.w7dgqaj.mongodb.net';

async function cleanAtlas() {
  console.log('Connecting to MongoDB Atlas...');
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db('futuretech');

  const toWipe = [
    'customers',
    'vehicles',
    'repairorders',
    'appointments',
    'inspections',
    'estimates',
    'invoices',
    'diagnosticsessions',
    'auditlogs'
  ];

  for (const col of toWipe) {
    const res = await db.collection(col).deleteMany({});
    console.log(`✓ Wiped ${col}: ${res.deletedCount} dummy records removed.`);
  }

  // Remove dummy customer user
  await db.collection('users').deleteMany({ role: 'customer' });

  // Update staff users to generic clean names
  await db.collection('users').updateOne(
    { role: 'advisor' },
    { $set: { name: 'Service Advisor', email: 'advisor@futuretech.com' } }
  );
  await db.collection('users').updateOne(
    { role: 'technician' },
    { $set: { name: 'Master Technician', email: 'tech@futuretech.com' } }
  );
  await db.collection('users').updateOne(
    { role: 'manager' },
    { $set: { name: 'Shop Manager', email: 'manager@futuretech.com' } }
  );

  console.log('✅ MongoDB Atlas database successfully wiped clean of all dummy records!');
  await client.close();
}

cleanAtlas().catch(err => {
  console.error('Error cleaning Atlas:', err);
  process.exit(1);
});
