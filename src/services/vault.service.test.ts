import { beforeEach, expect, it, jest } from '@jest/globals'

const mockQuery = jest.fn<(query: string, values: string[]) => Promise<{ rows: unknown[] }>>()
const mockGetPgPool = jest.fn<() => { query: typeof mockQuery } | null>()
const mockListVaults = jest.fn<
  () => Promise<Array<{ id: string; creator: string }>>
>()

jest.unstable_mockModule('../db/index.js', () => ({
  pool: {},
  db: {},
}))

jest.unstable_mockModule('../db/pool.js', () => ({
  getPgPool: mockGetPgPool,
}))

jest.unstable_mockModule('./vaultStore.js', () => ({
  listVaults: mockListVaults,
}))

const { VaultService } = await import('./vault.service.js')

beforeEach(() => {
  jest.clearAllMocks()
})

it('uses the in-memory vault list when PostgreSQL is not configured', async () => {
  mockGetPgPool.mockReturnValue(null)
  mockListVaults.mockResolvedValue([
    { id: 'matching', creator: 'creator-1' },
    { id: 'other', creator: 'creator-2' },
  ])

  await expect(VaultService.getVaultsByUser('creator-1')).resolves.toEqual([
    { id: 'matching', creator: 'creator-1' },
  ])
  expect(mockQuery).not.toHaveBeenCalled()
})

it('logs and rethrows PostgreSQL errors instead of falling back to memory', async () => {
  const databaseError = new Error('database unavailable')
  const pgPool = { query: mockQuery }
  mockGetPgPool.mockReturnValue(pgPool)
  mockQuery.mockRejectedValue(databaseError)
  const logError = jest.spyOn(console, 'error').mockImplementation(() => {})

  try {
    await expect(VaultService.getVaultsByUser('creator-1')).rejects.toBe(databaseError)
    expect(mockListVaults).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalledWith(
      'Failed to fetch user vaults from PostgreSQL',
      { creator: 'creator-1', error: 'database unavailable' },
    )
  } finally {
    logError.mockRestore()
  }
})
