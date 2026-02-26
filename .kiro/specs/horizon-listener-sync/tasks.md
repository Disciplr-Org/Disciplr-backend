# Implementation Plan: Horizon Listener → Database Sync

## Overview

This implementation plan breaks down the Horizon Listener → Database Sync feature into discrete, testable coding tasks. The approach follows a bottom-up strategy: first establishing the database schema and core data models, then building the parsing and processing logic, and finally wiring everything together with the Horizon listener service. Each task builds incrementally on previous work, with property-based tests integrated close to implementation to catch errors early.

## Tasks

- [x] 1. Create database migrations for new tables
  - [x] 1.1 Create milestones table migration
    - Create migration file `db/migrations/YYYYMMDDHHMMSS_create_milestones.cjs`
    - Define milestones table with fields: id, vault_id, title, description, target_amount, current_amount, deadline, status, created_at, updated_at
    - Create milestone_status enum: pending, in_progress, completed, failed
    - Add foreign key constraint on vault_id referencing vaults(id) with ON DELETE CASCADE
    - Create indexes on vault_id, status, and deadline
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_
  
  - [x] 1.2 Create validations table migration
    - Create migration file `db/migrations/YYYYMMDDHHMMSS_create_validations.cjs`
    - Define validations table with fields: id, milestone_id, validator_address, validation_result, evidence_hash, validated_at, created_at
    - Create validation_result enum: approved, rejected, pending_review
    - Add foreign key constraint on milestone_id referencing milestones(id) with ON DELETE CASCADE
    - Create indexes on milestone_id, validator_address, and validated_at
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_
  
  - [x] 1.3 Create processed_events table migration
    - Create migration file `db/migrations/YYYYMMDDHHMMSS_create_processed_events.cjs`
    - Define processed_events table with fields: event_id, transaction_hash, event_index, ledger_number, processed_at, created_at
    - Add unique constraint on event_id
    - Create indexes on transaction_hash, processed_at, and ledger_number
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_
  
  - [x] 1.4 Create failed_events table migration
    - Create migration file `db/migrations/YYYYMMDDHHMMSS_create_failed_events.cjs`
    - Define failed_events table with fields: id, event_id, event_payload, error_message, retry_count, failed_at, created_at
    - Create indexes on event_id and failed_at
    - _Requirements: 8.1, 8.3, 8.4_
  
  - [x] 1.5 Create listener_state table migration
    - Create migration file `db/migrations/YYYYMMDDHHMMSS_create_listener_state.cjs`
    - Define listener_state table with fields: id, service_name, last_processed_ledger, last_processed_at, created_at, updated_at
    - Add unique constraint on service_name
    - Create unique index on service_name
    - _Requirements: 10.1, 10.5_

- [x] 2. Implement TypeScript type definitions for data models
  - [x] 2.1 Create type definitions file
    - Create `src/types/horizonSync.ts` with interfaces for: Milestone, Validation, ProcessedEvent, FailedEvent, ListenerState
    - Define EventType union type for all supported event types
    - Define ParsedEvent interface with eventId, transactionHash, eventIndex, ledgerNumber, eventType, and payload
    - Define payload interfaces: VaultEventPayload, MilestoneEventPayload, ValidationEventPayload
    - Define HorizonListenerConfig, ProcessorConfig, and RetryConfig interfaces
    - _Requirements: 2.7, 9.4, 14.1_

- [x] 3. Implement event parser service
  - [x] 3.1 Create event parser with XDR decoding
    - Create `src/services/eventParser.ts`
    - Implement parseHorizonEvent function that decodes XDR format to JavaScript objects
    - Extract event metadata: transaction hash, event index, ledger number
    - Generate event_id in format `{transaction_hash}:{event_index}`
    - Return ParseResult with success/failure and parsed event or error details
    - _Requirements: 11.1, 3.4_
  
  - [x] 3.2 Add event type detection and routing
    - Implement event type detection from Horizon event topic field
    - Map event topics to EventType enum values
    - Route to appropriate payload parser based on event type
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_
  
  - [x] 3.3 Add payload validation for each event type
    - Implement validation for vault_created events: check required fields (creator, amount, timestamps, destinations)
    - Implement validation for vault status events: check vault_id and status fields
    - Implement validation for milestone_created events: check required fields (vault_id, title, target_amount, deadline)
    - Implement validation for milestone_validated events: check required fields (milestone_id, validator_address, validation_result)
    - Validate data types for all extracted fields
    - Return validation errors with details for malformed events
    - _Requirements: 11.2, 11.3, 11.4, 11.5_
  
  - [ ]* 3.4 Write property test for event parsing round-trip
    - **Property 14: Event Parsing Round-Trip**
    - **Validates: Requirements 11.1, 12.5**
    - Use fast-check to generate valid parsed events
    - Encode to XDR format and parse back
    - Assert that parsed result matches original event structure
  
  - [ ]* 3.5 Write property test for malformed event validation
    - **Property 15: Malformed Event Validation Errors**
    - **Validates: Requirements 11.2, 11.3, 11.4**
    - Use fast-check to generate events with missing/invalid fields
    - Assert that parser returns validation error with details
    - Assert that parser does not throw exceptions

- [x] 4. Implement retry logic utility
  - [x] 4.1 Create retry utility with exponential backoff
    - Create `src/utils/retry.ts`
    - Implement retryWithBackoff function with configurable max attempts, initial backoff, and multiplier
    - Implement exponential backoff calculation with max backoff cap
    - Add isRetryable predicate to distinguish transient vs non-retryable errors
    - Include sleep utility for backoff delays
    - _Requirements: 7.1, 1.4_

- [x] 5. Implement event processor service
  - [x] 5.1 Create event processor with idempotency checking
    - Create `src/services/eventProcessor.ts`
    - Implement EventProcessor class with constructor accepting db and config
    - Implement processEvent method that checks processed_events table for event_id
    - Return success immediately if event_id exists (idempotency)
    - _Requirements: 3.1, 3.2, 9.1_
  
  - [x] 5.2 Implement vault event handler
    - Implement handleVaultEvent function that processes vault_created, vault_completed, vault_failed, vault_cancelled events
    - For vault_created: insert or update vault record with all required fields
    - For vault status events: update vault status field
    - Execute all operations within database transaction
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 9.3_
  
  - [x] 5.3 Implement milestone event handler
    - Implement handleMilestoneEvent function that processes milestone_created events
    - Insert milestone record with vault_id foreign key
    - Validate that referenced vault exists
    - Execute within database transaction
    - _Requirements: 2.5, 9.3_
  
  - [x] 5.4 Implement validation event handler
    - Implement handleValidationEvent function that processes milestone_validated events
    - Insert validation record with milestone_id foreign key
    - Validate that referenced milestone exists
    - Execute within database transaction
    - _Requirements: 2.6, 9.3_
  
  - [x] 5.5 Add event_id storage on successful processing
    - After successful event processing, insert event_id into processed_events table
    - Store transaction_hash, event_index, and ledger_number
    - Commit transaction only after event_id is stored
    - _Requirements: 3.3, 6.5_
  
  - [x] 5.6 Implement transaction rollback on failure
    - Wrap all processing in try-catch block
    - Rollback transaction on any error
    - Ensure no partial database changes are visible
    - _Requirements: 7.5, 9.3_
  
  - [x] 5.7 Add retry logic for transient errors
    - Integrate retryWithBackoff utility for database operations
    - Retry up to 3 times for transient errors (connection failures, deadlocks)
    - Skip retry for validation errors
    - _Requirements: 7.1, 7.2_
  
  - [x] 5.8 Implement dead letter queue for exhausted retries
    - After max retries exhausted, insert event into failed_events table
    - Store complete event payload as JSON
    - Store error message and retry count
    - _Requirements: 7.3, 8.2_
  
  - [x] 5.9 Add audit logging for event processing
    - Create audit log entry on successful processing with action, event_id, and affected records
    - Create audit log entry on failed processing with error details
    - Include metadata: event_type, transaction_hash, ledger_number, processing_duration_ms
    - Use info level for success, warn level for failures
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5_
  
  - [ ]* 5.10 Write property test for idempotent event processing
    - **Property 8: Idempotent Event Processing**
    - **Validates: Requirements 3.2, 3.5**
    - Use fast-check to generate random events
    - Process same event 3 times
    - Assert database state is identical after each processing
  
  - [ ]* 5.11 Write property test for vault creation field mapping
    - **Property 2: Vault Creation Field Mapping**
    - **Validates: Requirements 2.1**
    - Use fast-check to generate vault_created events
    - Process event and query vault record
    - Assert all required fields are present and match event payload
  
  - [ ]* 5.12 Write property test for vault status transitions
    - **Property 3: Vault Status Transitions**
    - **Validates: Requirements 2.2, 2.3, 2.4**
    - Use fast-check to generate vault status events
    - Process event and query vault record
    - Assert status field matches event type
  
  - [ ]* 5.13 Write property test for milestone creation with vault link
    - **Property 4: Milestone Creation with Vault Link**
    - **Validates: Requirements 2.5**
    - Use fast-check to generate milestone_created events
    - Process event and query milestone record
    - Assert vault_id foreign key references existing vault
  
  - [ ]* 5.14 Write property test for validation creation with milestone link
    - **Property 5: Validation Creation with Milestone Link**
    - **Validates: Requirements 2.6**
    - Use fast-check to generate milestone_validated events
    - Process event and query validation record
    - Assert milestone_id foreign key references existing milestone
  
  - [ ]* 5.15 Write property test for event ID storage on success
    - **Property 6: Event ID Storage on Success**
    - **Validates: Requirements 3.3**
    - Use fast-check to generate random events
    - Process event successfully
    - Assert event_id exists in processed_events with correct metadata
  
  - [ ]* 5.16 Write property test for event ID format
    - **Property 7: Event ID Format**
    - **Validates: Requirements 3.4**
    - Use fast-check to generate events with various transaction hashes and indexes
    - Process events
    - Assert event_id follows format `{transaction_hash}:{event_index}`
  
  - [ ]* 5.17 Write property test for transaction atomicity on failure
    - **Property 11: Transaction Atomicity on Failure**
    - **Validates: Requirements 7.5, 9.3**
    - Use fast-check to generate events
    - Simulate database failure mid-transaction
    - Assert no partial changes are visible in database
  
  - [ ]* 5.18 Write property test for dead letter queue after retry exhaustion
    - **Property 10: Dead Letter Queue After Retry Exhaustion**
    - **Validates: Requirements 7.3, 8.2**
    - Use fast-check to generate events
    - Simulate persistent transient errors
    - Assert event is inserted into failed_events after max retries
  
  - [ ]* 5.19 Write property test for invalid events skip without retry
    - **Property 9: Invalid Events Skip Without Retry**
    - **Validates: Requirements 7.2, 11.5**
    - Use fast-check to generate malformed events
    - Process events
    - Assert error is logged, event is skipped, and not added to failed_events
  
  - [ ]* 5.20 Write property test for failed event payload completeness
    - **Property 12: Failed Event Payload Completeness**
    - **Validates: Requirements 8.3**
    - Use fast-check to generate events that will fail
    - Process events until they reach dead letter queue
    - Assert event_payload in failed_events contains all original data
  
  - [ ]* 5.21 Write property test for audit log on successful processing
    - **Property 16: Audit Log on Successful Processing**
    - **Validates: Requirements 13.1**
    - Use fast-check to generate events
    - Process events successfully
    - Assert audit log entry exists with action, event_id, and affected records
  
  - [ ]* 5.22 Write property test for audit log on failed processing
    - **Property 17: Audit Log on Failed Processing**
    - **Validates: Requirements 13.2**
    - Use fast-check to generate events that will fail
    - Process events
    - Assert audit log entry exists with event_id, error message, and retry count
  
  - [ ]* 5.23 Write property test for audit log metadata completeness
    - **Property 18: Audit Log Metadata Completeness**
    - **Validates: Requirements 13.4**
    - Use fast-check to generate events
    - Process events
    - Assert audit log includes event_type, transaction_hash, ledger_number, processing_duration_ms

- [ ] 6. Checkpoint - Ensure event processor tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Implement Horizon listener service
  - [x] 7.1 Create Horizon listener with Stellar SDK integration
    - Create `src/services/horizonListener.ts`
    - Implement HorizonListener class with constructor accepting config, eventProcessor, and db
    - Initialize Stellar SDK Server instance with horizonUrl from config
    - Implement start method that establishes Horizon connection
    - _Requirements: 1.1, 14.1_
  
  - [x] 7.2 Add ledger cursor persistence and resumption
    - On start, query listener_state table for last_processed_ledger
    - If cursor exists, resume from that ledger
    - If no cursor exists, use START_LEDGER from config or default
    - Implement updateCursor method that updates listener_state table
    - Call updateCursor after each successful event processing
    - _Requirements: 1.2, 10.2, 10.3, 10.4, 14.5_
  
  - [x] 7.3 Implement contract address filtering
    - Filter incoming events by contractId field
    - Only process events from configured CONTRACT_ADDRESS list
    - Skip events from other contracts without logging
    - _Requirements: 1.5_
  
  - [x] 7.4 Add event streaming and processing coordination
    - Use Stellar SDK's event streaming API to receive events
    - For each event, call eventParser.parseHorizonEvent
    - Pass parsed event to eventProcessor.processEvent
    - Handle parsing errors by logging and skipping event
    - _Requirements: 1.3, 9.1_
  
  - [x] 7.5 Implement connection retry with exponential backoff
    - Catch Horizon API connection failures
    - Retry with exponential backoff: 1s → 2s → 4s → ... → 60s max
    - Continue retrying indefinitely until connection restored
    - Log connection status at WARN level every 10 failed attempts
    - _Requirements: 1.4_
  
  - [x] 7.6 Add graceful shutdown handling
    - Register SIGTERM and SIGINT signal handlers
    - On shutdown signal, stop accepting new events
    - Wait for in-flight events to complete with 30 second timeout
    - Close Horizon connection and database connections
    - Force terminate if timeout exceeded with warning log
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5_
  
  - [ ]* 7.7 Write property test for contract address filtering
    - **Property 1: Contract Address Filtering**
    - **Validates: Requirements 1.5**
    - Use fast-check to generate events with various contract addresses
    - Process events through listener
    - Assert only events from configured addresses are processed
  
  - [ ]* 7.8 Write property test for cursor update on success
    - **Property 13: Cursor Update on Success**
    - **Validates: Requirements 10.2**
    - Use fast-check to generate events with various ledger numbers
    - Process events successfully
    - Assert listener_state is updated with correct ledger_number

- [x] 8. Implement configuration management
  - [x] 8.1 Create configuration loader
    - Create `src/config/horizonListener.ts`
    - Load configuration from environment variables: HORIZON_URL, CONTRACT_ADDRESS, START_LEDGER, RETRY_MAX_ATTEMPTS, RETRY_BACKOFF_MS
    - Parse CONTRACT_ADDRESS as comma-separated list
    - Provide default values for optional settings
    - _Requirements: 14.1, 14.4_
  
  - [x] 8.2 Add configuration validation
    - Validate all required configuration on startup
    - Check that HORIZON_URL and CONTRACT_ADDRESS are present
    - Log error and exit with non-zero status if required config missing
    - _Requirements: 14.2, 14.3_
  
  - [ ]* 8.3 Write property test for required configuration validation
    - **Property 19: Required Configuration Validation**
    - **Validates: Requirements 14.2, 14.3**
    - Use fast-check to generate configs with missing required fields
    - Attempt to start listener
    - Assert listener fails to start and logs error message

- [x] 9. Create test fixtures and helpers
  - [x] 9.1 Create mocked Horizon event fixtures
    - Create `src/tests/fixtures/horizonEvents.ts`
    - Define mock events for all event types: vault_created, vault_completed, vault_failed, vault_cancelled, milestone_created, milestone_validated
    - Include valid XDR-encoded payloads
    - _Requirements: 12.1_
  
  - [x] 9.2 Create fast-check arbitraries for property tests
    - Create `src/tests/fixtures/arbitraries.ts`
    - Implement arbitraryParsedEvent generator
    - Implement generators for each event type with valid field constraints
    - Use appropriate fast-check combinators for strings, numbers, dates
    - _Requirements: 12.1_
  
  - [x] 9.3 Create test database helpers
    - Create `src/tests/helpers/testDatabase.ts`
    - Implement setupTestDatabase function that runs migrations and cleans tables
    - Implement teardownTestDatabase function that destroys connection
    - Implement captureDbState function that snapshots all relevant tables
    - _Requirements: 12.2, 12.3_

- [ ] 10. Write integration tests
  - [ ]* 10.1 Write end-to-end test for vault lifecycle
    - Create `src/tests/integration/vaultLifecycle.test.ts`
    - Test complete flow: vault_created → milestone_created → milestone_validated → vault_completed
    - Use mocked Horizon events
    - Assert database state after each event
    - _Requirements: 12.1_
  
  - [ ]* 10.2 Write test for idempotent processing with retries
    - Create `src/tests/integration/idempotency.test.ts`
    - Process same event multiple times
    - Simulate database failures and retries
    - Assert final database state is consistent
    - _Requirements: 12.2_
  
  - [ ]* 10.3 Write test for dead letter queue behavior
    - Create `src/tests/integration/deadLetterQueue.test.ts`
    - Simulate persistent transient errors
    - Assert events move to failed_events after max retries
    - Test reprocessing from dead letter queue
    - _Requirements: 12.4_

- [x] 11. Implement reprocess failed events functionality
  - [x] 11.1 Add reprocessFailedEvent method to event processor
    - Implement reprocessFailedEvent method that queries failed_events table
    - Parse event_payload JSON back to ParsedEvent
    - Call processEvent with parsed event
    - Delete from failed_events on success
    - _Requirements: 8.5_

- [x] 12. Create main entry point for listener service
  - [x] 12.1 Create listener service entry point
    - Create `src/services/horizonListenerMain.ts` or integrate into existing entry point
    - Load configuration using config loader
    - Initialize database connection
    - Create EventProcessor instance
    - Create HorizonListener instance
    - Call listener.start()
    - Handle startup errors and exit gracefully
    - _Requirements: 1.1, 14.2, 14.3_

- [x] 13. Update environment variables documentation
  - [x] 13.1 Add Horizon listener environment variables to .env.example
    - Add HORIZON_URL with example value
    - Add CONTRACT_ADDRESS with example value
    - Add START_LEDGER with example value
    - Add RETRY_MAX_ATTEMPTS with default value
    - Add RETRY_BACKOFF_MS with default value
    - _Requirements: 14.1_

- [ ] 14. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Property tests use fast-check with minimum 100 iterations per test
- All database operations use transactions for atomicity
- Retry logic distinguishes between transient and non-retryable errors
- Graceful shutdown ensures in-flight events complete before termination
- Configuration validation happens at startup to fail fast
- Dead letter queue enables manual investigation and reprocessing of failed events
