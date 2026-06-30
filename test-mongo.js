import mongoose from 'mongoose';

const uri = 'mongodb://enibeast:rz7BKeMz7dxKoVG0@cluster0-shard-00-00.dib3sxl.mongodb.net:27017,cluster0-shard-00-01.dib3sxl.mongodb.net:27017,cluster0-shard-00-02.dib3sxl.mongodb.net:27017/connect-app?ssl=true&replicaSet=atlas-yoxoj7-shard-0&authSource=admin&retryWrites=true&w=majority';

console.log('Testing connection...');
console.log('URI:', uri.replace(/:([^@]+)@/, ':****@'));

try {
  await mongoose.connect(uri);
  console.log('✅ SUCCESS! Connected to MongoDB');
  await mongoose.disconnect();
  console.log('Disconnected cleanly');
  process.exit(0);
} catch (err) {
  console.log('❌ FAILED:', err.message);
  if (err.reason) {
    console.log('Servers:', Array.from(err.reason.servers.keys()));
  }
  process.exit(1);
}