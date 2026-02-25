# disciplr-backend

API and milestone engine for [Disciplr](https://github.com/your-org/Disciplr): programmable time-locked capital vaults on Stellar.

## What it does

- **Health:** `GET /api/health` — service status and timestamp.
- **Vaults:**  
  - `GET /api/vaults` — list all vaults (in-memory placeholder).  
  - `POST /api/vaults` — create a vault (body: `creator`, `amount`, `endTimestamp`, `successDestination`, `failureDestination`).  
  - `GET /api/vaults/:id` — get a vault by id.
- **Background jobs (custom worker queue):**
  - `GET /api/jobs/health` — queue status (`ok`, `degraded`, `down`) and failure-rate snapshot.
  - `GET /api/jobs/metrics` — detailed queue metrics by job type.
  - `POST /api/jobs/enqueue` — enqueue a typed job.

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

## Background job system

The backend now includes a generic background processor built as a custom in-memory queue/worker with:

- Typed job registration and validation.
- Configurable worker concurrency and polling interval.
- Retry handling with exponential backoff.
- Queue health and metrics endpoints.
- Recurring scheduled jobs for deadline checks and analytics recompute.

### Built-in job types

- `notification.send`
- `deadline.check`
- `oracle.call`
- `analytics.recompute`

### Enqueue example

```bash
curl -X POST http://localhost:3000/api/jobs/enqueue \
  -H "Content-Type: application/json" \
  -d '{
    "type": "notification.send",
    "payload": {
      "recipient": "user@example.com",
      "subject": "Disciplr reminder",
      "body": "You have a milestone due soon."
    },
    "maxAttempts": 3,
    "delayMs": 0
  }'
```

### Optional environment variables

- `JOB_WORKER_CONCURRENCY` (default: `2`)
- `JOB_QUEUE_POLL_INTERVAL_MS` (default: `250`)
- `JOB_HISTORY_LIMIT` (default: `50`)
- `ENABLE_JOB_SCHEDULER` (`false` disables recurring jobs)
- `DEADLINE_CHECK_INTERVAL_MS` (default: `60000`)
- `ANALYTICS_RECOMPUTE_INTERVAL_MS` (default: `300000`)

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
│   ├── jobs/
│   │   ├── handlers.ts
│   │   ├── queue.ts
│   │   ├── system.ts
│   │   └── types.ts
│   ├── routes/
│   │   ├── health.ts
│   │   ├── jobs.ts
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
