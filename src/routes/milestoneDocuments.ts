import { Router, Request, Response } from 'express'
import { randomUUID } from 'crypto'
import { validateMilestoneDocument } from '../services/milestoneDocumentValidator.js'
import type { MilestoneDocumentReference, CreateMilestoneDocumentInput } from '../types/milestoneDocument.js'

export const milestoneDocumentsRouter = Router()

// In-memory store — replace with DB query when PostgreSQL is wired up
let documents: MilestoneDocumentReference[] = []

export const setDocuments = (docs: MilestoneDocumentReference[]) => {
  documents = docs
}

/**
 * POST /api/milestone-documents
 * Create a new document reference for a vault milestone.
 */
milestoneDocumentsRouter.post('/', (req: Request, res: Response) => {
  const input = req.body as CreateMilestoneDocumentInput

  const validation = validateMilestoneDocument(input)
  if (!validation.valid) {
    return res.status(400).json({ errors: validation.errors })
  }

  const now = new Date().toISOString()
  const doc: MilestoneDocumentReference = {
    id: randomUUID(),
    vaultId: input.vaultId,
    label: input.label,
    url: input.url,
    contentHash: input.contentHash,
    hashAlgorithm: input.hashAlgorithm?.toLowerCase(),
    createdAt: now,
    updatedAt: now,
  }

  documents.push(doc)
  return res.status(201).json(doc)
})

/**
 * GET /api/milestone-documents?vaultId=<id>
 * List all document references for a vault.
 */
milestoneDocumentsRouter.get('/', (req: Request, res: Response) => {
  const { vaultId } = req.query

  if (!vaultId || typeof vaultId !== 'string') {
    return res.status(400).json({ error: 'vaultId query parameter is required' })
  }

  const results = documents.filter((d) => d.vaultId === vaultId)
  return res.json({ data: results, total: results.length })
})

/**
 * GET /api/milestone-documents/:id
 * Get a single document reference by ID.
 */
milestoneDocumentsRouter.get('/:id', (req: Request, res: Response) => {
  const doc = documents.find((d) => d.id === req.params.id)
  if (!doc) {
    return res.status(404).json({ error: 'Document reference not found' })
  }
  return res.json(doc)
})

/**
 * DELETE /api/milestone-documents/:id
 * Remove a document reference.
 */
milestoneDocumentsRouter.delete('/:id', (req: Request, res: Response) => {
  const idx = documents.findIndex((d) => d.id === req.params.id)
  if (idx === -1) {
    return res.status(404).json({ error: 'Document reference not found' })
  }
  documents.splice(idx, 1)
  return res.status(204).send()
})