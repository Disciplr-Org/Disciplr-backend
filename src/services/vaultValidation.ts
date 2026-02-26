import type { CreateVaultInput, MilestoneInput } from '../types/vaults.js'

const STELLAR_ADDRESS_REGEX = /^G[A-Z2-7]{55}$/

type ValidationResult = { valid: true } | { valid: false; errors: string[] }

const isPositiveNumber = (value: string): boolean => {
  const num = Number(value)
  return Number.isFinite(num) && num > 0
}

const isIsoDate = (value: string): boolean => !Number.isNaN(Date.parse(value))

const normalizeMilestone = (milestone: MilestoneInput): MilestoneInput => ({
  title: milestone.title.trim(),
  description: milestone.description?.trim(),
  dueDate: milestone.dueDate,
  amount: `${milestone.amount}`,
})

export const normalizeCreateVaultInput = (payload: unknown): CreateVaultInput => {
  const typed = payload as Record<string, unknown>

  return {
    amount: `${typed.amount ?? ''}`,
    startDate: `${typed.startDate ?? new Date().toISOString()}`,
    endDate: `${typed.endDate ?? ''}`,
    verifier: `${typed.verifier ?? ''}`,
    destinations: {
      success: `${(typed.destinations as { success?: unknown } | undefined)?.success ?? ''}`,
      failure: `${(typed.destinations as { failure?: unknown } | undefined)?.failure ?? ''}`,
    },
    milestones: Array.isArray(typed.milestones)
      ? typed.milestones.map((item) => {
          const milestone = item as Record<string, unknown>
          return normalizeMilestone({
            title: `${milestone.title ?? ''}`,
            description: milestone.description ? `${milestone.description}` : undefined,
            dueDate: `${milestone.dueDate ?? ''}`,
            amount: `${milestone.amount ?? ''}`,
          })
        })
      : [],
    creator: typed.creator ? `${typed.creator}` : undefined,
    onChain: {
      mode: typed.onChain && typeof typed.onChain === 'object' ? ((typed.onChain as { mode?: 'build' | 'submit' }).mode ?? 'build') : 'build',
      contractId: typed.onChain && typeof typed.onChain === 'object' ? ((typed.onChain as { contractId?: string }).contractId ?? undefined) : undefined,
      networkPassphrase:
        typed.onChain && typeof typed.onChain === 'object'
          ? ((typed.onChain as { networkPassphrase?: string }).networkPassphrase ?? undefined)
          : undefined,
      sourceAccount:
        typed.onChain && typeof typed.onChain === 'object' ? ((typed.onChain as { sourceAccount?: string }).sourceAccount ?? undefined) : undefined,
    },
  }
}

export const validateCreateVaultInput = (input: CreateVaultInput): ValidationResult => {
  const errors: string[] = []

  if (!isPositiveNumber(input.amount)) {
    errors.push('amount must be a positive number.')
  } else {
    const value = Number(input.amount)
    if (value < 1 || value > 1_000_000_000) {
      errors.push('amount must be between 1 and 1,000,000,000.')
    }
  }

  if (!isIsoDate(input.startDate)) {
    errors.push('startDate must be a valid ISO timestamp.')
  }

  if (!isIsoDate(input.endDate)) {
    errors.push('endDate must be a valid ISO timestamp.')
  }

  if (isIsoDate(input.startDate) && isIsoDate(input.endDate)) {
    if (new Date(input.endDate).getTime() <= new Date(input.startDate).getTime()) {
      errors.push('endDate must be greater than startDate.')
    }
  }

  if (!STELLAR_ADDRESS_REGEX.test(input.verifier)) {
    errors.push('verifier must be a valid Stellar public key.')
  }

  if (!STELLAR_ADDRESS_REGEX.test(input.destinations.success)) {
    errors.push('destinations.success must be a valid Stellar public key.')
  }

  if (!STELLAR_ADDRESS_REGEX.test(input.destinations.failure)) {
    errors.push('destinations.failure must be a valid Stellar public key.')
  }

  if (!Array.isArray(input.milestones) || input.milestones.length === 0) {
    errors.push('milestones must contain at least one item.')
  }

  input.milestones.forEach((milestone, index) => {
    if (!milestone.title.trim()) {
      errors.push(`milestones[${index}].title is required.`)
    }

    if (!isPositiveNumber(milestone.amount)) {
      errors.push(`milestones[${index}].amount must be a positive number.`)
    }

    if (!isIsoDate(milestone.dueDate)) {
      errors.push(`milestones[${index}].dueDate must be a valid ISO timestamp.`)
    }

    if (isIsoDate(milestone.dueDate) && isIsoDate(input.startDate)) {
      if (new Date(milestone.dueDate).getTime() < new Date(input.startDate).getTime()) {
        errors.push(`milestones[${index}].dueDate cannot be before startDate.`)
      }
    }
  })

  const milestoneTotal = input.milestones.reduce((acc, milestone) => acc + Number(milestone.amount), 0)
  if (isPositiveNumber(input.amount) && milestoneTotal > Number(input.amount)) {
    errors.push('Total milestone amount cannot exceed vault amount.')
  }

  if (errors.length > 0) {
    return { valid: false, errors }
  }

  return { valid: true }
}
