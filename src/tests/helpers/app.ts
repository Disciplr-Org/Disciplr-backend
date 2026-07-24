import { bootstrapApp } from '../../app-bootstrap.js'
import { setupTestDatabase, teardownTestDatabase } from './testDatabase.js'
import { type Knex } from 'knex'

/**
 * Initialize the application for testing
 * - Sets up a fresh test database
 * - Bootstraps the Express application with all routes
 * 
 * @returns Object containing the app, jobSystem, and database connection
 */
export async function initTestApp() {
  const { knex: db } = await setupTestDatabase()
  const { app, jobSystem } = bootstrapApp()
  
  return { app, jobSystem, db }
}

/**
 * Clean up test application resources
 * - Destroys the database connection
 * 
 * @param db - Knex database instance
 */
export async function cleanupTestApp(db: Knex) {
  await teardownTestDatabase(db)
}
