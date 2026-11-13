# StockFlow MVP

A lightweight multi-tenant inventory app for internal demos. It includes email/password signup and login, organization-scoped products, low-stock tracking, a dashboard, and a per-organization default threshold.

## Run locally

Requirements: Node.js 22.5 or newer (uses the built-in `node:sqlite` module).

```powershell
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000). SQLite data and sessions are stored under `data/`.

For development with automatic restarts, run `npm run dev`. Run the test suite with `npm test`.

## Configuration

| Variable | Purpose | Default |
| --- | --- | --- |
| `PORT` | HTTP port | `3000` |
| `SESSION_SECRET` | Secret used to sign session cookies | Development-only value; required in production |
| `NODE_ENV` | Enables secure cookies when set to `production` | — |
| `DB_PATH` | SQLite database file path | `data/stockflow.sqlite` |

Set a long, random `SESSION_SECRET` for any hosted deployment. The app is designed for a single Node.js instance with persistent disk storage; use a managed database and shared session store before scaling across instances.

## Deploy to Render

1. Push this repository to a GitHub repository Render can access.
2. In Render, create a new Blueprint and select that repository. Render reads `render.yaml`.
3. Review the service and persistent-disk cost in Render before confirming deployment.

The Blueprint provisions a persistent disk at `data/`, sets `DB_PATH`, and generates `SESSION_SECRET`. SQLite data and login sessions survive restarts and deploys. This requires a paid Render web service because persistent disks are not available on the free plan.

## MVP notes

- Each account creates one organization. Users, products, and settings are scoped by the signed-in session's organization.
- SKUs must be unique within an organization.
- Product and default thresholds are non-negative whole numbers. Optional prices are stored as decimal amounts.
- Product-specific low-stock thresholds override the organization default.
- Product deletion is permanent in this MVP.
