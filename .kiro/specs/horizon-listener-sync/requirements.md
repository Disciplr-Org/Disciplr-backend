# Requirements Document

## Introduction

The Horizon Listener → Database Sync feature enables the Disciplr backend to consume on-chain events from the Soroban blockchain via the Horizon API and translate them into database updates for vaults, milestones, and validations. This feature provides the bridge between blockchain state and the backend's PostgreSQL database, ensuring data consistency and enabling the backend to serve up-to-date information about on-chain activities.

## Glossary

- **Horizon_Listener**: The service component that connects to the Stellar Horizon API to receive Soroban contract events
- **Event_Processor**: The component that translates Horizon events into database operations
- **Vault**: A time-locked commitment contract on Soroban with associated database record
- **Milestone**: A checkpoint within a vault representing progress toward a goal
- **Validation**: A verification record confirming milestone completion or vault status
- **Event_ID**: A unique identifier for a blockchain event (transaction hash + event index)
- **Dead_Letter_Queue**: A storage mechanism for events that fail processing after retry attempts
- **Idempotency_Store**: A data structure tracking processed Event_IDs to prevent duplicate processing

## Requirements

### Requirement 1: Horizon Event Listening

**User Story:** As a backend system, I want to listen to Soroban contract events via Horizon API, so that I can detect on-chain activities in real-time

#### Acceptance Criteria

1. THE Horizon_Listener SHALL connect to the Stellar Horizon API using the official Stellar SDK
2. WHEN the Horizon_Listener starts, THE Horizon_Listener SHALL resume from the last successfully processed ledger
3. WHEN a Soroban contract event is emitted, THE Horizon_Listener SHALL receive the event within 10 seconds
4. IF the Horizon API connection fails, THEN THE Horizon_Listener SHALL retry with exponential backoff starting at 1 second up to 60 seconds
5. THE Horizon_Listener SHALL filter events to only process events from configured Disciplr contract addresses

### Requirement 2: Event-to-Database Mapping

**User Story:** As a backend system, I want to map blockchain events to database operations, so that on-chain state changes are reflected in the database

#### Acceptance Criteria

1. WHEN a vault_created event is received, THE Event_Processor SHALL create or update a vault record with creator, amount, start_timestamp, end_timestamp, success_destination, failure_destination, and status fields
2. WHEN a vault_completed event is received, THE Event_Processor SHALL update the vault status to completed
3. WHEN a vault_failed event is received, THE Event_Processor SHALL update the vault status to failed
4. WHEN a vault_cancelled event is received, THE Event_Processor SHALL update the vault status to cancelled
5. WHEN a milestone_created event is received, THE Event_Processor SHALL create a milestone record linked to the vault
6. WHEN a milestone_validated event is received, THE Event_Processor SHALL create a validation record linked to the milestone
7. THE Event_Processor SHALL extract all required fields from the event payload and map them to the corresponding database schema

### Requirement 3: Idempotent Event Processing

**User Story:** As a backend system, I want to process events idempotently, so that retrying failed events does not corrupt data

#### Acceptance Criteria

1. WHEN an event is received, THE Event_Processor SHALL check the Idempotency_Store for the Event_ID before processing
2. IF an Event_ID exists in the Idempotency_Store, THEN THE Event_Processor SHALL skip processing and return success
3. WHEN an event is successfully processed, THE Event_Processor SHALL store the Event_ID in the Idempotency_Store with a timestamp
4. THE Idempotency_Store SHALL use the transaction hash combined with event index as the Event_ID
5. FOR ALL events, processing the same event multiple times SHALL produce the same database state as processing it once (idempotence property)

### Requirement 4: Database Schema for Milestones

**User Story:** As a developer, I want a milestones table in the database, so that I can store milestone data from blockchain events

#### Acceptance Criteria

1. THE milestones table SHALL include fields: id, vault_id, title, description, target_amount, current_amount, deadline, status, created_at, updated_at
2. THE milestones table SHALL have a foreign key constraint on vault_id referencing the vaults table
3. THE milestones table SHALL have an index on vault_id for efficient queries
4. THE milestones table SHALL have an index on status for filtering
5. THE milestone status field SHALL be an enum with values: pending, in_progress, completed, failed

### Requirement 5: Database Schema for Validations

**User Story:** As a developer, I want a validations table in the database, so that I can store validation records from blockchain events

#### Acceptance Criteria

1. THE validations table SHALL include fields: id, milestone_id, validator_address, validation_result, evidence_hash, validated_at, created_at
2. THE validations table SHALL have a foreign key constraint on milestone_id referencing the milestones table
3. THE validations table SHALL have an index on milestone_id for efficient queries
4. THE validations table SHALL have an index on validator_address for filtering
5. THE validation_result field SHALL be an enum with values: approved, rejected, pending_review

### Requirement 6: Idempotency Store Schema

**User Story:** As a developer, I want an event processing tracking table, so that the system can prevent duplicate event processing

#### Acceptance Criteria

1. THE processed_events table SHALL include fields: event_id, transaction_hash, event_index, ledger_number, processed_at, created_at
2. THE processed_events table SHALL have a unique constraint on event_id
3. THE processed_events table SHALL have an index on transaction_hash for lookups
4. THE processed_events table SHALL have an index on processed_at for cleanup queries
5. THE Event_Processor SHALL query this table before processing any event

### Requirement 7: Error Handling and Retry Logic

**User Story:** As a backend system, I want robust error handling with retries, so that transient failures do not cause data loss

#### Acceptance Criteria

1. WHEN event processing fails due to a database error, THE Event_Processor SHALL retry up to 3 times with exponential backoff
2. WHEN event processing fails due to invalid event data, THE Event_Processor SHALL log the error and skip the event without retrying
3. IF an event fails all retry attempts, THEN THE Event_Processor SHALL move the event to the Dead_Letter_Queue
4. THE Event_Processor SHALL log all processing errors with event details, error message, and retry count
5. WHEN a database transaction fails, THE Event_Processor SHALL rollback all changes for that event

### Requirement 8: Dead Letter Queue

**User Story:** As a developer, I want failed events stored in a dead letter queue, so that I can investigate and manually reprocess them

#### Acceptance Criteria

1. THE failed_events table SHALL include fields: id, event_id, event_payload, error_message, retry_count, failed_at, created_at
2. WHEN an event exhausts all retries, THE Event_Processor SHALL insert the event into the failed_events table
3. THE failed_events table SHALL store the complete event payload as JSON
4. THE failed_events table SHALL have an index on failed_at for time-based queries
5. THE Event_Processor SHALL provide a method to reprocess events from the failed_events table

### Requirement 9: Event Processing Service Layer

**User Story:** As a developer, I want a service layer for event processing, so that business logic is separated from infrastructure concerns

#### Acceptance Criteria

1. THE Event_Processing_Service SHALL provide methods: processVaultEvent, processMilestoneEvent, processValidationEvent
2. THE Event_Processing_Service SHALL validate event payloads before database operations
3. THE Event_Processing_Service SHALL use database transactions for all multi-step operations
4. THE Event_Processing_Service SHALL return structured results indicating success or failure with details
5. THE Event_Processing_Service SHALL follow the existing service layer pattern from apiKeys.ts

### Requirement 10: Ledger Cursor Persistence

**User Story:** As a backend system, I want to persist the last processed ledger, so that the listener can resume after restarts without reprocessing events

#### Acceptance Criteria

1. THE listener_state table SHALL include fields: id, service_name, last_processed_ledger, last_processed_at, created_at, updated_at
2. WHEN an event is successfully processed, THE Horizon_Listener SHALL update the last_processed_ledger for the current ledger
3. WHEN the Horizon_Listener starts, THE Horizon_Listener SHALL query the listener_state table for the last_processed_ledger
4. IF no cursor exists in listener_state, THEN THE Horizon_Listener SHALL start from the ledger specified in configuration
5. THE listener_state table SHALL have a unique constraint on service_name

### Requirement 11: Event Parsing and Validation

**User Story:** As a backend system, I want to parse and validate event payloads, so that only well-formed events are processed

#### Acceptance Criteria

1. THE Event_Parser SHALL decode Soroban event data from XDR format to JavaScript objects
2. WHEN an event payload is malformed, THE Event_Parser SHALL return a validation error with details
3. THE Event_Parser SHALL validate required fields for each event type before processing
4. THE Event_Parser SHALL validate data types for all extracted fields
5. IF validation fails, THEN THE Event_Processor SHALL log the error and skip the event without retrying

### Requirement 12: Testing with Mocked Horizon Events

**User Story:** As a developer, I want comprehensive tests using mocked Horizon events, so that I can verify event processing logic without blockchain dependencies

#### Acceptance Criteria

1. THE test suite SHALL include mocked Horizon event fixtures for all supported event types
2. THE test suite SHALL verify idempotent processing by processing the same event multiple times
3. THE test suite SHALL verify error handling by simulating database failures
4. THE test suite SHALL verify dead letter queue behavior for exhausted retries
5. THE test suite SHALL verify round-trip property: parsing a valid event then formatting it SHALL produce an equivalent event structure

### Requirement 13: Audit Logging for Event Processing

**User Story:** As a developer, I want audit logs for event processing, so that I can track system behavior and debug issues

#### Acceptance Criteria

1. WHEN an event is successfully processed, THE Event_Processor SHALL create an audit log with action, event_id, and affected records
2. WHEN an event fails processing, THE Event_Processor SHALL create an audit log with error details
3. THE Event_Processor SHALL use the existing audit logging pattern from audit-logs.ts
4. THE audit logs SHALL include metadata: event_type, transaction_hash, ledger_number, processing_duration_ms
5. THE Event_Processor SHALL log at info level for successful processing and warn level for failures

### Requirement 14: Configuration Management

**User Story:** As a developer, I want configurable settings for the Horizon listener, so that I can adjust behavior for different environments

#### Acceptance Criteria

1. THE Horizon_Listener SHALL read configuration from environment variables: HORIZON_URL, CONTRACT_ADDRESS, START_LEDGER, RETRY_MAX_ATTEMPTS, RETRY_BACKOFF_MS
2. THE Horizon_Listener SHALL validate all required configuration on startup
3. IF required configuration is missing, THEN THE Horizon_Listener SHALL log an error and exit with a non-zero status code
4. THE Horizon_Listener SHALL support multiple contract addresses as a comma-separated list
5. WHERE configuration specifies a START_LEDGER, THE Horizon_Listener SHALL use it only when no cursor exists in listener_state

### Requirement 15: Graceful Shutdown

**User Story:** As a backend system, I want graceful shutdown of the Horizon listener, so that in-flight events are completed before process termination

#### Acceptance Criteria

1. WHEN a SIGTERM or SIGINT signal is received, THE Horizon_Listener SHALL stop accepting new events
2. WHEN shutdown is initiated, THE Horizon_Listener SHALL wait for in-flight event processing to complete with a timeout of 30 seconds
3. WHEN all in-flight events are processed, THE Horizon_Listener SHALL close the Horizon connection
4. WHEN all in-flight events are processed, THE Horizon_Listener SHALL close database connections
5. IF the shutdown timeout is exceeded, THEN THE Horizon_Listener SHALL force terminate and log a warning
