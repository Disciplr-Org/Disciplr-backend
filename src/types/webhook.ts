import { z } from 'zod'
import { KNOWN_EVENT_TYPES } from '../services/webhooks.js'

export const webhookCreateSchema = z.object({
  url: z.string().trim().min(1, 'url is required').url('url must be a valid URL'),
  events: z
    .array(
      z
        .string()
        .trim()
        .min(1)
        .superRefine((e, ctx) => {
          if (!KNOWN_EVENT_TYPES.has(e)) {
            ctx.addIssue({
              code: 'custom',
              message: `Unknown event type: "${e}". Known types: ${[...KNOWN_EVENT_TYPES].join(', ')}`,
            })
          }
        }),
    )
    .default([]),
  active: z.boolean().optional().default(true),
})

export const webhookRotateSchema = z.object({}).strict()

export type WebhookCreateInput = z.infer<typeof webhookCreateSchema>
export type WebhookRotateInput = z.infer<typeof webhookRotateSchema>