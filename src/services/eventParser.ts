import { 
  ParsedEvent, 
  EventType, 
  VaultEventPayload, 
  MilestoneEventPayload, 
  ValidationEventPayload 
} from '../types/horizonSync.js'

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
    // TODO: Implement full XDR decoding using Stellar SDK
    // For now, return a minimal payload structure based on event type
    
    // Extract vault ID from XDR (placeholder implementation)
    const vaultId = `vault_${Date.now()}`
    
    let payload: VaultEventPayload
    
    switch (eventType) {
      case 'vault_created':
        payload = {
          vaultId,
          creator: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
          amount: '1000.0000000',
          startTimestamp: new Date(),
          endTimestamp: new Date(Date.now() + 86400000), // +1 day
          successDestination: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
          failureDestination: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
          status: 'active'
        }
        
        // Validate vault_created payload
        const createdError = validateVaultCreatedPayload(payload)
        if (createdError) {
          console.error(`Vault created validation error: ${createdError}`)
          return null
        }
        return payload
      
      case 'vault_completed':
      case 'vault_failed':
      case 'vault_cancelled':
        payload = {
          vaultId,
          status: eventType.replace('vault_', '') as 'completed' | 'failed' | 'cancelled'
        }
        
        // Validate vault status payload
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
    // TODO: Implement full XDR decoding using Stellar SDK
    // For now, return a minimal payload structure
    
    const payload: MilestoneEventPayload = {
      milestoneId: `milestone_${Date.now()}`,
      vaultId: `vault_${Date.now()}`,
      title: 'Milestone Title',
      description: 'Milestone Description',
      targetAmount: '500.0000000',
      deadline: new Date(Date.now() + 86400000) // +1 day
    }
    
    // Validate milestone payload
    const error = validateMilestonePayload(payload)
    if (error) {
      console.error(`Milestone validation error: ${error}`)
      return null
    }
    
    return payload
  } catch (error) {
    return null
  }
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
    // TODO: Implement full XDR decoding using Stellar SDK
    // For now, return a minimal payload structure
    
    const payload: ValidationEventPayload = {
      validationId: `validation_${Date.now()}`,
      milestoneId: `milestone_${Date.now()}`,
      validatorAddress: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      validationResult: 'approved',
      evidenceHash: 'hash_' + Date.now(),
      validatedAt: new Date()
    }
    
    // Validate validation payload
    const error = validateValidationPayload(payload)
    if (error) {
      console.error(`Validation event validation error: ${error}`)
      return null
    }
    
    return payload
  } catch (error) {
    return null
  }
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
