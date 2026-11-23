import express from 'express'
import request from 'supertest'
import { jest } from '@jest/globals'

let authenticatedUser: { userId: string; role: string } | null = { userId: 'user-1', role: 'USER' }

const sampleTx = {
  id: '00000000-0000-0000-0000-000000000001',
  vault_id: '00000000-0000-0000-0000-000000000002',
  user_id: 'user-1',
  type: 'creation',
  amount: '100.0000000',
  asset_code: 'XLM',
  tx_hash: '3389e9f0f73b404b45dc55b18382315cb49ac9f2d5feb686ed97f08917546761',
  from_account: 'GBBM6BKZPEHWYO3E3YKREDPQXMS4VK35YLNU7NFBRI26RAN7GI5POFBB',
  to_account: 'GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2GIOVPVUIV25DGDRTA5EB',
  memo: 'test memo',
  created_at: '2026-08-30T00:00:00.000Z',
  stellar_ledger: 1000,
  stellar_timestamp: '2026-08-30T00:00:00.000Z',
  explorer_url: 'https://stellar.expert/explorer/public/tx/3389e9f0',
}

let mockTransactions: any[] = [sampleTx]
let mockVaults: any[] = [
  {
    id: '00000000-0000-0000-0000-000000000002',
    creator: 'user-1',
  },
]

const mockQueryBuilder: any = {
  where: jest.fn().mockImplementation(function (this: any, arg1: any, arg2: any, arg3: any) {
    return this
  }),
  leftJoin: jest.fn().mockReturnThis(),
  orderBy: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  select: jest.fn().mockReturnThis(),
  first: jest.fn(),
  then: jest.fn((resolve: any) => resolve(mockTransactions)),
}

const mockDb: any = jest.fn((tableName: string) => {
  if (tableName === 'vaults') {
    return {
      leftJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockImplementation(function (this: any, clause: any) {
        if (typeof clause === 'function') {
          // simulate checking user access
          return this
        }
        return this
      }),
      select: jest.fn().mockReturnThis(),
      first: jest.fn(async () => {
        return mockVaults.find((v) => v.creator === authenticatedUser?.userId) ?? null
      }),
    }
  }

  return {
    where: jest.fn().mockImplementation(function (this: any, col: any, val: any) {
      if (col === 'id') {
        const found = mockTransactions.find(
          (t) => t.id === val && t.user_id === authenticatedUser?.userId,
        )
        return {
          where: jest.fn().mockReturnThis(),
          first: jest.fn(async () => found ?? null),
        }
      }
      return this
    }),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    then: jest.fn((resolve: any) =>
      resolve(
        mockTransactions.filter((t) => t.user_id === authenticatedUser?.userId),
      ),
    ),
  }
})

jest.unstable_mockModule('../db/index.js', () => ({
  default: mockDb,
}))

jest.unstable_mockModule('../middleware/auth.js', () => ({
  authenticate: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!authenticatedUser) {
      res.status(401).json({ error: 'Unauthorized: missing or invalid authentication token' })
      return
    }
    req.user = authenticatedUser as any
    next()
  },
}))

const { transactionsRouter } = await import('../routes/transactions.js')

const app = express()
app.use(express.json())
app.use('/api/transactions', transactionsRouter)

describe('Transactions Router — Authorization & Hostile-Input Boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    authenticatedUser = { userId: 'user-1', role: 'USER' }
    mockTransactions = [sampleTx]
    mockVaults = [
      {
        id: '00000000-0000-0000-0000-000000000002',
        creator: 'user-1',
      },
    ]
  })

  describe('Authentication & Disconnected Wallet Boundary', () => {
    it('rejects disconnected wallet / unauthenticated user with 401', async () => {
      authenticatedUser = null
      const res = await request(app).get('/api/transactions')
      expect(res.status).toBe(401)
      expect(res.body.error).toMatch(/Unauthorized/i)
    })

    it('rejects disconnected wallet on single transaction fetch with 401', async () => {
      authenticatedUser = null
      const res = await request(app).get('/api/transactions/00000000-0000-0000-0000-000000000001')
      expect(res.status).toBe(401)
    })

    it('rejects disconnected wallet on vault transactions fetch with 401', async () => {
      authenticatedUser = null
      const res = await request(app).get('/api/transactions/vault/00000000-0000-0000-0000-000000000002')
      expect(res.status).toBe(401)
    })
  })

  describe('Route Parameters Boundary', () => {
    it('rejects non-UUID transaction ID with 400 Bad Request', async () => {
      const res = await request(app).get('/api/transactions/not-a-valid-uuid')
      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/valid UUID/i)
    })

    it('rejects SQL injection in transaction ID with 400 Bad Request', async () => {
      const res = await request(app).get('/api/transactions/1;DROP TABLE transactions--')
      expect(res.status).toBe(400)
    })

    it('rejects non-UUID vaultId with 400 Bad Request', async () => {
      const res = await request(app).get('/api/transactions/vault/malformed-vault-id')
      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/valid UUID/i)
    })
  })

  describe('Network & Wallet Identity Headers Boundary', () => {
    it('rejects invalid network identifier with 400 (wrong-network)', async () => {
      const res = await request(app)
        .get('/api/transactions')
        .set('x-network-id', 'unsupported-network')

      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/wrong-network/i)
    })

    it('accepts valid network identifier headers', async () => {
      const res = await request(app)
        .get('/api/transactions')
        .set('x-network-id', 'testnet')

      expect(res.status).toBe(200)
    })

    it('rejects invalid wallet address format with 400', async () => {
      const res = await request(app)
        .get('/api/transactions')
        .set('x-wallet-address', 'invalid-wallet-address')

      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/wallet address format/i)
    })
  })

  describe('Filter & Cursor Boundary', () => {
    it('rejects invalid transaction type filter with 400', async () => {
      const res = await request(app).get('/api/transactions?type=hostile_type')
      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/Invalid transaction type filter/i)
    })

    it('rejects non-UUID vault_id filter with 400', async () => {
      const res = await request(app).get('/api/transactions?vault_id=not-a-uuid')
      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/vault_id filter must be a valid UUID/i)
    })

    it('rejects negative amount filter values with 400', async () => {
      const res = await request(app).get('/api/transactions?amount_min=-10')
      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/amount_min must be a non-negative/i)
    })

    it('rejects amount_min > amount_max with 400', async () => {
      const res = await request(app).get('/api/transactions?amount_min=500&amount_max=100')
      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/amount_min cannot exceed amount_max/i)
    })

    it('rejects invalid date_from filter with 400', async () => {
      const res = await request(app).get('/api/transactions?date_from=invalid-date')
      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/Invalid date_from filter/i)
    })

    it('rejects malformed cursor with 400 Bad Request', async () => {
      const res = await request(app).get('/api/transactions?cursor=malformed!cursor!')
      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/Invalid cursor/i)
    })
  })

  describe('Authorization & Cross-Tenant Isolation', () => {
    it('returns 404 when querying transaction belonging to another user', async () => {
      mockTransactions = [
        {
          ...sampleTx,
          user_id: 'other-user',
        },
      ]

      const res = await request(app).get('/api/transactions/00000000-0000-0000-0000-000000000001')
      expect(res.status).toBe(404)
      expect(res.body.error).toMatch(/Transaction not found/i)
    })

    it('returns 404 when querying vault transactions for unauthorized vault', async () => {
      mockVaults = [] // User has no ownership or membership in this vault

      const res = await request(app).get(
        '/api/transactions/vault/00000000-0000-0000-0000-000000000002',
      )
      expect(res.status).toBe(404)
      expect(res.body.error).toMatch(/Vault not found/i)
    })
  })

  describe('Successful Retrieval & Response Shape', () => {
    it('successfully returns list of transactions for authorized user', async () => {
      const res = await request(app).get('/api/transactions')
      expect(res.status).toBe(200)
      expect(res.body.data).toHaveLength(1)
      expect(res.body.pagination).toBeDefined()
      expect(res.body.data[0].id).toBe(sampleTx.id)
    })

    it('successfully returns specific transaction by ID', async () => {
      const res = await request(app).get('/api/transactions/00000000-0000-0000-0000-000000000001')
      expect(res.status).toBe(200)
      expect(res.body.id).toBe(sampleTx.id)
      expect(res.body.amount).toBe(sampleTx.amount)
    })
  })
})
