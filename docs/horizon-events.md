# Horizon Events Documentation

## Overview

This document describes the supported Horizon events in the Disciplr backend, their schemas, validation rules, and mapping logic. The event parser provides strict schema validation with security protections to ensure safe and reliable event processing.

## Supported Event Types

### 1. Vault Events

#### vault_created
Triggered when a new vault is created in the Disciplr system.

**Schema:**
```typescript
interface VaultCreatedPayload {
  vaultId: string                    // Required: Unique vault identifier
  creator: string                    // Required: Stellar address of vault creator (G + 55 chars)
  amount: string                     // Required: Positive decimal with up to 7 decimal places
  startTimestamp: Date               // Required: Vault start date
  endTimestamp: Date                 // Required: Vault end date (must be after startTimestamp)
  successDestination: string         // Required: Stellar address for success payouts
  failureDestination: string         // Required: Stellar address for failure refunds
  status: 'active'                   // Required: Always 'active' for creation
}
```

**Validation Rules:**
- `vaultId`: Non-empty string
- `creator`: Valid Stellar address format (`G[A-Z0-9]{55}`)
- `amount`: Valid positive decimal number with up to 7 decimal places
- `startTimestamp`/`endTimestamp`: Valid Date objects, endTimestamp > startTimestamp
- `successDestination`/`failureDestination`: Valid Stellar addresses
- Strict schema validation: No additional fields allowed

#### vault_completed
Triggered when a vault successfully completes.

**Schema:**
```typescript
interface VaultCompletedPayload {
  vaultId: string                    // Required: Vault identifier
  status: 'completed'                // Required: Always 'completed'
}
```

#### vault_failed
Triggered when a vault fails to complete.

**Schema:**
```typescript
interface VaultFailedPayload {
  vaultId: string                    // Required: Vault identifier
  status: 'failed'                   // Required: Always 'failed'
}
```

#### vault_cancelled
Triggered when a vault is cancelled.

**Schema:**
```typescript
interface VaultCancelledPayload {
  vaultId: string                    // Required: Vault identifier
  status: 'cancelled'                // Required: Always 'cancelled'
}
```

### 2. Milestone Events

#### milestone_created
Triggered when a new milestone is created within a vault.

**Schema:**
```typescript
interface MilestoneCreatedPayload {
  milestoneId: string                // Required: Unique milestone identifier
  vaultId: string                    // Required: Parent vault identifier
  title: string                      // Required: Milestone title (max 255 chars)
  description: string                 // Required: Description (max 1000 chars)
  targetAmount: string               // Required: Target amount (positive decimal, 7 places)
  deadline: Date                     // Required: Future deadline date
}
```

**Validation Rules:**
- `milestoneId`/`vaultId`: Non-empty strings
- `title`: 1-255 characters
- `description`: 0-1000 characters
- `targetAmount`: Valid positive decimal number with up to 7 decimal places
- `deadline`: Valid Date in the future
- Strict schema validation: No additional fields allowed

### 3. Validation Events

#### milestone_validated
Triggered when a milestone is validated by an external validator.

**Schema:**
```typescript
interface MilestoneValidatedPayload {
  validationId: string               // Required: Unique validation identifier
  milestoneId: string                // Required: Target milestone identifier
  validatorAddress: string           // Required: Stellar address of validator
  validationResult: 'approved' | 'rejected' | 'pending_review'  // Required
  evidenceHash: string               // Required: Evidence hash (alphanumeric, underscore, hyphen)
  validatedAt: Date                  // Required: Validation timestamp
}
```

**Validation Rules:**
- `validationId`/`milestoneId`: Non-empty strings
- `validatorAddress`: Valid Stellar address format
- `validationResult`: One of 'approved', 'rejected', 'pending_review'
- `evidenceHash`: Only alphanumeric characters, underscores, and hyphens
- `validatedAt`: Valid Date object
- Strict schema validation: No additional fields allowed

## Event Processing Flow

### 1. Raw Event Reception
```typescript
interface HorizonEvent {
  type: string                       // Event type (always 'contract')
  ledger: number                     // Ledger number
  ledgerClosedAt: string              // Ledger close timestamp
  contractId: string                  // Contract ID
  id: string                         // Event ID (format: "{txHash}-{index}")
  pagingToken: string                // Pagination token
  topic: string[]                    // Event topics [eventType, ...]
  value: { xdr: string }            // XDR-encoded payload
  inSuccessfulContractCall: boolean  // Success flag
  txHash: string                     // Transaction hash
}
```

### 2. Event ID Generation
Event IDs are generated in the format: `{transactionHash}:{eventIndex}`

### 2.1 Event-to-State Mapping
- `vault_completed`, `vault_failed`, and `vault_cancelled` events are mapped to persisted vault status transitions.
- `milestone_validated` events are stored in `validations`; approved validations also advance the referenced milestone to `completed`.
- Event processing is idempotent using the generated event ID format.

### 3. Event Type Validation
Only the following event types are supported:
- `vault_created`
- `vault_completed`
- `vault_failed`
- `vault_cancelled`
- `milestone_created`
- `milestone_validated`

### 4. Payload Parsing and Validation
- XDR data is decoded using Stellar SDK
- Payload is parsed based on event type
- Strict schema validation is applied
- Unknown fields are rejected
- Invalid formats are rejected
- Sanitized payload is returned

### 5. Error Handling
All errors are structured and include:
- Clear error messages
- Redacted sensitive information
- Detailed validation feedback

## Security Features

### 1. Prototype Pollution Prevention
- Uses `Object.create(null)` for safe object creation
- Validates field names to prevent prototype pollution
- Rejects `__proto__`, `constructor`, and `prototype` fields

### 2. Input Validation
- Strict type checking for all fields
- Format validation for Stellar addresses and amounts
- Range validation for dates and numeric values
- Length limits for string fields

### 3. Error Redaction
- Sensitive field values are redacted in error logs
- Structured error messages prevent information leakage

### 4. Schema Enforcement
- Only defined fields are allowed
- Unknown fields are explicitly rejected
- Field types are strictly validated

## Testing

### Property-Based Tests
Comprehensive property-based tests using fast-check:
- **Valid Event Processing**: Tests all valid event types with generated data
- **Invalid Input Rejection**: Tests malformed inputs and edge cases
- **Security Testing**: Tests prototype pollution and injection attempts
- **Performance Testing**: Tests processing of large event volumes

### Edge Case Coverage
- Minimum and maximum valid values
- Boundary conditions
- Null/undefined handling
- Malformed XDR data
- Extremely long strings

### Security Tests
- Prototype pollution attempts
- SQL injection patterns
- XSS attempt patterns
- Format string attacks

## Error Codes

| Error Code | Description | Example |
|-----------|-------------|---------|
| `MISSING_FIELD` | Required field is missing | "Missing or invalid vaultId field" |
| `INVALID_FORMAT` | Field format is invalid | "Invalid creator address format" |
| `INVALID_RANGE` | Field value is out of range | "endTimestamp must be after startTimestamp" |
| `UNKNOWN_FIELDS` | Schema contains unknown fields | "Unknown fields not allowed: extraField" |
| `PARSE_ERROR` | XDR parsing failed | "Failed to parse payload for event type" |
| `UNKNOWN_EVENT` | Event type not supported | "Unknown event type: unsupported_event" |

## Usage Examples

### Parsing a Valid Event
```typescript
import { parseHorizonEvent } from './services/eventParser.js'

const rawEvent = {
  type: 'contract',
  ledger: 12345,
  ledgerClosedAt: '2024-01-15T10:30:00Z',
  contractId: 'CDISCIPLR123',
  id: 'abc123def456-0',
  pagingToken: 'abc123def456-0',
  topic: ['vault_created'],
  value: { xdr: 'base64-encoded-xdr-data' },
  inSuccessfulContractCall: true,
  txHash: 'abc123def456'
}

const result = parseHorizonEvent(rawEvent)

if (result.success) {
  console.log('Parsed event:', result.event)
} else {
  console.error('Parse error:', result.error)
}
```

### Handling Validation Errors
```typescript
const result = parseHorizonEvent(rawEvent)

if (!result.success) {
  switch (result.error) {
    case 'Missing or invalid vaultId field':
      // Handle missing vault ID
      break
    case 'Invalid creator address format':
      // Handle invalid Stellar address
      break
    case 'Unknown fields not allowed':
      // Handle schema violations
      break
    default:
      // Handle other errors
      break
  }
}
```

## Migration Notes

### From Previous Version
- **Strict Validation**: New version rejects unknown fields
- **Enhanced Security**: Prototype pollution protection added
- **Better Error Messages**: More descriptive error reporting
- **Structured Logging**: Redacted sensitive information

### Breaking Changes
- Events with unknown fields will now be rejected
- Additional validation rules may reject previously accepted events
- Error message format has changed

## Performance Considerations

### Optimization Features
- Efficient XDR parsing using Stellar SDK
- Minimal object creation overhead
- Early validation to fail fast
- Structured error logging with redaction

### Benchmarks
- Target: <5ms per event parsing
- Target: >1000 events/second throughput
- Memory usage: <1MB for 1000 concurrent events

## Future Enhancements

### Planned Features
- Event deduplication
- Batch processing support
- Event replay capabilities
- Enhanced monitoring and metrics

### Extensibility
- Plugin architecture for custom validators
- Configurable validation rules
- Custom error handlers
- Event transformation pipelines
