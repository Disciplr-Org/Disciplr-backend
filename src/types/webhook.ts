import { z } from 'zod'

export const webhookCreateSchema = z.object({
  url: z.string().trim().min(1, 'url is required'),
  events: z.array(z.string().trim().min(1)).default([]),
  active: z.boolean().optional().default(true),
})

export const webhookRotateSchema = z.object({}).strict()

export type WebhookCreateInput = z.infer<typeof webhookCreateSchema>
export type WebhookRotateInput = z.infer<typeof webhookRotateSchema>
