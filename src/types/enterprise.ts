export interface Organization {
  id: string
  name: string
  slug: string
  metadata?: any
  created_at: string
  updated_at: string
}

export interface Team {
  id: string
  name: string
  slug: string
  organization_id: string
  metadata?: any
  created_at: string
  updated_at: string
}

export interface Membership {
  id: string
  user_id: string
  organization_id: string
  team_id: string | null
  role: string
  created_at: string
}

export interface CreateOrganizationInput {
  name: string
  slug: string
  metadata?: any
}

export interface CreateTeamInput {
  name: string
  slug: string
  organization_id: string
  metadata?: any
}

export interface CreateMembershipInput {
  user_id: string
  organization_id: string
  team_id?: string
  role?: string
}
