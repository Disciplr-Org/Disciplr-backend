import knex, { Knex } from 'knex'

/**
 * Test database helpers for setting up, tearing down, and capturing database state
 * These utilities ensure clean test environments and enable state comparison
 */

// Database state snapshot interface
export interface DbState {
  vaults: any[]
  milestones: any[]
  validations: any[]
  processedEvents: any[]
  failedEvents: any[]
  listenerState: any[]
}

/**
 * Setup a test database connection and prepare it for testing
 * - Connects to the test database
 * - Runs all migrations
 * - Cleans all tables
 * 
 * @returns Knex database instance
 */
export async function setupTestDatabase(): Promise<Knex> {
  const db = knex({
    client: 'pg',
    connection: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/disciplr_test'
  })

  // Run migrations to ensure schema is up to date
  await db.migrate.latest()

  // Clean all tables to ensure a fresh state
  await cleanAllTables(db)

  return db
}

/**
 * Teardown the test database connection
 * - Destroys the database connection pool
 * 
 * @param db - Knex database instance
 */
export async function teardownTestDatabase(db: Knex): Promise<void> {
  await db.destroy()
}

/**
 * Clean all tables in the database
 * Deletes all records from all tables in the correct order to respect foreign key constraints
 * 
 * @param db - Knex database instance
 */
export async function cleanAllTables(db: Knex): Promise<void> {
  // Delete in order to respect foreign key constraints
  await db('validations').delete()
  await db('milestones').delete()
  await db('vaults').delete()
  await db('processed_events').delete()
  await db('failed_events').delete()
  await db('listener_state').delete()
}

/**
 * Capture the current state of all relevant database tables
 * Returns a snapshot of all records in all tables, sorted by ID for consistent comparison
 * 
 * @param db - Knex database instance
 * @returns DbState snapshot
 */
export async function captureDbState(db: Knex): Promise<DbState> {
  return {
    vaults: await db('vaults').select('*').orderBy('id'),
    milestones: await db('milestones').select('*').orderBy('id'),
    validations: await db('validations').select('*').orderBy('id'),
    processedEvents: await db('processed_events').select('*').orderBy('event_id'),
    failedEvents: await db('failed_events').select('*').orderBy('id'),
    listenerState: await db('listener_state').select('*').orderBy('id')
  }
}

/**
 * Compare two database states for equality
 * Useful for testing idempotency and transaction atomicity
 * 
 * @param state1 - First database state
 * @param state2 - Second database state
 * @returns true if states are equal, false otherwise
 */
export function compareDbStates(state1: DbState, state2: DbState): boolean {
  return (
    JSON.stringify(state1.vaults) === JSON.stringify(state2.vaults) &&
    JSON.stringify(state1.milestones) === JSON.stringify(state2.milestones) &&
    JSON.stringify(state1.validations) === JSON.stringify(state2.validations) &&
    JSON.stringify(state1.processedEvents) === JSON.stringify(state2.processedEvents) &&
    JSON.stringify(state1.failedEvents) === JSON.stringify(state2.failedEvents) &&
    JSON.stringify(state1.listenerState) === JSON.stringify(state2.listenerState)
  )
}

/**
 * Insert a test vault into the database
 * Helper function to quickly create a vault for testing milestone and validation events
 * 
 * @param db - Knex database instance
 * @param vaultId - Vault ID
 * @param overrides - Optional field overrides
 */
export async function insertTestVault(
  db: Knex,
  vaultId: string,
  overrides: Partial<{
    creator: string
    amount: string
    startTimestamp: Date
    endTimestamp: Date
    successDestination: string
    failureDestination: string
    status: string
  }> = {}
): Promise<void> {
  await db('vaults').insert({
    id: vaultId,
    creator: overrides.creator || 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    amount: overrides.amount || '1000.0000000',
    start_timestamp: overrides.startTimestamp || new Date('2024-01-01'),
    end_timestamp: overrides.endTimestamp || new Date('2024-12-31'),
    success_destination: overrides.successDestination || 'GSUCCESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    failure_destination: overrides.failureDestination || 'GFAILUREXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    status: overrides.status || 'active',
    created_at: new Date()
  })
}

/**
 * Insert a test milestone into the database
 * Helper function to quickly create a milestone for testing validation events
 * 
 * @param db - Knex database instance
 * @param milestoneId - Milestone ID
 * @param vaultId - Vault ID (must exist)
 * @param overrides - Optional field overrides
 */
export async function insertTestMilestone(
  db: Knex,
  milestoneId: string,
  vaultId: string,
  overrides: Partial<{
    title: string
    description: string
    targetAmount: string
    currentAmount: string
    deadline: Date
    status: string
  }> = {}
): Promise<void> {
  await db('milestones').insert({
    id: milestoneId,
    vault_id: vaultId,
    title: overrides.title || 'Test Milestone',
    description: overrides.description || 'Test milestone description',
    target_amount: overrides.targetAmount || '500.0000000',
    current_amount: overrides.currentAmount || '0',
    deadline: overrides.deadline || new Date('2024-06-30'),
    status: overrides.status || 'pending',
    created_at: new Date(),
    updated_at: new Date()
  })
}

/**
 * Get the count of records in a table
 * Useful for quick assertions about table state
 * 
 * @param db - Knex database instance
 * @param tableName - Name of the table
 * @returns Number of records in the table
 */
export async function getTableCount(db: Knex, tableName: string): Promise<number> {
  const result = await db(tableName).count('* as count').first()
  return parseInt(result?.count as string || '0', 10)
}

/**
 * Check if an event has been processed
 * Queries the processed_events table for the given event ID
 * 
 * @param db - Knex database instance
 * @param eventId - Event ID to check
 * @returns true if event has been processed, false otherwise
 */
export async function isEventProcessed(db: Knex, eventId: string): Promise<boolean> {
  const result = await db('processed_events').where({ event_id: eventId }).first()
  return !!result
}

/**
 * Check if an event is in the dead letter queue
 * Queries the failed_events table for the given event ID
 * 
 * @param db - Knex database instance
 * @param eventId - Event ID to check
 * @returns true if event is in DLQ, false otherwise
 */
export async function isEventInDLQ(db: Knex, eventId: string): Promise<boolean> {
  const result = await db('failed_events').where({ event_id: eventId }).first()
  return !!result
}

/**
 * Wait for a condition to be true (with timeout)
 * Useful for testing asynchronous operations
 * 
 * @param condition - Function that returns true when condition is met
 * @param timeoutMs - Maximum time to wait in milliseconds
 * @param intervalMs - Interval between checks in milliseconds
 * @returns true if condition was met, false if timeout
 */
export async function waitForCondition(
  condition: () => Promise<boolean>,
  timeoutMs: number = 5000,
  intervalMs: number = 100
): Promise<boolean> {
  const startTime = Date.now()
  
  while (Date.now() - startTime < timeoutMs) {
    if (await condition()) {
      return true
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
  
  return false
}
