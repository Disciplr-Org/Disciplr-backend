import knex from 'knex'
import config from '../../knexfile.cjs'

export const db = knex(config)
