import { Router, Request, Response } from 'express'
import { queryParser } from '../middleware/queryParser.js'
import { applyFilters, applySort, paginateArray } from '../utils/pagination.js'

// --- NEW IMPORTS FOR ISSUE #1 ---
import { VaultService } from '../services/vault.service.js'
import { VaultStatus } from '../types/vault.js'

export const vaultsRouter = Router()

// ============================================================================
// DO NOT MODIFY OR DELETE: Required by privacy.ts and existing integrations
// ============================================================================
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

export let vaults: Array<Vault> = []

export const setVaults = (newVaults: Array<Vault>) => {
  vaults = newVaults
}
// ============================================================================

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

vaultsRouter.post('/', async (req: Request, res: Response) => {
  const {
    creator,
    amount,
    endTimestamp,
    successDestination,
    failureDestination,
    // Extract new DB-specific fields if provided, fallback to defaults to prevent breaking
    milestoneHash = 'pending_hash',
    verifierAddress = 'pending_verifier',
    contractId = null
  } = req.body as Record<string, string>

  if (!creator || !amount || !endTimestamp || !successDestination || !failureDestination) {
    res.status(400).json({
      error: 'Missing required fields: creator, amount, endTimestamp, successDestination, failureDestination',
    })
    return
  }

  const startTimestamp = new Date().toISOString()
  let dbVaultId: string | null = null;

  // 1. Persist to PostgreSQL (Issue #1 Requirement)
  try {
    const newDbVault = await VaultService.createVault({
      contractId,
      creatorAddress: creator,
      amount,
      milestoneHash,
      verifierAddress,
      successDestination,
      failureDestination,
      deadline: endTimestamp
    });
    dbVaultId = newDbVault.id;
  } catch (error) {
    console.error('Warning: Failed to save to PostgreSQL, falling back to in-memory only.', error);
  }

  // 2. Persist to In-Memory Array (To prevent breaking existing code)
  const id = dbVaultId || `vault-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
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

vaultsRouter.get('/:id', async (req: Request, res: Response) => {
  // 1. Try to fetch from PostgreSQL first
  try {
    const dbVault = await VaultService.getVaultById(req.params.id);
    if (dbVault) {
      res.json(dbVault);
      return;
    }
  } catch (error) {
    // Fails silently (e.g., if ID is not a valid UUID format), falls back to array
  }

  // 2. Fallback to existing in-memory logic
  const vault = vaults.find((v) => v.id === req.params.id)
  if (!vault) {
    res.status(404).json({ error: 'Vault not found' })
    return
  }
  res.json(vault)
})

// ============================================================================
// NEW ROUTES FOR ISSUE #1 (Database Persistence & Status Updates)
// ============================================================================

// GET /api/vaults/user/:address
vaultsRouter.get('/user/:address', async (req: Request, res: Response) => {
  try {
    const userVaults = await VaultService.getVaultsByUser(req.params.address);
    res.json(userVaults);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch user vaults from database' });
  }
});

// PATCH /api/vaults/:id/status
vaultsRouter.patch('/:id/status', async (req: Request, res: Response) => {
  const { status } = req.body;
  
  if (!Object.values(VaultStatus).includes(status as VaultStatus)) {
    res.status(400).json({ error: 'Invalid vault status' });
    return;
  }

  try {
    // 1. Update Database
    const updatedVault = await VaultService.updateVaultStatus(req.params.id, status as VaultStatus);
    
    if (!updatedVault) {
      res.status(404).json({ error: 'Vault not found in database' });
      return;
    }

    // 2. Keep the in-memory array synced so GET / and privacy routes don't show stale data
    const arrayIndex = vaults.findIndex(v => v.id === req.params.id);
    if (arrayIndex !== -1) {
      vaults[arrayIndex].status = status.toLowerCase() as any;
    }

    res.json(updatedVault);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update vault status' });
  }
});