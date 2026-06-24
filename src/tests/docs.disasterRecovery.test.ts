import { readFileSync } from 'fs';
import path from 'path';

describe('Disaster recovery runbook documentation', () => {
  const runbookPath = path.join(__dirname, '../../docs/runbooks/disaster-recovery.md');
  const runbook = readFileSync(runbookPath, 'utf8');

  it('documents concrete RPO and RTO targets', () => {
    expect(runbook).toContain('RPO target');
    expect(runbook).toContain('RTO target');
    expect(runbook).toContain('5 minutes');
    expect(runbook).toContain('4 hours');
    expect(runbook).toContain('6 hours');
  });

  it('references the real migration tooling and migration ledger', () => {
    expect(runbook).toContain('db/migrations');
    expect(runbook).toContain('knex_migrations');
    expect(runbook).toContain('npm run migrate:status');
    expect(runbook).toContain('npm run migrate:latest');
  });

  it('keeps Horizon recovery tied to actual checkpoint and event tables', () => {
    expect(runbook).toContain('horizon_checkpoints');
    expect(runbook).toContain('processed_events');
    expect(runbook).toContain('failed_events');
    expect(runbook).toContain('GET /api/admin/horizon/checkpoints');
    expect(runbook).toContain('POST /api/admin/horizon/checkpoints');
    expect(runbook).toContain('DELETE /api/admin/horizon/checkpoints/:contractAddress');
  });

  it('covers object-reference recovery without raw PII storage', () => {
    expect(runbook).toContain('evidence_references');
    expect(runbook).toContain('export_jobs');
    expect(runbook).toContain('storage_key');
    expect(runbook).toContain('s3_key');
    expect(runbook).toContain('without storing raw PII');
  });

  it('includes a quarterly restore drill checklist', () => {
    expect(runbook).toContain('Quarterly Restore Drill Checklist');
    expect(runbook).toContain('Restore the latest nightly PostgreSQL snapshot');
    expect(runbook).toContain('Document measured RPO/RTO');
  });
});

