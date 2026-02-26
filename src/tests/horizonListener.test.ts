import {
  createHorizonVaultEventListener,
  InMemoryVaultEventQueue,
  loadHorizonListenerConfig,
} from '../services/horizon/listener.js'
import { jest } from '@jest/globals'

describe('loadHorizonListenerConfig', () => {
  it('uses testnet defaults when no env is provided', () => {
    const config = loadHorizonListenerConfig({})

    expect(config.network).toBe('testnet')
    expect(config.horizonUrl).toBe('https://horizon-testnet.stellar.org')
    expect(config.eventTypes).toEqual([
      'vault_created',
      'validation',
      'release',
      'redirect',
    ])
    expect(config.contractIds).toEqual([])
  })

  it('loads mainnet and custom event subscriptions from env', () => {
    const config = loadHorizonListenerConfig({
      STELLAR_NETWORK: 'mainnet',
      STELLAR_VAULT_CONTRACT_IDS: 'CVAULT001,CVAULT002',
      STELLAR_VAULT_EVENT_TYPES: 'vault_created,validation,release',
      HORIZON_POLL_INTERVAL_MS: '2500',
      HORIZON_CURSOR: '12345',
    })

    expect(config.network).toBe('mainnet')
    expect(config.horizonUrl).toBe('https://horizon.stellar.org')
    expect(config.contractIds).toEqual(['CVAULT001', 'CVAULT002'])
    expect(config.eventTypes).toEqual(['vault_created', 'validation', 'release'])
    expect(config.pollIntervalMs).toBe(2500)
    expect(config.cursor).toBe('12345')
  })
})

describe('HorizonVaultEventListener', () => {
  it('enqueues and dispatches subscribed vault events', async () => {
    const queue = new InMemoryVaultEventQueue()
    const handler = jest.fn(async () => undefined)

    const listener = createHorizonVaultEventListener({
      config: {
        network: 'testnet',
        horizonUrl: 'https://horizon-testnet.stellar.org',
        contractIds: ['CVAULT001'],
        eventTypes: ['vault_created', 'validation', 'release', 'redirect'],
        pollIntervalMs: 60_000,
        cursor: 'now',
      },
      queue,
      eventSource: {
        pull: async () => ({
          events: [
            {
              id: 'evt_1',
              contract_id: 'CVAULT001',
              type: 'vault_created',
              ledger: 123,
              tx_hash: 'abc123',
              payload: { vaultId: 'vault-1' },
            },
          ],
          nextCursor: 'evt_1',
        }),
      },
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    })

    listener.on('vault_created', handler)
    listener.start()

    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 25)
    })

    listener.stop()

    expect(queue.size()).toBe(1)
    expect(queue.snapshot()[0].type).toBe('vault_created')
    expect(handler).toHaveBeenCalledTimes(1)
  })
})
