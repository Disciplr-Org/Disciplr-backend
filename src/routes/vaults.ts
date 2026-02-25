import { Router } from 'express'

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

// In-memory placeholder; replace with DB (e.g. PostgreSQL) later
export let vaults: Array<Vault> = []

export const setVaults = (newVaults: Array<Vault>) => {
  vaults = newVaults
}

vaultsRouter.get('/', (_req, res) => {
  res.json({ vaults })
})

vaultsRouter.post('/', (req, res) => {
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

vaultsRouter.get('/:id', (req, res) => {
  const vault = vaults.find((v) => v.id === req.params.id)
  if (!vault) {
    res.status(404).json({ error: 'Vault not found' })
    return
  }
  res.json(vault)
})
