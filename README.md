# Ophir API

A ride-hailing REST API: riders request trips, nearby drivers are matched and offered the ride one at a time, and the trip moves through its full lifecycle through to payment and ratings.

| Concern | Choice |
|---|---|
| Runtime | **Bun** |
| HTTP | **Express 4** + TypeScript (strict) |
| Database | **PostgreSQL 16**, raw SQL via `pg`, **no ORM** |
| Queue | **BullMQ** (ride matching, offer timeouts, housekeeping schedules) |
| Cache / geo / rate limit | **Valkey** (Redis protocol; `ioredis` client) |
| Auth | **JWT** access tokens + opaque **rotating refresh tokens** with reuse detection |
| Validation | Zod |
| Logging | Pino |

---

## Table of contents

1. [Quick start](#quick-start)
2. [Configuration](#configuration)
3. [Architecture](#architecture)
4. [Authentication design](#authentication-design)
5. [Ride lifecycle and matching](#ride-lifecycle-and-matching)
6. [Housekeeping](#housekeeping)
7. [Data model](#data-model)
8. [API reference](#api-reference)
9. [Walkthrough with curl](#walkthrough-with-curl) · [Postman collection](#postman-collection)
10. [Error format](#error-format)
11. [Testing](#testing)
12. [Production notes](#production-notes)
13. [Project layout](#project-layout)
14. [Known simplifications](#known-simplifications)

---

## Quick start

### Option A: Docker Compose (everything)

```bash
cp .env.example .env
docker compose up --build
# API on http://localhost:3000, worker running alongside it
```

### Option B: local Bun, Docker only for dependencies

```bash
docker compose up -d postgres valkey
cp .env.example .env
bun install
bun run migrate            # applies migrations/*.up.sql
bun run seed -- --demo     # admin@example.com / Admin12345 (+ demo rider/driver)
bun run dev                # API with watch mode  (terminal 1)
bun run worker             # BullMQ worker        (terminal 2)
```

> **The worker is required.** The API only enqueues jobs. Without `bun run worker`, rides stay in `searching` forever and no housekeeping runs.

Check it is up:

```bash
curl localhost:3000/health   # {"status":"ok"}
curl localhost:3000/ready    # checks Postgres + Valkey
```

### Scripts

| Script | What it does |
|---|---|
| `bun run dev` | API with `--watch` |
| `bun run start` | API |
| `bun run worker` | Matching + housekeeping worker |
| `bun run migrate` / `migrate:down` | Apply pending migrations / revert the latest |
| `bun run seed [-- --demo]` | Create admin (and demo rider/driver) |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run test` | Jest unit + end-to-end tests (isolated DB, see [Testing](#testing)) |

---

## Configuration

All configuration is environment variables, validated at boot with Zod (the process exits with a readable error if something is invalid). See `.env.example`.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DATABASE_URL` | – | Postgres connection string |
| `PG_POOL_MAX` | `10` | Pool size per process |
| `VALKEY_URL` | `redis://localhost:6379` | Valkey/Redis |
| `JWT_ACCESS_SECRET` | – | HS256 secret, **min 32 chars** |
| `JWT_ISSUER` | `ophir-api` | `iss` claim, verified |
| `ACCESS_TOKEN_TTL_SECONDS` | `900` | Access token lifetime |
| `REFRESH_TOKEN_TTL_DAYS` | `30` | Refresh token lifetime |
| `AUTH_RATE_LIMIT_MAX` | `20` | Auth requests per IP per minute |
| `MATCH_SEARCH_RADIUS_KM` | `5` | Driver search radius |
| `MATCH_MAX_CANDIDATES` | `10` | Candidates considered per matching step |
| `DRIVER_OFFER_TIMEOUT_SECONDS` | `20` | How long a driver has to respond |
| `RIDE_SEARCH_TIMEOUT_SECONDS` | `180` | Give up (`no_drivers`) after this |
| `ARRIVAL_RADIUS_KM` | `0.5` | Driver must be this close to pickup to mark "arrived" |
| `BASE_FARE`, `PER_KM`, `PER_MINUTE`, `MIN_FARE`, `CURRENCY` | see file | Pricing |
| `PLATFORM_FEE_PERCENT` | `20` | Platform cut of each fare |
| `DRIVER_STALE_SECONDS` | `120` | No location ping for this long ⇒ driver forced offline |
| `STUCK_RIDE_HOURS` | `6` | Housekeeping cancels live rides idle this long |

---

## Architecture

```
            ┌──────────┐   REST    ┌────────────────┐
 Rider app ─┤          ├──────────►│  API (Express) │──── SQL ────► PostgreSQL
 Driver app ┤  clients │           │  stateless,    │
            └──────────┘           │  N replicas    │──── GEO / rate-limit / denylist ──┐
                                   └───────┬────────┘                                   ▼
                                           │ enqueue                                 Valkey
                                           ▼                                            ▲
                                   BullMQ queues (in Valkey)                            │
                                   · ride-matching                                      │
                                   · housekeeping                                       │
                                           │                                            │
                                           ▼                                            │
                                   ┌────────────────┐                                   │
                                   │ Worker process │───────────────────────────────────┘
                                   │ (N replicas)   │──── SQL ────► PostgreSQL
                                   └────────────────┘
```

Design decisions:

- **No ORM.** Every query is hand-written, parameterised SQL in the service layer through three tiny helpers (`query`, `queryOne`, `withTransaction`) in `src/db/pool.ts`. Business invariants are enforced by the database where possible (partial unique indexes, `FOR UPDATE` row locks, conditional `UPDATE ... WHERE status = ...`).
- **Postgres is the source of truth; Valkey holds ephemeral, fast-changing state:** the driver GEO index, last-known locations, rate-limit counters, and the logout denylist. Losing Valkey degrades matching but never corrupts data, and housekeeping reconciles drift.
- **REST only, so clients poll.** Riders poll `GET /rides/:id` (it includes the driver and live location once accepted); drivers poll `GET /drivers/me/offers`. Swapping this for SSE/WebSockets later only touches the transport layer.
- **API and worker are separate processes** and scale independently. Every job is idempotent, so running multiple workers is safe.
- Modules are `routes → service → SQL`: routes validate and authorise, services contain the business logic.

---

## Authentication design

Two tokens, different jobs:

| | Access token | Refresh token |
|---|---|---|
| Format | JWT (HS256) | 48 random bytes, base64url, **opaque** |
| Lifetime | 15 min (configurable) | 30 days (configurable) |
| Stored server-side | No (stateless) | **Only a SHA-256 hash**, in `refresh_tokens` |
| Sent | `Authorization: Bearer …` | body of `POST /auth/refresh` only |
| Claims | `sub` (user), `role`, `sid` (session id), `iss`, `exp` | – |

### Rotation and reuse detection

Every refresh token is **single use**. `POST /auth/refresh` atomically (one transaction, row locked) revokes the presented token and issues a new pair in the same *family* (= one login session).

If an **already-used** token is presented again, someone is replaying a stolen token. The server revokes **the entire family** (and its access tokens) and returns `401 REFRESH_TOKEN_REUSED`. Both the attacker and the real user must log in again, which is the intended trade-off.

### Immediate logout

JWTs are stateless, so a logout would normally stay valid until `exp`. Each access token carries its session id (`sid`). Logout writes `auth:revoked-session:<sid>` to Valkey with a TTL equal to the access-token lifetime, and the auth middleware checks it. One Valkey `EXISTS` per request buys instant revocation.

### Other hardening

- Passwords hashed with **argon2id** (`Bun.password`); password policy enforced; login runs a dummy hash for unknown emails so response time does not reveal which emails exist.
- Algorithm pinned to HS256 and `iss` verified (blocks `alg: none` and token confusion).
- Per-IP rate limiting on auth endpoints, shared across API replicas via Valkey.
- Disabled accounts cannot refresh; an admin disabling a user revokes all of their refresh tokens.
- `helmet`, 50 KB body limit, no stack traces in responses, `Authorization` redacted from logs.

Roles: `rider`, `driver`, `admin`. Self-registration only allows rider/driver; create admins with `bun run seed`.

---

## Ride lifecycle and matching

```
                ┌──────────── rider cancels ────────────┐
                │                                       ▼
 [request] → searching ──accept──► accepted ──arrive──► arrived ──start──► in_progress ──complete──► completed
                │  ▲                  │                                                              │
                │  └── driver cancels ┘ (back to searching, that driver excluded)                    └─► rate (both sides)
                ├── no driver within RIDE_SEARCH_TIMEOUT ──► no_drivers
                └── cancelled
```

### Driver availability

1. `PUT /drivers/me/profile`: vehicle + licence (required once).
2. `POST /drivers/me/online {lat,lng}`: status `online`, added to the Valkey geo index `geo:drivers:<vehicleType>` (`GEOADD`).
3. `PUT /drivers/me/location` every few seconds: refreshes the geo index and a heartbeat. Postgres is updated at most every 15 s per driver to keep write load low.
4. While on a ride a driver is `busy` and removed from the geo index; they return automatically on completion or cancellation.

### Matching (BullMQ)

1. `POST /rides` inserts the ride as `searching` and enqueues a **`match-ride`** job, returning immediately.
2. The worker runs `GEOSEARCH` around the pickup (nearest first), then filters in SQL to drivers who are `online`, were not already offered this ride, and have no other pending offer.
3. Under a row lock on the ride it inserts a **`ride_offers`** row (one pending offer per ride at a time) and schedules a **delayed `offer-timeout`** job (`DRIVER_OFFER_TIMEOUT_SECONDS`).
4. The driver sees it in `GET /drivers/me/offers` and either:
   - **accepts**: a single atomic `UPDATE rides … WHERE status = 'searching' AND driver_id IS NULL` decides the winner; the driver becomes `busy`; or
   - **declines**, or **does nothing** until the timeout job expires the offer. Either way the next `match-ride` step offers it to the next-nearest driver.
5. If nobody is available the step re-polls every 5 s until `RIDE_SEARCH_TIMEOUT_SECONDS`, then the ride becomes `no_drivers`.

Race safety, enforced by Postgres:

- Partial unique indexes: one live ride per rider, one live ride per driver.
- `UNIQUE (ride_id, driver_id)`: a driver is never offered the same ride twice.
- Accept is a compare-and-set, so double-accepts and accept-vs-cancel races resolve cleanly (`409`).

### Pricing

`fare = max(MIN_FARE, BASE_FARE + km × PER_KM + minutes × PER_MINUTE) × vehicleMultiplier` (economy ×1, comfort ×1.3, xl ×1.6). Distance is great-circle × 1.3 road factor at a 30 km/h average, a stand-in for a real routing service. On completion the final fare is never lower than the quote and capped at 3× the quote; the platform fee and driver earnings are split from it, and a `payments` row is written.

---

## Housekeeping

Scheduled with BullMQ **job schedulers** at worker start-up. `upsertJobScheduler` is idempotent, so any number of worker replicas can start without duplicating schedules, and a given run executes exactly once. Each run is recorded in `housekeeping_runs` (job, start/finish, rows affected, error).

| Job | Schedule | What it does |
|---|---|---|
| `purge-refresh-tokens` | daily 03:00 | Deletes tokens expired >1 day, or revoked/rotated >7 days ago. Recently revoked ones are kept so reuse detection still works. |
| `expire-stale-offers` | every 30 s | Safety net: expires pending offers whose delayed timeout job was lost (Valkey flush, crash) and re-triggers matching. |
| `expire-stale-searches` | every 60 s | Rides stuck in `searching` past the search window become `no_drivers`. |
| `release-stuck-rides` | every 15 min | Rides in accepted/arrived/in_progress idle for `STUCK_RIDE_HOURS` are cancelled by the system and the driver is freed. |
| `offline-stale-drivers` | every 30 s | Drivers with no heartbeat for `DRIVER_STALE_SECONDS` are removed from the geo index and set `offline`; also reconciles drivers marked online in Postgres without a heartbeat. |
| `purge-housekeeping-runs` | daily 03:30 | Trims run history older than 30 days. |

Admins can inspect runs and trigger any job on demand (see [Admin](#admin)).

---

## Data model

Defined in `migrations/0001_init.up.sql`.

| Table | Notes |
|---|---|
| `users` | Case-insensitive unique email (`lower(email)` index), role, rating aggregate |
| `refresh_tokens` | Hash only, `family_id`, `revoked_at`, `replaced_by` chain, user agent and IP |
| `drivers` | 1:1 with a user: vehicle, status, last location, lifetime earnings |
| `rides` | Full trip record with quote, final fare, split, timestamps per state, ratings |
| `ride_offers` | One row per (ride, driver) offer with status and expiry |
| `ride_events` | Append-only audit trail per ride |
| `payments` | One per completed ride (settlement is simulated) |
| `housekeeping_runs` | Job run log |

Migrations are plain `NNNN_name.up.sql` / `.down.sql` files applied in order by `scripts/migrate.ts` (transactional, guarded by a Postgres advisory lock so concurrent deploys are safe, tracked in `schema_migrations`). To add one: create `0002_xxx.up.sql` and `0002_xxx.down.sql`, then `bun run migrate`.

---

## API reference

Base path `/api/v1`. All bodies are JSON. Protected routes need `Authorization: Bearer <accessToken>`. Coordinates are `{ "lat": -90..90, "lng": -180..180 }`.

### Health (no prefix)

| | |
|---|---|
| `GET /health` | Liveness |
| `GET /ready` | Readiness (Postgres + Valkey), `503` if either is down |

### Auth

| Method & path | Auth | Description |
|---|---|---|
| `POST /auth/register` | – | `{email, password, fullName, phone?, role: "rider"\|"driver"}` → `201 {user, tokens}` |
| `POST /auth/login` | – | `{email, password}` → `{user, tokens}` |
| `POST /auth/refresh` | – | `{refreshToken}` → `{tokens}` (rotates; reuse ⇒ session revoked) |
| `POST /auth/logout` | ✓ | Revoke the current session → `204` |
| `POST /auth/logout/refresh-token` | – | `{refreshToken}`: log out when the access token already expired → `204` |
| `POST /auth/logout-all` | ✓ | Revoke every session → `{revokedSessions}` |
| `GET /auth/sessions` | ✓ | Active sessions (device, IP, last used, `current`) |

`tokens` = `{accessToken, refreshToken, tokenType: "Bearer", expiresIn}`. Password: ≥8 chars with upper, lower and a digit.

### Users

| | |
|---|---|
| `GET /users/me` | Profile and rating |
| `PATCH /users/me` | `{fullName?, phone?}` |

### Rider: rides

| Method & path | Description |
|---|---|
| `POST /rides/estimate` | `{pickup, dropoff}` → fare, ETA and nearby driver count per vehicle type |
| `POST /rides` | `{pickup:{lat,lng,address?}, dropoff:{…}, vehicleType?, paymentMethod?}` → `201 {ride}` (`searching`). `409 ACTIVE_RIDE_EXISTS` if one is already live |
| `GET /rides/active` | Current live ride, or `null` |
| `GET /rides` | History. `?status=&limit=&offset=` |
| `GET /rides/:id` | Ride detail. Includes `driver` (vehicle, rating, live location) once accepted |
| `GET /rides/:id/events` | Audit trail |
| `POST /rides/:id/cancel` | `{reason?}`. Rider: while searching/accepted/arrived. Driver: while accepted/arrived, which re-queues the ride |
| `POST /rides/:id/rate` | `{rating: 1-5, comment?}`. Both parties, once, completed rides only |

`vehicleType`: `economy` (default) \| `comfort` \| `xl`. `paymentMethod`: `cash` (default) \| `card` \| `wallet`.

### Driver

| Method & path | Description |
|---|---|
| `PUT /drivers/me/profile` | `{licenseNumber, vehicleMake, vehicleModel, vehicleColor, plateNumber, vehicleType}` |
| `GET /drivers/me` | Profile, status, lifetime earnings |
| `POST /drivers/me/online` | `{lat,lng}` |
| `POST /drivers/me/offline` | `409` while on a ride |
| `PUT /drivers/me/location` | `{lat,lng}` → `204`. Rate limited to 20 per 10 s |
| `GET /drivers/me/offers` | Pending, unexpired offers (poll this) |
| `POST /drivers/me/offers/:offerId/accept` | → `{ride}`. `409 OFFER_EXPIRED` / `RIDE_UNAVAILABLE` |
| `POST /drivers/me/offers/:offerId/decline` | → `204` |
| `POST /rides/:id/arrive` | Requires being within `ARRIVAL_RADIUS_KM` of pickup |
| `POST /rides/:id/start` | |
| `POST /rides/:id/complete` | `{actualDistanceKm?, actualDurationMin?}` → final fare, platform fee, driver earnings |
| `GET /drivers/me/earnings` | `?from=&to=` (ISO dates) → trips, gross, fees, net |
| `GET /rides` | The driver's trip history |

### Payments

`GET /payments`: the caller's payment history (as rider or driver).

### Admin

| | |
|---|---|
| `GET /admin/housekeeping/runs` | `?job=&limit=` run history |
| `POST /admin/housekeeping/:job/run` | Queue a job now → `202` |
| `GET /admin/queues` | BullMQ job counts |
| `POST /admin/users/:id/active` | `{active: boolean}`. Deactivating revokes all their refresh tokens |

---

## Walkthrough with curl

```bash
API=http://localhost:3000/api/v1
J='content-type: application/json'

# --- Driver: sign up, add vehicle, go online ---------------------------------
D=$(curl -s $API/auth/register -H "$J" -d '{"email":"d@x.com","password":"Passw0rd1","fullName":"Dana Driver","role":"driver"}')
DT=$(echo $D | jq -r .tokens.accessToken)
curl -s -X PUT $API/drivers/me/profile -H "$J" -H "Authorization: Bearer $DT" \
  -d '{"licenseNumber":"N01-23-456789","vehicleMake":"Toyota","vehicleModel":"Vios","vehicleColor":"white","plateNumber":"ABC1234"}'
curl -s $API/drivers/me/online -H "$J" -H "Authorization: Bearer $DT" -d '{"lat":14.5548,"lng":121.0245}'

# --- Rider: sign up, get a quote, book ---------------------------------------
R=$(curl -s $API/auth/register -H "$J" -d '{"email":"r@x.com","password":"Passw0rd1","fullName":"Rita Rider"}')
RT=$(echo $R | jq -r .tokens.accessToken)
curl -s $API/rides/estimate -H "$J" -H "Authorization: Bearer $RT" \
  -d '{"pickup":{"lat":14.5547,"lng":121.0244},"dropoff":{"lat":14.5995,"lng":121.0369}}'
RIDE=$(curl -s $API/rides -H "$J" -H "Authorization: Bearer $RT" \
  -d '{"pickup":{"lat":14.5547,"lng":121.0244,"address":"Makati"},"dropoff":{"lat":14.5995,"lng":121.0369,"address":"Ortigas"}}' | jq -r .ride.id)

# --- Driver: take the offer and run the trip ---------------------------------
OFFER=$(curl -s $API/drivers/me/offers -H "Authorization: Bearer $DT" | jq -r '.offers[0].offerId')
curl -s -X POST $API/drivers/me/offers/$OFFER/accept -H "Authorization: Bearer $DT"
curl -s -X POST $API/rides/$RIDE/arrive   -H "Authorization: Bearer $DT"
curl -s -X POST $API/rides/$RIDE/start    -H "Authorization: Bearer $DT"
curl -s -X POST $API/rides/$RIDE/complete -H "$J" -H "Authorization: Bearer $DT" -d '{}'

# --- Rider: rate ---------------------------------------------------------------
curl -s -X POST $API/rides/$RIDE/rate -H "$J" -H "Authorization: Bearer $RT" -d '{"rating":5}'

# --- Token refresh -------------------------------------------------------------
curl -s $API/auth/refresh -H "$J" -d "{\"refreshToken\":\"$(echo $R | jq -r .tokens.refreshToken)\"}"
```

---

## Error format

Every error uses one shape:

```json
{ "error": { "code": "BAD_REQUEST", "message": "Human readable", "details": [ { "path": "email", "message": "Invalid email" } ] } }
```

| Status | Typical `code` |
|---|---|
| 400 | `BAD_REQUEST` (validation, with `details`), `BAD_JSON` |
| 401 | `UNAUTHORIZED`, `INVALID_TOKEN`, `TOKEN_EXPIRED`, `SESSION_REVOKED`, `INVALID_CREDENTIALS`, `INVALID_REFRESH_TOKEN`, `REFRESH_TOKEN_EXPIRED`, `REFRESH_TOKEN_REUSED` |
| 403 | `FORBIDDEN` (wrong role, no driver profile) |
| 404 | `NOT_FOUND` (also returned for rides you are not a party to, so existence does not leak) |
| 409 | `EMAIL_TAKEN`, `ACTIVE_RIDE_EXISTS`, `INVALID_STATE`, `OFFER_EXPIRED`, `RIDE_UNAVAILABLE`, `TOO_FAR_FROM_PICKUP`, `ALREADY_RATED` |
| 429 | `RATE_LIMITED` (with `Retry-After`) |

A client should treat `401 TOKEN_EXPIRED` as "call `/auth/refresh`, then retry once".

---

## Testing

Tests use **Jest** (`@swc/jest` for TypeScript, `supertest` for HTTP).

```bash
bun run test          # everything (serial: e2e suites share one DB)
bun run test:unit     # fast, no services needed
bun run test:e2e      # needs Postgres + Valkey
npx jest --coverage   # coverage report
```

Prerequisites for the e2e suites: Postgres at `DATABASE_URL` (the user must be allowed to `CREATE DATABASE`), Valkey/Redis at `VALKEY_URL`, and the `bun` binary on `PATH` (Jest's global setup uses it to run the migration runner).

**Isolation.** `tests/support/global-setup.ts` creates and migrates a separate `ophir_test` database, and `tests/support/setup-env.ts` points the app at it and at Valkey logical DB 1, so development data is never touched. Each e2e file flushes that Valkey DB and truncates `users` before it starts.

**Runtime note.** Jest runs on Node, where Bun's `Bun.password` API (argon2id) does not exist. `setup-env.ts` installs a small scrypt-based stand-in for tests only. Production still uses argon2id. The e2e suites start the real BullMQ workers in-process (`startWorkers({ schedule: false })`) with the offer timeout shortened to 2 s.

| Suite | Type | Covers |
|---|---|---|
| `tests/unit/pricing.test.ts` | unit | haversine, fare formula, vehicle multipliers, min fare, fee split |
| `tests/unit/jwt.test.ts` | unit | round-trip, expiry, wrong secret/issuer, tampering, `alg: none`, missing claims |
| `tests/unit/middleware.test.ts` | unit (Valkey mocked) | `authenticate`, `requireRole`, `validate`, `rateLimit` (incl. fail-open), error handler |
| `tests/e2e/auth.e2e.test.ts` | e2e | register/login, no hash leakage, refresh rotation, **reuse detection**, concurrent refresh, logout/logout-all, sessions, rate limiting |
| `tests/e2e/rides.e2e.test.ts` | e2e | estimate, driver availability, full lifecycle, fare cap, vehicle-type filtering, offer expiry, accept races, driver/rider cancel, `no_drivers` |
| `tests/e2e/housekeeping.e2e.test.ts` | e2e | every housekeeping job, run log, admin endpoints |

## Postman collection

Ready-made collection and environment in `postman/`:

| File | |
|---|---|
| `ophir-api.postman_collection.json` | 82 requests with test scripts |
| `ophir-local.postman_environment.json` | `baseUrl` (`http://localhost:3000/api/v1`), `rootUrl`, default password, seeded admin credentials |

**Use it**

1. Start Postgres and Valkey, then `bun run migrate`, `bun run dev` **and `bun run worker`** (matching happens in the worker; without it no offers ever appear).
2. In Postman: **Import** both files and select the **Ophir - Local** environment.
3. Open **1. Happy path (run in order)** and click **Run** (Collection Runner). It registers a rider and a driver, creates the vehicle, books a ride, polls for the offer, accepts, drives to pickup, starts and completes the trip, rates both sides, and checks payment, earnings and the audit trail: 21 requests, ~40 assertions.
4. Other folders are for exploring one area at a time: **Auth**, **Users**, **Driver**, **Rides - rider**, **Rides - driver**, **Payments**, **Admin**, **Security & error cases**, **Sign out (run last)**.

**How it works**

- Tokens and ids are saved automatically as collection variables (`riderToken`, `riderRefresh`, `driverToken`, `rideId`, `offerId`, ...). Nothing to copy-paste. Each protected request already points at the right token.
- *Register rider* picks a fresh random test area on every run, so drivers left online by earlier runs are never in range and offers always reach the driver created in that run.
- *Poll offers* re-sends itself (up to 20 times, 500 ms apart) in the Collection Runner until the worker has created the offer. When sending manually, just click Send again.
- **Admin** needs an admin account, which cannot be self-registered: run `bun run seed` once (`admin@example.com` / `Admin12345`) and use *Auth > Login admin*.
- **Security & error cases** covers 401/403/404/400 responses and demonstrates **refresh-token reuse detection**: replaying an already-rotated refresh token revokes the whole session. Run *Auth > Refresh rider token* first; log in again afterwards.
- Auth endpoints are rate limited (20 requests/min/IP by default). Running many folders back to back can return `429`; wait a minute or start the API with `AUTH_RATE_LIMIT_MAX=1000`.

The collection was verified with Newman (`npx newman run postman/ophir-api.postman_collection.json -e postman/ophir-local.postman_environment.json`) against a live API and worker. The full sequence passes with 0 failed assertions, run twice back to back.

## Production notes

- **Valkey must use `maxmemory-policy noeviction`**, which BullMQ requires (the compose file sets it). Enable AOF persistence if queued jobs must survive restarts; housekeeping covers lost delayed jobs either way.
- Set a strong `JWT_ACCESS_SECRET` (`openssl rand -base64 48`). Rotating it invalidates all access tokens, and clients recover through refresh.
- Run `bun run migrate` as a deploy step before rolling out new API/worker versions.
- Run ≥2 API replicas behind a load balancer (`trust proxy` is set to 1 hop so rate limiting sees real client IPs). Run ≥1 worker. Both shut down gracefully on `SIGTERM`.
- Terminate TLS at the load balancer; restrict `cors()` to your app origins.
- Tune `PG_POOL_MAX × replicas` below Postgres `max_connections`.
- Logs are structured JSON (Pino) with a request id (`x-request-id`).

## Project layout

```
src/
  app.ts, server.ts, worker.ts        Express app · API entry · worker process entry
  workers/index.ts                    startWorkers(): matching + housekeeping BullMQ workers
  config/env.ts                       Zod-validated configuration
  db/pool.ts, db/valkey.ts            pg pool + query/transaction helpers · Valkey clients
  lib/                                jwt, pricing, geo, errors, logger, async handler
  middleware/                         auth (JWT + roles), validate (Zod), rate-limit, errors
  queues/index.ts                     Queue definitions and enqueue helpers
  modules/
    auth/        register/login/refresh/logout, token rotation
    users/       profile
    drivers/     profile, availability, location, geo index, earnings
    rides/       lifecycle (rides.service) + matching (matching.service)
    payments/    payment history
    housekeeping/ scheduled tasks + admin endpoints
migrations/                           Plain SQL up/down files
postman/                              Postman collection + environment
scripts/                              migrate.ts, seed.ts
tests/                                Jest: unit/ · e2e/ · support/ (global setup, helpers)
jest.config.cjs                       Jest configuration
```

## Known simplifications

This is a solid backend foundation, not a full product. Deliberate gaps:

- **Payments are simulated.** Every method settles instantly and no gateway is called. Add one behind `complete()` in `rides.service.ts`.
- **Routing is approximate.** Distance is haversine × 1.3, with no traffic or surge pricing. Swap `estimateTrip` for a routing API.
- **No push or real-time transport.** Clients poll; add SSE/WebSocket or FCM/APNs where `ride_events` are written.
- **No driver document verification, promo codes, or refunds.**
- **Geo index** is a Valkey GEO set per vehicle type. This scales to hundreds of thousands of drivers per key; shard by city beyond that.
