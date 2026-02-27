import { processJobWithDLQ } from '../lib/job-processor.js'

// Example: Webhook handler with DLQ
const sendWebhook = async (payload: Record<string, unknown>) => {
  const response = await fetch(payload.url as string, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload.data),
  })

  if (!response.ok) {
    throw new Error(`Webhook failed: ${response.status}`)
  }

  return response.json()
}

// Process with automatic retry and DLQ
export const processWebhook = async (url: string, data: unknown) => {
  const result = await processJobWithDLQ(
    'webhook',
    { url, data },
    sendWebhook,
    { maxRetries: 3, retryDelayMs: 1000 },
  )

  if (!result.success) {
    console.log(`Webhook failed after retries, added to DLQ: ${result.dlqId}`)
  }

  return result
}
