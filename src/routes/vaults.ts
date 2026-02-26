import { Router, Request, Response } from 'express'
import { queryParser } from '../middleware/queryParser.js'
import { applyFilters, applySort, paginateArray } from '../utils/pagination.js'

export const vaultsRouter = Router()

// In-memory placeholder; replace with DB (e.g. PostgreSQL) later
export interface Vault {
  id: string
  creator: string
  amount: string
  startTimestamp: string
  endTimestamp: string
  successDestination: string
  failureDestination: string
  status: 'active' | 'completed' | 'failed' | 'cancelled'
  createdAt: string
}

export type VaultStatus = Vault['status']

// In-memory placeholder; replace with DB (e.g. PostgreSQL) later
export let vaults: Array<Vault> = []

export const setVaults = (newVaults: Array<Vault>) => {
  vaults = newVaults
}

const makeId = (prefix: string): string =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`

const getVaultById = (id: string): Vault | undefined => vaults.find((vault) => vault.id === id)

export const cancelVaultById = (id: string):
  | { vault: Vault; previousStatus: VaultStatus }
  | { error: 'not_found' | 'already_cancelled' | 'not_cancellable'; currentStatus?: VaultStatus } => {
  const vault = getVaultById(id)
  if (!vault) {
    return { error: 'not_found' }
  }

  if (vault.status === 'cancelled') {
    return { error: 'already_cancelled', currentStatus: vault.status }
  }

  if (vault.status !== 'active') {
    return { error: 'not_cancellable', currentStatus: vault.status }
  }

  const previousStatus = vault.status
  vault.status = 'cancelled'
  return { vault, previousStatus }
}

/**
 * @swagger
 * /api/vaults:
 *   get:
 *     summary: Get all vaults
 *     description: Retrieve a paginated list of vaults with optional filtering and sorting
 *     tags: [Vaults]
 *     security:
 *       - bearerAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *         description: Page number for pagination
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *         description: Number of items per page
 *       - in: query
 *         name: sort
 *         schema:
 *           type: string
 *           enum: [createdAt, amount, endTimestamp, status]
 *         description: Field to sort by
 *       - in: query
 *         name: order
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *           default: desc
 *         description: Sort order
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [active, completed, failed, cancelled]
 *         description: Filter by vault status
 *       - in: query
 *         name: creator
 *         schema:
 *           type: string
 *         description: Filter by creator
 *     responses:
 *       200:
 *         description: List of vaults retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PaginatedResponse'
 *       401:
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
vaultsRouter.get(
  '/',
  queryParser({
    allowedSortFields: ['createdAt', 'amount', 'endTimestamp', 'status'],
    allowedFilterFields: ['status', 'creator'],
  }),
  (req: Request, res: Response) => {
    let result = [...vaults]

    // Apply filters
    if (req.filters) {
      result = applyFilters(result, req.filters)
    }

    // Apply sorting
    if (req.sort) {
      result = applySort(result, req.sort)
    }

    // Apply pagination
    const paginatedResult = paginateArray(result, req.pagination!)

    res.json(paginatedResult)
  }
)

/**
 * @swagger
 * /api/vaults:
 *   post:
 *     summary: Create a new vault
 *     description: Create a new vault with specified parameters
 *     tags: [Vaults]
 *     security:
 *       - bearerAuth: []
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateVaultRequest'
 *     responses:
 *       201:
 *         description: Vault created successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Vault'
 *       400:
 *         description: Bad request - invalid input
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       401:
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
vaultsRouter.post('/', (req: Request, res: Response) => {
  const {
    creator,
    amount,
    endTimestamp,
    successDestination,
    failureDestination,
  } = req.body as Record<string, string>

  if (!creator || !amount || !endTimestamp || !successDestination || !failureDestination) {
    res.status(400).json({
      error: 'Missing required fields: creator, amount, endTimestamp, successDestination, failureDestination',
    })
    return
  }

  const id = `vault-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  const startTimestamp = new Date().toISOString()
  const vault = {
    id,
    creator,
    amount,
    startTimestamp,
    endTimestamp,
    successDestination,
    failureDestination,
    status: 'active' as const,
    createdAt: startTimestamp,
  }
  vaults.push(vault)
  res.status(201).json(vault)
})

/**
 * @swagger
 * /api/vaults/{id}:
 *   get:
 *     summary: Get a vault by ID
 *     description: Retrieve a specific vault by its unique identifier
 *     tags: [Vaults]
 *     security:
 *       - bearerAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Vault ID
 *         example: vault-1640592000000-abc1234
 *     responses:
 *       200:
 *         description: Vault retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Vault'
 *       404:
 *         description: Vault not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       401:
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
vaultsRouter.get('/:id', (req: Request, res: Response) => {
  const vault = vaults.find((v) => v.id === req.params.id)
  if (!vault) {
    res.status(404).json({ error: 'Vault not found' })
    return
  }
  res.json(vault)
})
