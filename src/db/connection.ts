import knex from 'knex';

const environment = process.env.NODE_ENV || 'development';
// Default config assuming usage of process.env.DATABASE_URL
export const db = knex({
    client: 'pg',
    connection: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/disciplr',
    pool: {
        min: 2,
        max: 10,
    },
});
