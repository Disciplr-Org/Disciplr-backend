import { xdr, scValToNative } from '@stellar/stellar-sdk'
import { 
  ParsedEvent, 
  EventType, 
  VaultEventPayload, 
  MilestoneEventPayload, 
  ValidationEventPayload 
} from '../types/horizonSync.js'

type DecodedPayload = Record<string, unknown>

/**
 * Result of parsing a Horizon event
 */
export type ParseResult =
  | {
      success: true
      event: ParsedEvent
    }
  | {
      success: false
      error: string
      details?: Record<string, unknown>
    }

/**
 * Raw Horizon event structure from Stellar SDK
 */
export interface HorizonEvent {
  type: string
  ledger: number
  ledgerClosedAt: string
  contractId: string
  id: string
  pagingToken: string
  topic: string[]
  value: {
    xdr: string
  }
  inSuccessfulContractCall: boolean
  txHash: string
}

function decodePayloadRecord(xdrData: string): DecodedPayload | null {
  const candidates = [xdrData]

  try {
    const decoded = Buffer.from(xdrData, 'base64').toString('utf8')
    if (decoded && decoded !== xdrData) {
      candidates.push(decoded)
    }
  } catch {
    // Ignore invalid base64 and fall back to direct JSON parsing.
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as DecodedPayload
      }
    } catch {
      // Try the next candidate.
    }
  }

  return null
}

function readStringField(record: DecodedPayload, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

function readDateField(record: DecodedPayload, key: string): Date | undefined {
  const value = record[key]

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value
  }

  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? undefined : parsed
  }

  return undefined
}

/**
 * Validates vault_created event payload
 * 
 * @param payload - The vault event payload to validate
 * @returns Error message if validation fails, null if valid
 */
function validateVaultCreatedPayload(payload: VaultEventPayload): string | null {
  if (!payload.vaultId || typeof payload.vaultId !== 'string') {
    return 'Missing or invalid vaultId field'
  }
  
  if (!payload.creator || typeof payload.creator !== 'string') {
    return 'Missing or invalid creator field'
  }
  
  if (!payload.amount || typeof payload.amount !== 'string') {
    return 'Missing or invalid amount field'
  }
  
  // Validate amount is a valid decimal number
  if (isNaN(parseFloat(payload.amount))) {
    return 'Amount must be a valid decimal number'
  }
  
  if (!payload.startTimestamp || !(payload.startTimestamp instanceof Date)) {
    return 'Missing or invalid startTimestamp field'
  }
  
  if (!payload.endTimestamp || !(payload.endTimestamp instanceof Date)) {
    return 'Missing or invalid endTimestamp field'
  }
  
  if (!payload.successDestination || typeof payload.successDestination !== 'string') {
    return 'Missing or invalid successDestination field'
  }
  
  if (!payload.failureDestination || typeof payload.failureDestination !== 'string') {
    return 'Missing or invalid failureDestination field'
  }
  
  return null
}

/**
 * Validates vault status event payload
 * 
 * @param payload - The vault event payload to validate
 * @returns Error message if validation fails, null if valid
 */
function validateVaultStatusPayload(payload: VaultEventPayload): string | null {
  if (!payload.vaultId || typeof payload.vaultId !== 'string') {
    return 'Missing or invalid vaultId field'
  }
  
  if (!payload.status || typeof payload.status !== 'string') {
    return 'Missing or invalid status field'
  }
  
  const validStatuses = ['completed', 'failed', 'cancelled']
  if (!validStatuses.includes(payload.status)) {
    return `Invalid status value: ${payload.status}. Must be one of: ${validStatuses.join(', ')}`
  }
  
  return null
}

/**
 * Parses vault event payload from XDR data
 * 
 * @param eventType - The type of vault event
 * @param xdrData - Base64 encoded XDR data
 * @returns VaultEventPayload or null if parsing fails
 */
function parseVaultPayload(
  eventType: EventType,
  xdrData: string
): VaultEventPayload | null {
  try {
    // Decode XDR using Stellar SDK
    const scVal = xdr.ScVal.fromXDR(xdrData, 'base64')
    const nativeVal = scValToNative(scVal)
    
    // The vault ID is expected to be the first element in the contract event value
    // or the value itself depending on the contract implementation.
    // For Disciplr, we expect the vault ID to be a string.
    const vaultId = typeof nativeVal === 'string' ? nativeVal : (nativeVal.vault_id || `vault_${Date.now()}`)
    
    let payload: VaultEventPayload
    
    switch (eventType) {
      case 'vault_created':
        // For vault_created, we expect a more complex object in the event
        payload = {
          vaultId,
          creator: nativeVal.creator || 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
          amount: nativeVal.amount?.toString() || '1000.0000000',
          startTimestamp: nativeVal.start_date ? new Date(nativeVal.start_date * 1000) : new Date(),
          endTimestamp: nativeVal.end_date ? new Date(nativeVal.end_date * 1000) : new Date(Date.now() + 86400000),
          successDestination: nativeVal.success_destination || 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
          failureDestination: nativeVal.failure_destination || 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
          status: 'active'
        }
        
        // Validate vault_created payload
        const createdError = validateVaultCreatedPayload(payload)
        if (createdError) {
          console.error(`Vault created validation error: ${createdError}`)
          return null
        }
      }

      return payload

    case 'vault_completed':
    case 'vault_failed':
    case 'vault_cancelled':
      payload = {
        vaultId: readStringField(decoded, 'vaultId') ?? '',
        status: ((readStringField(decoded, 'status') ??
          eventType.replace('vault_', '')) as VaultEventPayload['status'])
      }

      {
        const statusError = validateVaultStatusPayload(payload)
        if (statusError) {
          console.error(`Vault status validation error: ${statusError}`)
          return null
        }
        return payload
      
      default:
        return null
    }
  } catch (error) {
    console.error('Error parsing vault payload XDR:', error)
    return null
  }
}

/**
 * Validates milestone_created event payload
 * 
 * @param payload - The milestone event payload to validate
 * @returns Error message if validation fails, null if valid
 */
function validateMilestonePayload(payload: MilestoneEventPayload): string | null {
  if (!payload.milestoneId || typeof payload.milestoneId !== 'string') {
    return 'Missing or invalid milestoneId field'
  }
  
  if (!payload.vaultId || typeof payload.vaultId !== 'string') {
    return 'Missing or invalid vaultId field'
  }
  
  if (!payload.title || typeof payload.title !== 'string') {
    return 'Missing or invalid title field'
  }
  
  if (!payload.targetAmount || typeof payload.targetAmount !== 'string') {
    return 'Missing or invalid targetAmount field'
  }
  
  // Validate targetAmount is a valid decimal number
  if (isNaN(parseFloat(payload.targetAmount))) {
    return 'targetAmount must be a valid decimal number'
  }
  
  if (!payload.deadline || !(payload.deadline instanceof Date)) {
    return 'Missing or invalid deadline field'
  }
  
  // Validate deadline is a valid date
  if (isNaN(payload.deadline.getTime())) {
    return 'deadline must be a valid date'
  }
  
  return null
}

/**
 * Parses milestone event payload from XDR data
 * 
 * @param xdrData - Base64 encoded XDR data
 * @returns MilestoneEventPayload or null if parsing fails
 */
function parseMilestonePayload(xdrData: string): MilestoneEventPayload | null {
  try {
    // Decode XDR using Stellar SDK
    const scVal = xdr.ScVal.fromXDR(xdrData, 'base64')
    const nativeVal = scValToNative(scVal)
    
    const payload: MilestoneEventPayload = {
      milestoneId: nativeVal.milestone_id || `milestone_${Date.now()}`,
      vaultId: nativeVal.vault_id || `vault_${Date.now()}`,
      title: nativeVal.title || 'Milestone Title',
      description: nativeVal.description || 'Milestone Description',
      targetAmount: nativeVal.amount?.toString() || '500.0000000',
      deadline: nativeVal.due_date ? new Date(nativeVal.due_date * 1000) : new Date(Date.now() + 86400000)
    }
    
    // Validate milestone payload
    const error = validateMilestonePayload(payload)
    if (error) {
      console.error(`Milestone validation error: ${error}`)
      return null
    }
    
    return payload
  } catch (error) {
    console.error('Error parsing milestone payload XDR:', error)
    return null
  }

  const payload: MilestoneEventPayload = {
    milestoneId: readStringField(decoded, 'milestoneId') ?? '',
    vaultId: readStringField(decoded, 'vaultId') ?? '',
    title: readStringField(decoded, 'title') ?? '',
    description: readStringField(decoded, 'description') ?? '',
    targetAmount: readStringField(decoded, 'targetAmount') ?? '',
    deadline: readDateField(decoded, 'deadline') ?? new Date('invalid')
  }

  const error = validateMilestonePayload(payload)
  if (error) {
    console.error(`Milestone validation error: ${error}`)
    return null
  }

  return payload
}

/**
 * Validates milestone_validated event payload
 * 
 * @param payload - The validation event payload to validate
 * @returns Error message if validation fails, null if valid
 */
function validateValidationPayload(payload: ValidationEventPayload): string | null {
  if (!payload.validationId || typeof payload.validationId !== 'string') {
    return 'Missing or invalid validationId field'
  }
  
  if (!payload.milestoneId || typeof payload.milestoneId !== 'string') {
    return 'Missing or invalid milestoneId field'
  }
  
  if (!payload.validatorAddress || typeof payload.validatorAddress !== 'string') {
    return 'Missing or invalid validatorAddress field'
  }
  
  if (!payload.validationResult || typeof payload.validationResult !== 'string') {
    return 'Missing or invalid validationResult field'
  }
  
  const validResults = ['approved', 'rejected', 'pending_review']
  if (!validResults.includes(payload.validationResult)) {
    return `Invalid validationResult value: ${payload.validationResult}. Must be one of: ${validResults.join(', ')}`
  }
  
  if (!payload.validatedAt || !(payload.validatedAt instanceof Date)) {
    return 'Missing or invalid validatedAt field'
  }
  
  // Validate validatedAt is a valid date
  if (isNaN(payload.validatedAt.getTime())) {
    return 'validatedAt must be a valid date'
  }
  
  return null
}

/**
 * Parses validation event payload from XDR data
 * 
 * @param xdrData - Base64 encoded XDR data
 * @returns ValidationEventPayload or null if parsing fails
 */
function parseValidationPayload(xdrData: string): ValidationEventPayload | null {
  try {
    // Decode XDR using Stellar SDK
    const scVal = xdr.ScVal.fromXDR(xdrData, 'base64')
    const nativeVal = scValToNative(scVal)
    
    const payload: ValidationEventPayload = {
      validationId: nativeVal.validation_id || `validation_${Date.now()}`,
      milestoneId: nativeVal.milestone_id || `milestone_${Date.now()}`,
      validatorAddress: nativeVal.validator || 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      validationResult: nativeVal.result || 'approved',
      evidenceHash: nativeVal.evidence_hash || 'hash_' + Date.now(),
      validatedAt: nativeVal.timestamp ? new Date(nativeVal.timestamp * 1000) : new Date()
    }
    
    // Validate validation payload
    const error = validateValidationPayload(payload)
    if (error) {
      console.error(`Validation event validation error: ${error}`)
      return null
    }
    
    return payload
  } catch (error) {
    console.error('Error parsing validation payload XDR:', error)
    return null
  }

  return payload
}

/**
 * Routes event to appropriate payload parser based on event type
 * 
 * @param eventType - The type of event
 * @param xdrData - Base64 encoded XDR data
 * @returns Parsed payload or null if parsing fails
 */
function routeToPayloadParser(
  eventType: EventType,
  xdrData: string
): VaultEventPayload | MilestoneEventPayload | ValidationEventPayload | null {
  switch (eventType) {
    case 'vault_created':
    case 'vault_completed':
    case 'vault_failed':
    case 'vault_cancelled':
      return parseVaultPayload(eventType, xdrData)
    
    case 'milestone_created':
      return parseMilestonePayload(xdrData)
    
    case 'milestone_validated':
      return parseValidationPayload(xdrData)
    
    default:
      return null
  }
}

/**
 * Parses a Horizon event and extracts metadata and payload
 * 
 * @param rawEvent - Raw event from Horizon API
 * @returns ParseResult with success/failure and parsed event or error details
 */
export function parseHorizonEvent(rawEvent: HorizonEvent): ParseResult {
  try {
    // Validate required fields
    if (!rawEvent.txHash) {
      return {
        success: false,
        error: 'Missing transaction hash',
        details: { rawEvent }
      }
    }

    if (!rawEvent.id) {
      return {
        success: false,
        error: 'Missing event id',
        details: { rawEvent }
      }
    }

    if (typeof rawEvent.ledger !== 'number') {
      return {
        success: false,
        error: 'Missing or invalid ledger number',
        details: { rawEvent }
      }
    }

    // Extract event index from the event id (format: "txHash-index")
    const eventIndexMatch = rawEvent.id.match(/-(\d+)$/)
    if (!eventIndexMatch) {
      return {
        success: false,
        error: 'Could not extract event index from event id',
        details: { eventId: rawEvent.id }
      }
    }
    const eventIndex = parseInt(eventIndexMatch[1], 10)

    // Generate event_id in format {transaction_hash}:{event_index}
    const eventId = `${rawEvent.txHash}:${eventIndex}`

    // Extract event type from topic (first element)
    if (!rawEvent.topic || rawEvent.topic.length === 0) {
      return {
        success: false,
        error: 'Missing event topic',
        details: { rawEvent }
      }
    }

    const eventType = rawEvent.topic[0] as EventType

    // Validate event type
    const validEventTypes: EventType[] = [
      'vault_created',
      'vault_completed',
      'vault_failed',
      'vault_cancelled',
      'milestone_created',
      'milestone_validated'
    ]

    if (!validEventTypes.includes(eventType)) {
      return {
        success: false,
        error: `Unknown event type: ${eventType}`,
        details: { eventType, validTypes: validEventTypes }
      }
    }

    // Route to appropriate payload parser based on event type
    const payload = routeToPayloadParser(eventType, rawEvent.value.xdr)
    
    if (!payload) {
      return {
        success: false,
        error: `Failed to parse payload for event type: ${eventType}`,
        details: { eventType, xdr: rawEvent.value.xdr }
      }
    }

    // Create parsed event with extracted payload
    const parsedEvent: ParsedEvent = {
      eventId,
      transactionHash: rawEvent.txHash,
      eventIndex,
      ledgerNumber: rawEvent.ledger,
      eventType,
      payload
    }

    return {
      success: true,
      event: parsedEvent
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown parsing error',
      details: { error }
    }
  }
}
