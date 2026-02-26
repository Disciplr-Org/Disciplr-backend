import pg from 'pg';
import 'dotenv/config';

const { Pool } = pg;

// Ensure DATABASE_URL is in your .env file
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

export default pool;