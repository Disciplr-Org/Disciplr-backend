// Simulate old vs new logic
function oldIsOrgMember(orgMembers, orgId, userId) {
  return orgMembers.some(m => m.orgId === orgId && m.userId === userId)
}

function oldLogic({jobOrgId, callerOrgId, jobUserId, callerUserId, orgMembers}) {
  return (jobOrgId === callerOrgId) || (jobUserId === callerUserId) || oldIsOrgMember(orgMembers, jobOrgId, callerUserId)
}

// New logic with DB mock
function mockResolveEffectiveOrgRole(memberships, userId, orgId) {
  const found = memberships.find(m => m.user_id === userId && m.organization_id === orgId)
  return found ? found.role : null
}

async function newLogic({jobOrgId, jobOrgIdReal, callerOrgId, jobUserId, callerUserId, memberships}) {
  const isSameOrgContext = jobOrgId === callerOrgId
  const isCreator = jobUserId === callerUserId
  let isOrgMemberViaDb = false
  try {
    const orgIdToCheck = jobOrgIdReal ?? jobOrgId
    const role = mockResolveEffectiveOrgRole(memberships, callerUserId, orgIdToCheck)
    isOrgMemberViaDb = role !== null
  } catch { isOrgMemberViaDb = false }
  return isSameOrgContext || isCreator || isOrgMemberViaDb
}

(async () => {
  const orgMembersInMemory = [] // always empty in prod
  const membershipsDb = [
    { user_id: 'user-b', organization_id: 'org-1', role: 'member' }, // user-b is member of org-1
  ]

  const job = { orgId: 'org-1', userId: 'user-a', id: 'job-1' }
  const caller = { userId: 'user-b', orgId: 'org-2' } // member of org-1 but current context org-2

  const oldResult = oldLogic({
    jobOrgId: job.orgId,
    callerOrgId: caller.orgId,
    jobUserId: job.userId,
    callerUserId: caller.userId,
    orgMembers: orgMembersInMemory
  })
  console.log('OLD LOGIC result (should be true but is false):', oldResult, '=> BUG reproduced:', !oldResult)

  const newResult = await newLogic({
    jobOrgId: job.orgId,
    jobOrgIdReal: job.orgId,
    callerOrgId: caller.orgId,
    jobUserId: job.userId,
    callerUserId: caller.userId,
    memberships: membershipsDb
  })
  console.log('NEW LOGIC result (should be true):', newResult, '=> FIX works:', newResult)

  // Cross-org attacker should still be denied
  const attacker = { userId: 'user-attacker', orgId: 'org-attacker' }
  const attackerOld = oldLogic({
    jobOrgId: job.orgId,
    callerOrgId: attacker.orgId,
    jobUserId: job.userId,
    callerUserId: attacker.userId,
    orgMembers: []
  })
  const attackerNew = await newLogic({
    jobOrgId: job.orgId,
    jobOrgIdReal: job.orgId,
    callerOrgId: attacker.orgId,
    jobUserId: job.userId,
    callerUserId: attacker.userId,
    memberships: membershipsDb
  })
  console.log('Attacker OLD (should be false):', attackerOld)
  console.log('Attacker NEW (should be false):', attackerNew)

  // Owner same org context
  const ownerSameOrg = { userId: 'user-a', orgId: 'org-1' }
  const ownerSameOrgNew = await newLogic({
    jobOrgId: job.orgId,
    jobOrgIdReal: job.orgId,
    callerOrgId: ownerSameOrg.orgId,
    jobUserId: job.userId,
    callerUserId: ownerSameOrg.userId,
    memberships: []
  })
  console.log('Owner same org NEW (should be true):', ownerSameOrgNew)
})();
