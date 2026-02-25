# disciplr-backend

API and milestone engine for [Disciplr](https://github.com/your-org/Disciplr): programmable time-locked capital vaults on Stellar.

## What it does

- **Health:** `GET /api/health` — service status and timestamp.
- **Vaults:**  
  - `GET /api/vaults` — list all vaults (in-memory placeholder).  
  - `POST /api/vaults` — create a vault (body: `creator`, `amount`, `endTimestamp`, `successDestination`, `failureDestination`).  
  - `GET /api/vaults/:id` — get a vault by id.

Data is stored in memory for now. Production would use PostgreSQL, a Horizon listener for on-chain events, and a proper milestone/verification engine.

## Tech stack

- **Node.js** + **TypeScript**
- **Express** for HTTP API
- **Helmet** and **CORS** for security and cross-origin

## Local setup

### Prerequisites

- Node.js 18+
- npm or yarn

### Install and run

```bash
# From repo root
cd disciplr-backend
npm install
npm run dev
```

API runs at **http://localhost:3000**. Frontend dev server can proxy `/api` to this port.

### Scripts

| Command        | Description                    |
|----------------|--------------------------------|
| `npm run dev`  | Run with tsx watch (hot reload)|
| `npm run build`| Compile TypeScript to `dist/`  |
| `npm run start`| Run compiled `dist/index.js`  |
| `npm run lint` | Run ESLint on `src`           |

## Abuse detection instrumentation

The backend now includes abuse-oriented security instrumentation middleware.

- `GET /api/health/security` returns a snapshot of:
  - failed login attempts seen by auth/login paths (`401` or `403`)
  - rate limit triggers (`429`)
  - suspicious pattern alerts by category
  - top active source IPs in current windows
- Structured JSON logs are emitted to stdout for:
  - `security.failed_login_attempt`
  - `security.rate_limit_triggered`
  - `security.suspicious_pattern`

### Thresholds (env-configurable)

| Env var | Default | Meaning |
|---------|---------|---------|
| `SECURITY_RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit lookback window |
| `SECURITY_RATE_LIMIT_MAX_REQUESTS` | `120` | Max requests per IP in rate-limit window |
| `SECURITY_SUSPICIOUS_WINDOW_MS` | `300000` | Lookback window for suspicious pattern checks |
| `SECURITY_SUSPICIOUS_404_THRESHOLD` | `20` | 404 count threshold for endpoint scan detection |
| `SECURITY_SUSPICIOUS_DISTINCT_PATH_THRESHOLD` | `12` | Distinct 404 path threshold for endpoint scan detection |
| `SECURITY_SUSPICIOUS_BAD_REQUEST_THRESHOLD` | `30` | 400 count threshold for repeated bad request detection |
| `SECURITY_SUSPICIOUS_HIGH_VOLUME_THRESHOLD` | `300` | Total request threshold for high-volume bursts |
| `SECURITY_FAILED_LOGIN_WINDOW_MS` | `900000` | Lookback window for failed login burst checks |
| `SECURITY_FAILED_LOGIN_BURST_THRESHOLD` | `5` | Failed login threshold per IP before alert |
| `SECURITY_ALERT_COOLDOWN_MS` | `300000` | Minimum time between repeated alerts per IP/pattern |

### Alert wiring guidance

No dedicated monitoring stack is wired in this repo yet. If your environment has one (Datadog, CloudWatch, Grafana Loki, ELK), create alerts on these log events:

- `security.rate_limit_triggered`: alert on sustained frequency or concentration from single IP.
- `security.suspicious_pattern` where `pattern` is:
  - `endpoint_scan`
  - `high_volume`
  - `repeated_bad_requests`
  - `failed_login_burst`

Recommended initial alert policy:

- Warning: any `security.suspicious_pattern` event.
- Critical: `security.rate_limit_triggered` over 20 times in 5 minutes from one IP.

### Example: create a vault

```bash
curl -X POST http://localhost:3000/api/vaults \
  -H "Content-Type: application/json" \
  -d '{
    "creator": "G...",
    "amount": "1000",
    "endTimestamp": "2025-12-31T23:59:59Z",
    "successDestination": "G...",
    "failureDestination": "G..."
  }'
```

## Project layout

```
disciplr-backend/
├── src/
│   ├── routes/
│   │   ├── health.ts
│   │   └── vaults.ts
│   └── index.ts
├── package.json
├── tsconfig.json
└── README.md
```

## Merging into a remote

This directory is a separate git repo. To push to your own remote:

```bash
cd disciplr-backend
git remote add origin <your-disciplr-backend-repo-url>
git push -u origin main
```

Replace `<your-disciplr-backend-repo-url>` with your actual repository URL.
