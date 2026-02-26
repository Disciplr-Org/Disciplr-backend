/**
 * Schema for a document-type milestone criterion reference.
 * Stores a URL pointing to an off-chain document and an optional
 * content hash for integrity verification.
 */
export interface MilestoneDocumentReference {
  id: string
  vaultId: string
  label: string
  url: string
  contentHash?: string   // hex-encoded hash (e.g. SHA-256)
  hashAlgorithm?: string // e.g. 'sha256'
  createdAt: string
  updatedAt: string
}

export interface CreateMilestoneDocumentInput {
  vaultId: string
  label: string
  url: string
  contentHash?: string
  hashAlgorithm?: string
}