# SpiritDrop Backend

Hostinger Node.js API and database logic for SpiritDrop.

The public website and the admin portal (see `../admin`) will both use this one API and database.

**Current state: connection skeleton only.** It has health checks and no business logic, authentication or frontend connection. The live website still uses Supabase.

The launch database is designed in `migrations/` and `docs/mariadb-schema-design.md`. **The migrations have been tested on local MariaDB but not run on Hostinger.** `npm test` runs the checks; see section 16 of that document for the database tests.

All database code must use `createDbPool()` / `getPool()` from `src/config/database.js`, which sets UTC and strict SQL mode on every connection.

## Deployment architecture

| Part | Address or system |
|---|---|
| Public website | `spiritdrop.com.au` |
| Private admin | `admin.spiritdrop.com.au` |
| Backend API (this folder) | `api.spiritdrop.com.au` |
| Database | Hostinger MariaDB/MySQL |

In production the API runs inside Hostinger, where `DB_HOST=127.0.0.1` reaches the database. Remote MySQL is not used.

## Run locally

Requires Node.js 22.9 or newer (Node 22 LTS is the intended version on Hostinger).

```bash
npm install
npm run dev
```

The API listens on `PORT`, or 3001 if `PORT` is not set. Hostinger supplies `PORT` in production; `npm start` runs the production server.

`npm run dev` loads `backend/.env` if it exists, but no local database connection is expected. `127.0.0.1` on your computer is not the Hostinger database, so `/health/db` returns 503 locally. That is normal.

## Environment variables

| Name | Purpose |
|---|---|
| `DB_HOST` | Database host |
| `DB_PORT` | Database port |
| `DB_NAME` | Database name |
| `DB_USER` | Database user |
| `DB_PASSWORD` | Database password |
| `NODE_ENV` | `production` on Hostinger, otherwise `development` |
| `PORT` | Supplied by Hostinger at runtime |

Never commit real values. Set them in Hostinger's environment variables. For local use they go in `backend/.env`, which Git ignores. `.env.example` holds placeholders only.

## Health endpoints

| Endpoint | What it checks | Success | Failure |
|---|---|---|---|
| `GET /health` | The API is running (no database query) | `200 {"ok":true,"service":"spiritdrop-api"}` | None |
| `GET /health/db` | The database answers `SELECT 1` | `200 {"ok":true,"database":"connected"}` | `503 {"ok":false,"database":"unavailable"}` |

Failure responses never include credentials, connection details, raw MySQL errors or stack traces. The API starts even when database variables are missing, so `/health` still works and the server log lists the missing names (never values).
