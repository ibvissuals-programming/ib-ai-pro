# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)
- **AI provider**: Gemini (via `GEMINI_API_KEY` secret)

## Key Commands

- `pnpm run health`     — quick one-pass system health check (workflows, DB, secrets, API)
- `pnpm run guard`      — import guard: validates state, reports issues (read-only)
- `pnpm run guard:fix`  — import guard with auto-fix (installs packages + pushes schema if needed)
- `pnpm run db:guard`   — push schema only if tables are missing (idempotent)
- `pnpm run typecheck`  — full typecheck across all packages
- `pnpm run build`      — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only — prefer `pnpm run db:guard`)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

## Import Behavior Rules (CRITICAL — read before modifying bootstrap flow)

These rules make every import/restart deterministic. ONE PASS only: **scan → validate → fix → report → STOP**.

### PHASE 1 — Package Installation Guard
- **DO NOT** reinstall packages if `node_modules/.pnpm` exists AND `pnpm-lock.yaml` exists
- Check validity before running `pnpm install`

### PHASE 2 — Workflow Guard
- **DO NOT** start or restart workflows that are already running
- Check ports: backend=8099/8080, frontend=5000/23765
- If a port is open → workflow is running → skip

### PHASE 3 — Database Migration Guard
- **DO NOT** run `drizzle-kit push` if all 8 required tables exist
- Required tables: `users`, `image_history`, `admin_logs`, `chat_sessions`, `chat_messages`, `user_memory`, `image_jobs`, `usage_analytics`
- Always use `node scripts/db-guard.cjs` (or `pnpm run db:guard`) instead of bare `pnpm --filter @workspace/db run push`
- `post-merge.sh` already enforces this guard

### PHASE 4 — Secrets Guard
- **NEVER** request the same secret more than once per session
- Collect ALL missing secrets → request in ONE single batch
- Required secrets: `GEMINI_API_KEY` (critical), `DATABASE_URL` (critical), `JWT_SECRET`, `CEO_RECOVERY_KEY`, `CEO_USERNAME`
- If a secret is already set → mark resolved → skip

### PHASE 5 — AI Provider Guard
- If `GEMINI_API_KEY` exists → **do not** reinitialize or reinstall the Gemini blueprint
- Gemini is the primary AI provider; do not overwrite provider routing

### PHASE 6 — Startup Order
1. Quick system scan (NOT full codebase re-exploration)
2. Validate workflows (port check)
3. Validate database (table existence check)
4. Validate secrets (one-pass, batch request if missing)
5. Start server only if not already running
6. Run `pnpm run health` for single health check
7. **STOP** — no loops, no repeated checks

### PHASE 7 — Output Format
At end of any import/bootstrap, output ONLY:
```
✔/✗ Workflows    backend :PORT | frontend :PORT
✔/✗ Database     connected (N/8 tables)
✔/✗ API          ok (uptime Xs, gemini: ✔)
✔/✗ Secrets      all present / missing: KEY1, KEY2
System READY / NOT READY
```
No extra commentary, no repeated log parsing, no screenshot loops.

## Secrets Reference

| Secret | Required | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | **Critical** | AI features (chat, image, TTS, prompt engineering) |
| `DATABASE_URL` | **Critical** | PostgreSQL connection (auto-provisioned by Replit) |
| `JWT_SECRET` | Recommended | Token signing (falls back to insecure dev default) |
| `CEO_PASSWORD` | Setup only | Bootstrap CEO account (remove after first login) |
| `CEO_RECOVERY_KEY` | Recommended | Emergency CEO account recovery |

## Artifacts

### IB AI v2 (`artifacts/ib-ai-v2`)
- **Kind**: React + Vite (frontend)
- **Preview path**: `/`
- **Port**: 5000 (IB AI Frontend workflow) or 23765 (artifact workflow)
- **Proxy**: `/api/*` → `http://localhost:8099`

### API Server (`artifacts/api-server`)
- **Kind**: Express 5 + TypeScript
- **Port**: 8099 (IB AI Backend workflow) or 8080 (artifact workflow)
- **Build**: esbuild → `dist/index.mjs`
- **Health endpoint**: `GET /health`

### Architecture
```
src/
├── lib/
│   ├── geminiEnv.ts        — Gemini key resolver (GEMINI_API_KEY)
│   ├── token.ts            — JWT signing/verification (JWT_SECRET)
│   ├── userStore.ts        — in-memory user store (JSON + PG dual-write)
│   ├── systemConfig.ts     — storage mode (json/postgres/hybrid)
│   └── aiOrchestrator.ts   — AI job routing and tracking
├── services/
│   ├── imageGenService.ts  — Gemini image generation
│   ├── ttsService.ts       — Gemini TTS
│   └── chatStore.ts        — chat history persistence
└── routes/                 — all API routes under /api/*
```

#### SaaS Upgrade Path
- Auth → replace `authService` with Replit Auth or Clerk
- Persistence → already on PostgreSQL (`USE_POSTGRES_STORAGE=true`)
- Payments → add Stripe checkout
