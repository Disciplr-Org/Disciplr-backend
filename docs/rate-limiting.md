# API Rate Limiting and Quota Reference

Disciplr enforces rate limits and quotas at various tiers to ensure platform stability, secure resources, prevent API abuse, and guarantee tenant isolation. This document provides a detailed reference for integrators on how rate limiting is structured, how to handle and parse rate limit headers, and how to implement robust client retry behavior.

---

## 1. Rate-Limit Tiers & Configured Budgets

Disciplr enforces specific limits based on request signatures (API authentication, Organization context, or Client IP) and the sensitivity of the endpoints. The table below lists all currently configured rate limiters and quotas:

| Tier / Category | Endpoints / Scope | Default Limit | Window Duration | Key Generation & Scope |
| :--- | :--- | :--- | :--- | :--- |
| **Authentication** | `POST /api/oauth/token`, login/auth endpoints | 20 requests | 15 minutes | Per API Key or Client IP |
| **API Keys** | `POST /api/api-keys/*` | 20 requests | 15 minutes | Per API Key or Client IP |
| **Jobs** | `POST /api/jobs/enqueue` | 10 requests | 1 hour | Per API Key or Client IP |
| **Privacy Operations** | `GET /api/privacy/export`, `DELETE /api/privacy/account` | 10 requests | 1 hour | Per API Key or Client IP |
| **Daily Export Quota** | `POST /api/exports/me`, `POST /api/exports/admin` | 100 exports | 1 day (UTC) | Per Organization ID |
| **Organization Read** | Org-scoped read resources | 200 requests | 1 minute | Per Organization ID |
| **Organization Write** | Org-scoped write resources | 200 requests | 1 minute | Per Organization ID |
| **Organization Analytics** | Org-scoped analytics and rollup endpoints | 200 requests | 1 minute | Per Organization ID |
| **Vaults** | `GET/POST /api/vaults*` | 50 requests | 15 minutes | Per API Key or Client IP |
| **Health Check** | `/api/health` | 30 requests | 1 minute | Per API Key or Client IP |
| **Metrics Scraper** | Metrics endpoints | 20 requests | 1 minute | Client IP / Scraper Token |
| **Default Fallback** | Unconfigured / other routes | 100 requests | 15 minutes | Per API Key or Client IP |

> [!NOTE]
> * **Standard limits** are configurable at startup using environment variables (e.g., `ORG_RATE_LIMIT_MAX`, `ORG_RATE_LIMIT_WINDOW_MS`, `EXPORT_DAILY_QUOTA_LIMIT`).
> * **Tenant Isolation:** When requests contain an organization context, the limit is namespace-scoped using the template `org:<orgId>:<apiKey|clientIp>` to protect organization quotas from being depleted by other tenants.

---

## 2. Response Headers

For endpoints governed by standard rate limiters, Disciplr emits draft-7 standard IETF rate-limit headers in the HTTP response. Clients should read these headers to adjust their request frequencies dynamically.

### Standard Headers

* **`RateLimit-Limit`**: The maximum number of allowed requests in the current window (e.g., `100`).
* **`RateLimit-Remaining`**: The number of requests remaining in the current window.
* **`RateLimit-Reset`**: The dynamic number of seconds remaining until the limit resets and a new window begins.
* **`Retry-After`**: Generated specifically on `429 Too Many Requests` status codes. It indicates the exact number of seconds the client must wait before making another request.

#### Example Headers on a Standard Request:
```http
HTTP/1.1 200 OK
RateLimit-Limit: 120
RateLimit-Remaining: 119
RateLimit-Reset: 59
```

#### Example Headers on a Rate-Limited Request:
```http
HTTP/1.1 429 Too Many Requests
RateLimit-Limit: 120
RateLimit-Remaining: 0
RateLimit-Reset: 45
Retry-After: 45
```

---

## 3. HTTP 429 Response Shapes

When a limit or quota is breached, the endpoint returns an `HTTP 429 Too Many Requests` status code. The response body is formatted depending on the type of limit violated.

### Standard 429 Envelope (AppError Rate Limited)
Standard rate limiters and error pipeline wrappers return a structured JSON error payload matching Disciplr's uniform error schema:

```json
{
  "error": {
    "code": "RATE_LIMITED",
    "message": "Too many requests. Please try again later."
  }
}
```

### Daily Export Quota 429 Envelope
Exceeding the Organization Daily Export Quota returns a specialized payload specifying the seconds remaining until the daily quota resets (midnight UTC):

```json
{
  "error": "Export quota exceeded. Try again tomorrow.",
  "retryAfter": 43200
}
```

---

## 4. Multi-Replica Behavior (Distributed Redis Store)

For multi-replica deployments, Disciplr routes rate limits through a distributed, Redis-backed token-bucket store (`RedisStore`). This ensures consistency across horizontally scaled application instances.

### Key Features of Distributed Rate Limiting:
* **Atomic Operations:** Increments and window resets are computed atomically via Redis `MULTI` scripts running `INCR` followed by `PTTL` in a single round-trip, preventing race conditions or double-counting on concurrent requests.
* **Fail-Open Semantics:** To guarantee high availability, the rate-limiter implementation degrades gracefully. If the centralized Redis server suffers a connection loss or timeout, the middleware logs a `[RATE_LIMIT_STORE_ERROR]` warning and fails open (allowing the request instead of throwing a blocking generic HTTP 500 error).

---

## 5. Recommended Client Retry & Backoff Pattern

Well-behaved clients and integrators must respect the `Retry-After` header. To prevent the "thundering herd" problem (where multiple rate-limited clients retry simultaneously when the window resets), clients must introduce **exponential backoff with full jitter**.

### Recommended SDK Retry Strategy:
1. Detect `HTTP 429 Too Many Requests`.
2. Inspect the `Retry-After` response header. If present and valid, use it as the base delay.
3. If `Retry-After` is missing:
   * Calculate a delay using exponential backoff: $Delay = Base \times 2^{attempt}$.
   * Cap the backoff at a maximum delay limit (e.g., 30–60 seconds).
4. Apply **Full Jitter** to the final sleep time:
   $$Sleep = \text{random}(0, Delay)$$
5. Limit the maximum retry attempts (e.g., maximum 3–5 retries) before surfacing a failure to the user.

### Example Javascript / TypeScript Implementation:

```typescript
import axios, { AxiosError } from 'axios';

const MAX_RETRIES = 5;
const BASE_BACKOFF_MS = 1000; // 1 second
const MAX_BACKOFF_MS = 32000; // 32 seconds

async function fetchWithRetry(url: string, options = {}, attempt = 0): Promise<any> {
  try {
    return await axios(url, options);
  } catch (error) {
    if (axios.isAxiosError(error) && error.response) {
      const response = error.response;

      if (response.status === 429 && attempt < MAX_RETRIES) {
        // 1. Check for Retry-After header (in seconds)
        const retryAfterHeader = response.headers['retry-after'];
        let delayMs = 0;

        if (retryAfterHeader) {
          const seconds = parseInt(retryAfterHeader, 10);
          if (!isNaN(seconds) && seconds > 0) {
            delayMs = seconds * 1000;
          }
        }

        // 2. Fall back to exponential backoff if header is missing
        if (delayMs === 0) {
          const expDelay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * Math.pow(2, attempt));
          // Apply Full Jitter
          delayMs = Math.random() * expDelay;
        }

        console.warn(`Rate limited (429). Retrying attempt ${attempt + 1}/${MAX_RETRIES} in ${Math.round(delayMs)}ms...`);
        
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return fetchWithRetry(url, options, attempt + 1);
      }
    }
    throw error;
  }
}
```
