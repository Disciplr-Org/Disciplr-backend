import { createRequire } from 'module'
import knex from 'knex'

const require = createRequire(import.meta.url)
const config = require('../../knexfile.cjs')

export const db = knex(config)
