import { z } from 'zod'
import { KNOWN_EVENT_TYPES } from '../services/webhooks.js'

export const webhookCreateSchema = z
  .object({
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
  .superRefine((data, ctx) => {
    if (data.active && data.events.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['events'],
        message:
          'An active webhook subscriber must include at least one event type. Either provide events or set active to false.',
      })
    }
  })

// Explicitly accept either no body (`undefined`) or an empty object.
// This documents "no body expected" while still rejecting any extra properties.
export const webhookRotateSchema = z.union([
  z.undefined(),
  z
    .object({})
    .strict()
    .refine((obj) => Object.keys(obj).length === 0, { message: 'Request body must be empty' }),
])

export type WebhookCreateInput = z.infer<typeof webhookCreateSchema>
export type WebhookRotateInput = z.infer<typeof webhookRotateSchema>