# disciplr-backend

API and milestone engine for [Disciplr](https://github.com/your-org/Disciplr): programmable time-locked capital vaults on Stellar.

## What it does

- **Health:** `GET /api/health` — service status and timestamp.
- **Vaults:**  
  - `GET /api/vaults` — list all vaults (in-memory placeholder).  
  - `POST /api/vaults` — create a vault (body: `creator`, `amount`, `endTimestamp`, `successDestination`, `failureDestination`).  
  - `GET /api/vaults/:id` — get a vault by id.
- **Transactions:** 🆕
  - `GET /api/transactions` — list transactions with filters and pagination.
  - `GET /api/transactions/:id` — get a specific transaction.
  - `GET /api/transactions/vault/:vaultId` — get all transactions for a vault.
  - `GET /api/transactions/user/:userId` — get all transactions for a user.
  - `POST /api/transactions` — create a transaction (testing/manual entry).
  - `PUT /api/transactions/:id/link` — update transaction Stellar Explorer link.

Data is stored in memory for vaults, but transactions use PostgreSQL with real-time Stellar Horizon ETL. Production would use PostgreSQL for vaults as well.

## Tech stack

- **Node.js** + **TypeScript**
- **Express** for HTTP API
- **PostgreSQL** for transaction storage
- **Stellar SDK** for Horizon integration
- **Helmet** and **CORS** for security and cross-origin

## Local setup

### Prerequisites

- Node.js 18+
- PostgreSQL 12+
- npm or yarn

### Quick Setup

```bash
# From repo root
cd disciplr-backend

# Windows users
setup.bat

# Linux/Mac users  
chmod +x setup.sh && ./setup.sh
```

### Manual Setup

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
| `npm run test` | Run all tests                  |
| `npm run test:system` | Run transaction system tests |
| `npm run test:api` | Run API endpoint tests      |

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

### Example: query transaction history

```bash
# Get all transactions with pagination
curl "http://localhost:3000/api/transactions?page=1&limit=20"

# Filter by transaction type
curl "http://localhost:3000/api/transactions?type=creation"

# Filter by vault ID
curl "http://localhost:3000/api/transactions?vault=vault-123"

# Filter by date range
curl "http://localhost:3000/api/transactions?startDate=2024-01-01T00:00:00Z&endDate=2024-01-31T23:59:59Z"

# Get transactions for a specific user
curl "http://localhost:3000/api/transactions/user/GABC..."
```

For complete transaction system documentation, see [TRANSACTION_SYSTEM.md](./TRANSACTION_SYSTEM.md).

## Project layout

```
disciplr-backend/
├── src/
│   ├── routes/
│   │   ├── health.ts
│   │   ├── vaults.ts
│   │   └── transactions.ts          🆕
│   ├── services/
│   │   ├── transactionService.ts    🆕
│   │   ├── stellarETLService.ts     🆕
│   │   └── etlManager.ts            🆕
│   ├── types/
│   │   └── transactions.ts          🆕
│   ├── utils/
│   │   └── validation.ts             🆕
│   ├── database.ts                  🆕
│   └── index.ts
├── test/
│   ├── transactionSystem.test.ts    🆕
│   └── apiEndpoints.test.ts         🆕
├── migrations/
│   └── 001_create_transactions_table.sql  🆕
├── package.json
├── tsconfig.json
├── env.example                      🆕
├── setup.sh                        🆕
├── setup.bat                       🆕
├── TRANSACTION_SYSTEM.md            🆕
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
