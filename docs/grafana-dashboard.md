# Grafana Dashboard Configuration

This document provides the configuration for monitoring Disciplr backend metrics in Grafana.

## Prometheus Configuration

Add this to your `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: 'disciplr-backend'
    static_configs:
      - targets: ['localhost:3000']  # Adjust to your backend URL
    metrics_path: '/metrics'
    scrape_interval: 15s
```

## Grafana Dashboard JSON

```json
{
  "dashboard": {
    "id": null,
    "title": "Disciplr Backend Monitoring",
    "tags": ["disciplr", "backend"],
    "timezone": "browser",
    "panels": [
      {
        "id": 1,
        "title": "API Request Rate",
        "type": "stat",
        "targets": [
          {
            "expr": "rate(disciplr_http_requests_total[5m])",
            "legendFormat": "{{method}} {{route}}"
          }
        ],
        "fieldConfig": {
          "defaults": {
            "unit": "reqps"
          }
        },
        "gridPos": {
          "h": 8,
          "w": 12,
          "x": 0,
          "y": 0
        }
      },
      {
        "id": 2,
        "title": "API Response Time",
        "type": "graph",
        "targets": [
          {
            "expr": "histogram_quantile(0.95, rate(disciplr_http_request_duration_seconds_bucket[5m]))",
            "legendFormat": "95th percentile"
          },
          {
            "expr": "histogram_quantile(0.50, rate(disciplr_http_request_duration_seconds_bucket[5m]))",
            "legendFormat": "50th percentile"
          }
        ],
        "fieldConfig": {
          "defaults": {
            "unit": "s"
          }
        },
        "gridPos": {
          "h": 8,
          "w": 12,
          "x": 12,
          "y": 0
        }
      },
      {
        "id": 3,
        "title": "Error Rate",
        "type": "graph",
        "targets": [
          {
            "expr": "rate(disciplr_http_errors_total[5m]) / rate(disciplr_http_requests_total[5m]) * 100",
            "legendFormat": "Error Rate %"
          }
        ],
        "fieldConfig": {
          "defaults": {
            "unit": "percent"
          }
        },
        "gridPos": {
          "h": 8,
          "w": 12,
          "x": 0,
          "y": 8
        }
      },
      {
        "id": 4,
        "title": "Active Vaults",
        "type": "stat",
        "targets": [
          {
            "expr": "disciplr_active_vaults_total",
            "legendFormat": "Active Vaults"
          }
        ],
        "fieldConfig": {
          "defaults": {
            "unit": "short"
          }
        },
        "gridPos": {
          "h": 4,
          "w": 6,
          "x": 12,
          "y": 8
        }
      },
      {
        "id": 5,
        "title": "Vault Operations",
        "type": "graph",
        "targets": [
          {
            "expr": "rate(disciplr_vault_operations_total[5m])",
            "legendFormat": "{{operation}} {{status}}"
          }
        ],
        "fieldConfig": {
          "defaults": {
            "unit": "ops"
          }
        },
        "gridPos": {
          "h": 8,
          "w": 12,
          "x": 0,
          "y": 16
        }
      },
      {
        "id": 6,
        "title": "Rate Limit Breaches",
        "type": "graph",
        "targets": [
          {
            "expr": "rate(disciplr_rate_limit_breaches_total[5m])",
            "legendFormat": "{{route}} {{client_type}}"
          }
        ],
        "fieldConfig": {
          "defaults": {
            "unit": "reqps"
          }
        },
        "gridPos": {
          "h": 8,
          "w": 12,
          "x": 12,
          "y": 16
        }
      },
      {
        "id": 7,
        "title": "Memory Usage",
        "type": "graph",
        "targets": [
          {
            "expr": "disciplr_process_resident_memory_bytes / 1024 / 1024",
            "legendFormat": "Memory (MB)"
          }
        ],
        "fieldConfig": {
          "defaults": {
            "unit": "bytes"
          }
        },
        "gridPos": {
          "h": 8,
          "w": 12,
          "x": 0,
          "y": 24
        }
      },
      {
        "id": 8,
        "title": "CPU Usage",
        "type": "graph",
        "targets": [
          {
            "expr": "rate(disciplr_process_cpu_seconds_total[5m]) * 100",
            "legendFormat": "CPU %"
          }
        ],
        "fieldConfig": {
          "defaults": {
            "unit": "percent"
          }
        },
        "gridPos": {
          "h": 8,
          "w": 12,
          "x": 12,
          "y": 24
        }
      },
      {
        "id": 9,
        "title": "Database Connections",
        "type": "stat",
        "targets": [
          {
            "expr": "disciplr_database_connections_active",
            "legendFormat": "Active Connections"
          }
        ],
        "fieldConfig": {
          "defaults": {
            "unit": "short"
          }
        },
        "gridPos": {
          "h": 4,
          "w": 6,
          "x": 18,
          "y": 8
        }
      },
      {
        "id": 10,
        "title": "Deadline Processing Backlog",
        "type": "stat",
        "targets": [
          {
            "expr": "disciplr_deadline_processing_backlog",
            "legendFormat": "Backlog"
          }
        ],
        "fieldConfig": {
          "defaults": {
            "unit": "short"
          }
        },
        "gridPos": {
          "h": 4,
          "w": 6,
          "x": 18,
          "y": 12
        }
      }
    ],
    "time": {
      "from": "now-1h",
      "to": "now"
    },
    "refresh": "5s"
  }
}
```

## Available Metrics

### HTTP Metrics
- `disciplr_http_requests_total` - Total HTTP requests by method, route, status
- `disciplr_http_request_duration_seconds` - Request duration histogram
- `disciplr_http_errors_total` - HTTP error responses (4xx, 5xx)

### Application Metrics
- `disciplr_active_vaults_total` - Number of active vaults
- `disciplr_vault_operations_total` - Vault operations by type and status
- `disciplr_rate_limit_breaches_total` - Rate limit violations
- `disciplr_database_connections_active` - Active DB connections
- `disciplr_deadline_processing_backlog` - Vaults pending deadline processing

### Process Metrics (Default)
- `disciplr_process_cpu_seconds_total` - CPU usage
- `disciplr_process_resident_memory_bytes` - Memory usage
- `disciplr_process_start_time_seconds` - Process start time
- `disciplr_nodejs_heap_size_used_bytes` - Node.js heap usage

## Alerting Rules

Example Prometheus alerting rules:

```yaml
groups:
  - name: disciplr-alerts
    rules:
      - alert: HighErrorRate
        expr: rate(disciplr_http_errors_total[5m]) / rate(disciplr_http_requests_total[5m]) > 0.05
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "High error rate detected"
          description: "Error rate is {{ $value | humanizePercentage }}"

      - alert: HighResponseTime
        expr: histogram_quantile(0.95, rate(disciplr_http_request_duration_seconds_bucket[5m])) > 1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High response time detected"
          description: "95th percentile response time is {{ $value }}s"

      - alert: RateLimitBreaches
        expr: rate(disciplr_rate_limit_breaches_total[5m]) > 10
        for: 1m
        labels:
          severity: info
        annotations:
          summary: "Rate limit breaches detected"
          description: "Rate limit breaches: {{ $value }}/s"

      - alert: NoActiveVaults
        expr: disciplr_active_vaults_total == 0
        for: 10m
        labels:
          severity: info
        annotations:
          summary: "No active vaults"
          description: "No vaults are currently active"
```

## Setup Instructions

1. **Install Prometheus**: Follow official Prometheus installation guide
2. **Configure Prometheus**: Add the job configuration above to `prometheus.yml`
3. **Install Grafana**: Follow official Grafana installation guide
4. **Add Prometheus Data Source**: In Grafana, add Prometheus as a data source
5. **Import Dashboard**: Copy the JSON above and import it as a new dashboard
6. **Set up Alerts**: Configure alerting rules in Prometheus and notification channels in Grafana
