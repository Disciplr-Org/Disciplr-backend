import { Router } from 'express'
import { addToDLQ, discardDLQEntry, getDLQEntry, getDLQMetrics, listDLQEntries } from '../services/dlq.js'

export const dlqRouter = Router()

dlqRouter.get('/', (req, res) => {
  const jobType = req.query.jobType as string | undefined
  const status = req.query.status as 'pending' | 'reprocessing' | 'discarded' | undefined

  const entries = listDLQEntries({ jobType, status })
  res.json({ entries })
})

dlqRouter.get('/metrics', (_req, res) => {
  const metrics = getDLQMetrics()
  res.json(metrics)
})

dlqRouter.get('/:id', (req, res) => {
  const entry = getDLQEntry(req.params.id)
  if (!entry) {
    res.status(404).json({ error: 'Entry not found' })
    return
  }
  res.json({ entry })
})

dlqRouter.post('/:id/discard', (req, res) => {
  const entry = discardDLQEntry(req.params.id)
  if (!entry) {
    res.status(404).json({ error: 'Entry not found' })
    return
  }
  res.json({ entry })
})

dlqRouter.post('/test', (req, res) => {
  const { jobType, payload, errorMessage } = req.body

  if (!jobType || !payload || !errorMessage) {
    res.status(400).json({ error: 'Missing required fields: jobType, payload, errorMessage' })
    return
  }

  const error = new Error(errorMessage)
  const entry = addToDLQ(jobType, payload, error)

  res.status(201).json({ entry })
})
