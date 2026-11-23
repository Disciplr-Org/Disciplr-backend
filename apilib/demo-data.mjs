import { randomUUID, randomBytes } from 'node:crypto'

const DAY = 86400000
const iso = (d) => new Date(d).toISOString()
const hex = (n) => randomBytes(n).toString('hex')

export function seed() {
  const now = Date.now()
  const mk = (id, name, creator, amount, status, startOff, endOff, ms) => ({
    id, name, creator, amount: String(amount), status,
    startDate: iso(now + startOff * DAY), endDate: iso(now + endOff * DAY),
    verifier: 'GDLYZ73G3GEF36HBLEBFXOXAP5IXJDRQCRG47JCKR4XAXNOFCU44NZT2',
    successDestination: creator, failureDestination: 'GCAJ2QOEXTR7AB5PJXSAO2HEISE2VEIUIX7CP3F3MOYVX7GMADB7KX22',
    createdAt: iso(now + startOff * DAY), updatedAt: iso(now + startOff * DAY),
    milestones: ms.map((m, i) => ({ id: `${id}-m${i + 1}`, title: m[0], amount: String(m[1]), dueDate: iso(now + m[2] * DAY), status: m[3] })),
  })
  const creator = 'GBVAQKGA5P4TIZSZJBS5AW3XNJOTYG6I3Y5CLIGCBBUZDHMVF7YE7XCQ'
  const vaults = [
    mk('vault-demo-001', 'Launch the MVP', creator, 2500, 'active', -20, 40, [['Ship MVP', 1000, 10, 'completed'], ['Reach 100 users', 1000, 25, 'pending'], ['Public launch', 500, 40, 'pending']]),
    mk('vault-demo-002', 'Finish the thesis', creator, 800, 'completed', -60, -5, [['Finish thesis draft', 400, -30, 'completed'], ['Submit thesis', 400, -5, 'completed']]),
    mk('vault-demo-003', 'Run 3x per week', creator, 1200, 'failed', -90, -10, [['Run 3x per week for 8 weeks', 1200, -10, 'failed']]),
  ]
  const activity = [
    { id: randomUUID(), type: 'create', vaultId: 'vault-demo-001', amount: '2500', status: 'confirmed', hash: hex(32), memo: 'Vault created', createdAt: vaults[0].createdAt },
    { id: randomUUID(), type: 'validate', vaultId: 'vault-demo-001', amount: '1000', status: 'confirmed', hash: hex(32), memo: 'Milestone validated: Ship MVP', createdAt: iso(now - 8 * DAY) },
    { id: randomUUID(), type: 'create', vaultId: 'vault-demo-002', amount: '800', status: 'confirmed', hash: hex(32), memo: 'Vault created', createdAt: vaults[1].createdAt },
    { id: randomUUID(), type: 'release', vaultId: 'vault-demo-002', amount: '800', status: 'confirmed', hash: hex(32), memo: 'Funds released to success destination', createdAt: iso(now - 5 * DAY) },
    { id: randomUUID(), type: 'create', vaultId: 'vault-demo-003', amount: '1200', status: 'confirmed', hash: hex(32), memo: 'Vault created', createdAt: vaults[2].createdAt },
    { id: randomUUID(), type: 'redirect', vaultId: 'vault-demo-003', amount: '1200', status: 'confirmed', hash: hex(32), memo: 'Funds redirected to failure destination', createdAt: iso(now - 10 * DAY) },
  ]
  return { vaults, activity }
}
