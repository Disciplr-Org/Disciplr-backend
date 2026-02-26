type StellarNetwork = 'testnet' | 'mainnet'

export type VaultContractEventType =
  | 'vault_created'
  | 'validation'
  | 'release'
  | 'redirect'

export interface VaultContractEvent {
  id: string
  contractId: string
  type: VaultContractEventType
  ledger: number | null
  txHash: string | null
  payload: Record<string, unknown>
  raw: Record<string, unknown>
  receivedAt: string
}

export interface HorizonListenerConfig {
  network: StellarNetwork
  horizonUrl: string
  contractIds: string[]
  eventTypes: VaultContractEventType[]
  pollIntervalMs: number
  cursor: string
}

export interface HorizonRawEvent {
  id?: string
  event_id?: string
  contract_id?: string
  contractId?: string
  topic?: unknown
  type?: string
  ledger?: number
  ledger_sequence?: number
  tx_hash?: string
  txHash?: string
  value?: unknown
  payload?: unknown
  [key: string]: unknown
}

export interface HorizonEventSource {
  pull(input: {
    horizonUrl: string
    cursor: string
    contractIds: string[]
    eventTypes: VaultContractEventType[]
  }): Promise<{ events: HorizonRawEvent[]; nextCursor: string }>
}

export interface VaultEventQueue {
  enqueue(event: VaultContractEvent): void | Promise<void>
}

type LoggerFn = (message?: unknown, ...optionalParams: unknown[]) => void

interface ListenerLogger {
  info: LoggerFn
  warn: LoggerFn
  error: LoggerFn
}

type EventHandler = (event: VaultContractEvent) => void | Promise<void>

const ALL_EVENT_TYPES: VaultContractEventType[] = [
  'vault_created',
  'validation',
  'release',
  'redirect',
]

const NETWORK_URLS: Record<StellarNetwork, string> = {
  testnet: 'https://horizon-testnet.stellar.org',
  mainnet: 'https://horizon.stellar.org',
}

const parseBool = (value: string | undefined): boolean => {
  if (!value) {
    return false
  }
  const normalized = value.trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes'
}

const parseCsv = (value: string | undefined): string[] => {
  if (!value) {
    return []
  }

  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

const EVENT_ALIASES: Record<string, VaultContractEventType> = {
  vault_created: 'vault_created',
  created: 'vault_created',
  validation: 'validation',
  validated: 'validation',
  vault_validated: 'validation',
  release: 'release',
  released: 'release',
  vault_released: 'release',
  redirect: 'redirect',
  redirected: 'redirect',
  vault_redirected: 'redirect',
}

const toEventType = (value: unknown): VaultContractEventType | null => {
  if (typeof value !== 'string') {
    return null
  }

  const normalized = value.trim().toLowerCase()
  return EVENT_ALIASES[normalized] ?? null
}

const parseEventTypes = (value: string | undefined): VaultContractEventType[] => {
  const requested = parseCsv(value)
  if (requested.length === 0) {
    return [...ALL_EVENT_TYPES]
  }

  const parsed = requested.map((item) => toEventType(item)).filter((item): item is VaultContractEventType => item !== null)
  if (parsed.length === 0) {
    return [...ALL_EVENT_TYPES]
  }

  return Array.from(new Set(parsed))
}

const parseNetwork = (value: string | undefined): StellarNetwork => {
  const normalized = (value ?? 'testnet').trim().toLowerCase()
  if (normalized === 'mainnet') {
    return 'mainnet'
  }
  return 'testnet'
}

const parsePollInterval = (value: string | undefined): number => {
  const defaultMs = 5000
  if (!value) {
    return defaultMs
  }

  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultMs
  }

  return Math.floor(parsed)
}

export const isHorizonListenerEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => {
  return parseBool(env.HORIZON_LISTENER_ENABLED)
}

export const loadHorizonListenerConfig = (
  env: NodeJS.ProcessEnv = process.env,
): HorizonListenerConfig => {
  const network = parseNetwork(env.STELLAR_NETWORK)
  const contractIds = parseCsv(env.STELLAR_VAULT_CONTRACT_IDS)
  const eventTypes = parseEventTypes(env.STELLAR_VAULT_EVENT_TYPES)

  return {
    network,
    horizonUrl: env.STELLAR_HORIZON_URL?.trim() || NETWORK_URLS[network],
    contractIds,
    eventTypes,
    pollIntervalMs: parsePollInterval(env.HORIZON_POLL_INTERVAL_MS),
    cursor: env.HORIZON_CURSOR?.trim() || 'now',
  }
}

export class InMemoryVaultEventQueue implements VaultEventQueue {
  private readonly queue: VaultContractEvent[] = []

  enqueue(event: VaultContractEvent): void {
    this.queue.push(event)
  }

  size(): number {
    return this.queue.length
  }

  snapshot(): VaultContractEvent[] {
    return [...this.queue]
  }
}

class HorizonHttpEventSource implements HorizonEventSource {
  async pull(input: {
    horizonUrl: string
    cursor: string
    contractIds: string[]
    eventTypes: VaultContractEventType[]
  }): Promise<{ events: HorizonRawEvent[]; nextCursor: string }> {
    const url = new URL('/events', input.horizonUrl)
    url.searchParams.set('cursor', input.cursor)
    url.searchParams.set('limit', '200')
    if (input.contractIds.length > 0) {
      url.searchParams.set('contract_ids', input.contractIds.join(','))
    }
    if (input.eventTypes.length > 0) {
      url.searchParams.set('topics', input.eventTypes.join(','))
    }

    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`Horizon request failed with status ${response.status}`)
    }

    const body = (await response.json()) as {
      _embedded?: { records?: HorizonRawEvent[] }
      records?: HorizonRawEvent[]
      cursor?: string
      paging_token?: string
    }

    const records = body._embedded?.records ?? body.records ?? []
    const nextCursor = body.cursor ?? body.paging_token ?? input.cursor

    return {
      events: records,
      nextCursor,
    }
  }
}

const normalizeRawPayload = (raw: HorizonRawEvent): Record<string, unknown> => {
  const payload = raw.payload ?? raw.value
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    return payload as Record<string, unknown>
  }
  return {
    value: payload,
  }
}

const deriveEventType = (raw: HorizonRawEvent): VaultContractEventType | null => {
  const fromType = toEventType(raw.type)
  if (fromType) {
    return fromType
  }

  if (Array.isArray(raw.topic)) {
    for (const entry of raw.topic) {
      const fromTopic = toEventType(entry)
      if (fromTopic) {
        return fromTopic
      }
    }
  }

  return null
}

const normalizeHorizonEvent = (raw: HorizonRawEvent): VaultContractEvent | null => {
  const eventType = deriveEventType(raw)
  if (!eventType) {
    return null
  }

  const id = String(raw.id ?? raw.event_id ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`)
  const contractId = String(raw.contract_id ?? raw.contractId ?? '')
  if (!contractId) {
    return null
  }

  return {
    id,
    contractId,
    type: eventType,
    ledger: typeof raw.ledger === 'number' ? raw.ledger : typeof raw.ledger_sequence === 'number' ? raw.ledger_sequence : null,
    txHash: typeof raw.tx_hash === 'string' ? raw.tx_hash : typeof raw.txHash === 'string' ? raw.txHash : null,
    payload: normalizeRawPayload(raw),
    raw,
    receivedAt: new Date().toISOString(),
  }
}

export class HorizonVaultEventListener {
  private readonly config: HorizonListenerConfig
  private readonly eventSource: HorizonEventSource
  private readonly queue: VaultEventQueue
  private readonly logger: ListenerLogger
  private readonly handlers: Map<VaultContractEventType, EventHandler[]> = new Map()
  private readonly anyHandlers: EventHandler[] = []

  private timer: NodeJS.Timeout | null = null
  private currentCursor: string
  private running = false
  private polling = false

  constructor(input: {
    config: HorizonListenerConfig
    queue: VaultEventQueue
    eventSource?: HorizonEventSource
    logger?: ListenerLogger
  }) {
    this.config = input.config
    this.queue = input.queue
    this.eventSource = input.eventSource ?? new HorizonHttpEventSource()
    this.logger = input.logger ?? console
    this.currentCursor = input.config.cursor
  }

  on(eventType: VaultContractEventType, handler: EventHandler): void {
    const eventHandlers = this.handlers.get(eventType) ?? []
    eventHandlers.push(handler)
    this.handlers.set(eventType, eventHandlers)
  }

  onAny(handler: EventHandler): void {
    this.anyHandlers.push(handler)
  }

  start(): void {
    if (this.running) {
      return
    }

    this.running = true
    this.logger.info(
      '[horizon-listener] starting',
      {
        network: this.config.network,
        horizonUrl: this.config.horizonUrl,
        contractIds: this.config.contractIds,
        eventTypes: this.config.eventTypes,
      },
    )

    void this.pollOnce()
    this.timer = setInterval(() => {
      void this.pollOnce()
    }, this.config.pollIntervalMs)
  }

  stop(): void {
    this.running = false
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.logger.info('[horizon-listener] stopped')
  }

  private async pollOnce(): Promise<void> {
    if (!this.running || this.polling) {
      return
    }

    if (this.config.contractIds.length === 0) {
      this.logger.warn('[horizon-listener] skipped poll: no contract IDs configured')
      return
    }

    this.polling = true
    try {
      const { events, nextCursor } = await this.eventSource.pull({
        horizonUrl: this.config.horizonUrl,
        cursor: this.currentCursor,
        contractIds: this.config.contractIds,
        eventTypes: this.config.eventTypes,
      })

      for (const rawEvent of events) {
        const event = normalizeHorizonEvent(rawEvent)
        if (!event) {
          continue
        }

        if (!this.config.eventTypes.includes(event.type)) {
          continue
        }

        await this.process(event)
      }

      this.currentCursor = nextCursor
    } catch (error) {
      this.logger.error('[horizon-listener] poll failed', error)
    } finally {
      this.polling = false
    }
  }

  private async process(event: VaultContractEvent): Promise<void> {
    this.logger.info('[horizon-listener] received', {
      id: event.id,
      contractId: event.contractId,
      type: event.type,
      ledger: event.ledger,
      txHash: event.txHash,
    })

    await this.queue.enqueue(event)

    const targetedHandlers = this.handlers.get(event.type) ?? []
    for (const handler of targetedHandlers) {
      await handler(event)
    }

    for (const handler of this.anyHandlers) {
      await handler(event)
    }
  }
}

export const createHorizonVaultEventListener = (input: {
  config: HorizonListenerConfig
  queue?: VaultEventQueue
  eventSource?: HorizonEventSource
  logger?: ListenerLogger
}): HorizonVaultEventListener => {
  return new HorizonVaultEventListener({
    config: input.config,
    queue: input.queue ?? new InMemoryVaultEventQueue(),
    eventSource: input.eventSource,
    logger: input.logger,
  })
}
