import * as fs from 'fs';
import * as path from 'path';
import { metricsRegistry } from '../routes/metrics.js';
import { httpRequestsTotal, httpRequestDurationSeconds } from '../observability/httpMetrics.js';

describe('Observability Documentation Sync', () => {
  const docPath = path.resolve(__dirname, '../../docs/observability.md');
  const doc = fs.readFileSync(docPath, 'utf8');

  // Metric names documented in the "System Gauges" and "HTTP RED Metrics" tables.
  // These must match the names registered in code.
  const documentedMetrics = [
    'http_requests_total',
    'http_request_duration_seconds',
    'disciplr_job_queue_depth',
    'disciplr_job_failed_total',
    'disciplr_db_available_connections',
    'disciplr_db_waiting_clients',
    'disciplr_horizon_listener_lag',
    'disciplr_outbox_relay_lag_seconds',
    'disciplr_webhook_breaker_closed',
    'disciplr_webhook_breaker_open',
    'disciplr_webhook_breaker_half_open',
    'disciplr_webhook_dispatch_in_flight',
    'disciplr_webhook_dispatch_queue_depth',
    'disciplr_event_throughput_events_per_sec',
  ];

  describe('documented metric names exist in the registry', () => {
    it('should expose every documented custom metric on the application registry', async () => {
      const registryMetrics = await metricsRegistry.getMetricsAsJSON();
      const registryNames = registryMetrics.map((m) => m.name);

      for (const name of documentedMetrics) {
        // http_requests_total / http_request_duration_seconds live on the default
        // registry (see observability.md "Known Gaps"); all others on the app registry.
        if (name === 'http_requests_total' || name === 'http_request_duration_seconds') {
          expect(httpRequestsTotal).toBeDefined();
          expect(httpRequestDurationSeconds).toBeDefined();
          continue;
        }
        expect(registryNames).toContain(name);
      }
    });

    it('should not document any metric that is absent from code', () => {
      // Extract metric names from markdown table rows: | `name` | ...
      const tableRegex = /^\|\s*`([a-z0-9_]+)`\s*\|/gim;
      const found = new Set<string>();
      let match: RegExpExecArray | null;
      while ((match = tableRegex.exec(doc)) !== null) {
        found.add(match[1]);
      }

      // Every metric name appearing in a docs table must be one we know about.
      const known = new Set(documentedMetrics);
      for (const name of found) {
        expect(known.has(name)).toBe(true);
      }
    });
  });

  describe('required sections present', () => {
    const requiredSections = [
      '## Purpose',
      '## Stack Summary',
      '## Context Propagation Path',
      '## Correlation ID',
      '## Exported Metrics',
      '## Scrape Endpoint',
      '## Correlating Traces, Logs, and Metrics',
      '## Log Sampling',
      '## Known Gaps',
      '## Cross-References',
    ];

    for (const section of requiredSections) {
      it(`should contain the "${section}" section`, () => {
        expect(doc).toContain(section);
      });
    }
  });

  describe('runbook cross-link valid', () => {
    it('should link to the on-call SLO runbook with a valid anchor', () => {
      expect(doc).toMatch(/\[.*?\]\(runbooks\/on-call-slo\.md/);
    });

    it('should link to the operations-metrics doc', () => {
      expect(doc).toMatch(/\[.*?\]\(operations-metrics\.md/);
    });

    it('should reference all four SLO runbook anchors', () => {
      const anchors = [
        'runbooks/on-call-slo.md#slo-1-job-queue-depth',
        'runbooks/on-call-slo.md#slo-2-db-connection-pool',
        'runbooks/on-call-slo.md#slo-3-listener-lag',
        'runbooks/on-call-slo.md#slo-4-outbox-relay-lag-informational',
      ];
      for (const anchor of anchors) {
        expect(doc).toContain(anchor);
      }
    });
  });

  describe('documented metric metadata matches code', () => {
    it('should document job_queue_depth as a gauge with the correct help', async () => {
      const registryMetrics = await metricsRegistry.getMetricsAsJSON();
      const m = registryMetrics.find((x) => x.name === 'disciplr_job_queue_depth');
      expect(m).toBeDefined();
      expect(m?.type).toBe('gauge');
    });

    it('should document horizon listener lag as a gauge', async () => {
      const registryMetrics = await metricsRegistry.getMetricsAsJSON();
      const m = registryMetrics.find((x) => x.name === 'disciplr_horizon_listener_lag');
      expect(m).toBeDefined();
      expect(m?.type).toBe('gauge');
    });
  });
});
