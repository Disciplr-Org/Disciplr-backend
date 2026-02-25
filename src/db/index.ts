import knex from 'knex'
// @ts-ignore
import config from '../../knexfile.cjs'

const db = knex((config as any).default || config)

export default db
