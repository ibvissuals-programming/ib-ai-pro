# IB AI Studio Lab

An AI operating system for cinematic image editing, AI chat with persistent memory, and multimodal generation (TTS / image / video).

---

## Stack

| Layer | Technology |
|---|---|
| Monorepo | pnpm workspaces |
| Backend | Express 5 + TypeScript + esbuild |
| Frontend | React 19 + Vite 7 + Tailwind CSS 4 |
| Database | PostgreSQL + Drizzle ORM |
| AI (primary) | Google Gemini 2.5 Flash |
| AI (chat) | Groq (Llama 3.1) with Gemini fallback |
| Auth | Custom JWT + RBAC (free / premium / ceo) |

---

## Required Secrets

Set these in **Replit Secrets** (never in code or `.env` files).

### Critical — server will not start without these

| Secret | Where to get it | Notes |
|---|---|---|
| `DATABASE_URL` | Replit PostgreSQL integration | Set automatically when you enable the DB integration |

### AI Providers — missing activates Safe Mode (server still boots)

| Secret | Where to get it | Notes |
|---|---|---|
| `GEMINI_API_KEY` | [Google AI Studio](https://aistudio.google.com/app/apikey) → API keys | Powers image gen, TTS, and chat fallback |
| `GROQ_API_KEY` | [console.groq.com](https://console.groq.com) → API keys | Fast chat completions; Gemini is used automatically if absent |

### Security — insecure dev fallback used if missing

| Secret | Where to get it | Notes |
|---|---|---|
| `JWT_SECRET` | Generate yourself | Any random string, 32+ characters minimum |

### Optional — feature degraded if missing

| Secret | Notes |
|---|---|
| `CEO_RECOVERY_KEY` | Emergency admin account reset key |
| `SESSION_SECRET` | Session cookie signing; random value used per process if absent |

---

## Environment Setup

### On Replit (recommended)

1. Open your Repl → **Secrets** tab (lock icon in sidebar)
2. Add each secret from the table above
3. Click **Restart** — the server validates all secrets on boot and logs clear instructions for anything missing

### Startup Validation

On every boot the server prints a validation banner:

```
========================
=== IB AI BOOT STRAP ===
========================
DATABASE:  ✓
GEMINI:    ✓
GROQ:      ✓
JWT:       ✓
SESSION:   ✓
RECOVERY:  ✗
AI MODE:   FULL
========================
```

- `✓` = secret present and valid
- `✗` = secret missing (see log for setup instructions)
- Missing **CRITICAL** secrets → `process.exit(1)` with instructions
- Missing **AI** secrets → server boots in **SAFE MODE** (AI routes return 503)
- Missing **SECURITY/OPTIONAL** → warning with setup hint, server runs normally

All secret definitions (including descriptions and setup hints) live in one place:

```
artifacts/api-server/src/lib/requiredSecrets.ts
```

---

## Migration Steps

Follow these steps when forking or importing this project into a new environment.

### 1. Install dependencies

```bash
pnpm install
```

### 2. Provision the database

Enable the Replit PostgreSQL integration — `DATABASE_URL` is set automatically.
Then push the schema:

```bash
pnpm run db:guard
```

This is idempotent — it only runs if tables are missing.

### 3. Add secrets

Add the secrets listed above to Replit Secrets. At minimum:

- `DATABASE_URL` (auto-set by Replit PostgreSQL)
- `GEMINI_API_KEY`
- `JWT_SECRET`

### 4. Set environment variables

```bash
# Already set by default — verify in Replit environment variables
CEO_USERNAME=ibaiceo
USE_POSTGRES_STORAGE=true
```

### 5. Start the app

The **IB AI Backend** and **IB AI Frontend** workflows start automatically.
Or manually:

```bash
# Backend (port 8099)
pnpm --filter @workspace/api-server run dev

# Frontend (port 5000)
pnpm --filter @workspace/ib-ai-v2 run dev
```

### 6. Run a health check

```bash
pnpm run health
```

Expected output:

```
✔ Workflows    backend :8099 | frontend :5000
✔ Database     connected (8/8 tables)
✔ API          ok (uptime Xs, gemini: ✔)
✔ Secrets      all present
System READY
```

---

## Key Commands

| Command | Purpose |
|---|---|
| `pnpm run health` | Quick one-pass system health check |
| `pnpm run guard` | Validate project state (read-only) |
| `pnpm run guard:fix` | Auto-fix: install packages + push schema |
| `pnpm run db:guard` | Push schema only if tables are missing |
| `pnpm run typecheck` | Full TypeScript check across all packages |
| `pnpm run build` | Typecheck + build all packages |

---

## Architecture

```
artifacts/
├── api-server/          Express 5 backend (port 8099)
│   └── src/
│       ├── lib/
│       │   ├── requiredSecrets.ts   ← single source of truth for all env vars
│       │   ├── env.ts               ← provider health logging
│       │   ├── geminiEnv.ts         ← Gemini key resolver
│       │   └── token.ts             ← JWT signing / verification
│       ├── bootstrap/
│       │   ├── envBootstrap.ts      ← startup validation (runs once, cached)
│       │   └── bootstrapCache.ts    ← ensures validation runs exactly once
│       ├── routes/                  ← all API routes under /api/*
│       └── services/                ← AI, image, TTS, chat
└── ib-ai-v2/            React + Vite frontend (port 5000)
lib/
├── db/                  Drizzle ORM schema + migrations
├── api-spec/            OpenAPI spec + Orval codegen config
└── api-client-react/    Generated React hooks
```

---

## What Lives Where

| Concern | File |
|---|---|
| All required env vars | `artifacts/api-server/src/lib/requiredSecrets.ts` |
| Startup validation logic | `artifacts/api-server/src/bootstrap/envBootstrap.ts` |
| Validation result cache | `artifacts/api-server/src/bootstrap/bootstrapCache.ts` |
| Provider health logging | `artifacts/api-server/src/lib/env.ts` |
| DB schema | `lib/db/src/schema/` |
| Health check script | `scripts/health-check.cjs` |
