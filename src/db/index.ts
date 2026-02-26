import knex from 'knex'
// @ts-ignore
import knexConfig from '../../knexfile.cjs'
import pg from 'pg';
import 'dotenv/config';

const { Pool } = pg;

// Use for migrations and legacy logic
export const db = knex((knexConfig as any).default || knexConfig)

// Use for high-performance direct queries
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

export default pool;
