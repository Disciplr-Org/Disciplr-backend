/**
 * Issue #754 — audit + add missing composite indexes for hot org-scoped
 * list endpoints (org vaults, transactions, notifications, audit logs).
 * 
 * This migration covers the query shapes that were verifiable against the
 * repository/service source in this pass.
 * 
 * ---------------------------------------------------------------------
 * audit_logs  (src/lib/auditLogs.ts)
 * ---------------------------------------------------------------------
 *   listAuditLogs()                    WHERE organization_id = ?  ORDER BY created_at DESC
 *   lookupPreviousAuditLogHash()        WHERE organization_id = ?  ORDER BY created_at DESC, id DESC  LIMIT 1
 *   verifyAuditLogChain()               WHERE organization_id = ?  ORDER BY created_at ASC,  id ASC
 *   exportAuditLogsForOrganization()    WHERE organization_id = ?  ORDER BY created_at ASC,  id ASC
 * 
 *   -> composite (organization_id, created_at, id) covers all four access
 *      patterns; Postgres can scan a btree in either direction, so ASC and
 *      DESC orderings both benefit. organization_id may be NULL for system
 *      actions — Postgres indexes NULLs, so the whereNull() branches used
 *      by lookupPreviousAuditLogHash/verifyAuditLogChain also hit the index.
 * 
 * ---------------------------------------------------------------------
 * webhook_subscribers  (src/repositories/webhookSubscriberRepository.ts)
 * ---------------------------------------------------------------------
 *   findByOrg()     WHERE organization_id = ? AND active = true  ORDER BY created_at ASC
 *   findByEvent()   same base filter + jsonb containment on events
 * 
 *   -> composite (organization_id, active, created_at). The jsonb
 *      containment check in findByEvent can't use a btree, but the leading
 *      columns still let Postgres narrow to the org's active subscribers
 *      before falling back to a filter on events.
 * 
 * ---------------------------------------------------------------------
 * vaults  (src/services/vaultStore.ts)
 * ---------------------------------------------------------------------
 *   listOrgVaults()  WHERE organization_id = ? AND deleted_at IS NULL
 *                    ORDER BY created_at DESC, id DESC  (cursor pagination)
 * 
 *   -> composite (organization_id, deleted_at, created_at DESC, id DESC).
 *      The deleted_at IS NULL filter can be satisfied by an index that
 *      includes deleted_at. DESC ordering on created_at/id matches the
 *      ORDER BY clause for optimal keyset pagination.
 * 
 * ---------------------------------------------------------------------
 * notifications  (src/services/notification.ts)
 * ---------------------------------------------------------------------
 *   listUserNotifications()  WHERE user_id = ? [archived_at/read_at filters]
 *                            ORDER BY created_at DESC, id DESC  (cursor pagination)
 * 
 *   -> composite (user_id, created_at, id). NOTE: as implemented today this
 *      table is scoped by user_id, not organization_id — flagged in
 *      docs/performance-testing.md since the issue lists notifications as
 *      "org-scoped".
 * 
 * ---------------------------------------------------------------------
 * transactions  (NOTE: deferred — see docs/performance-testing.md)
 * ---------------------------------------------------------------------
 *   The transactions table currently lacks an organization_id column and
 *   appears to be scoped by user_id and vault_id only. If future work
 *   adds org-scoped transaction queries, an index on
 *   (organization_id, created_at DESC, id DESC) would be needed.
 */

exports.up = async function up(knex) {
  // audit_logs: composite index for org-scoped queries with both ASC and DESC ordering
  await knex.raw(
    'CREATE INDEX IF NOT EXISTS idx_audit_logs_org_created_id ON audit_logs (organization_id, created_at, id)',
  )

  // webhook_subscribers: composite index for active org subscribers, sorted by created_at
  await knex.raw(
    'CREATE INDEX IF NOT EXISTS idx_webhook_subscribers_org_active_created ON webhook_subscribers (organization_id, active, created_at)',
  )

  // vaults: composite DESC index for org-scoped vault listing with cursor pagination
  await knex.raw(
    'CREATE INDEX IF NOT EXISTS idx_vaults_org_deleted_created_id_desc ON vaults (organization_id, deleted_at, created_at DESC, id DESC)',
  )

  // notifications: composite index for user-scoped notification listing
  // Note: This table is currently user-scoped, not org-scoped
  await knex.raw(
    'CREATE INDEX IF NOT EXISTS idx_notifications_user_created_id ON notifications (user_id, created_at, id)',
  )
}

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_audit_logs_org_created_id')
  await knex.raw('DROP INDEX IF EXISTS idx_webhook_subscribers_org_active_created')
  await knex.raw('DROP INDEX IF EXISTS idx_vaults_org_deleted_created_id_desc')
  await knex.raw('DROP INDEX IF EXISTS idx_notifications_user_created_id')
}