# IB AI — Deployment Guide

## First Time Setup

Follow these steps **in order** after a fresh import from GitHub or a new Replit fork.
Do not skip steps — each one depends on the previous.

### Step 1 — Add Critical Secrets

Go to **Replit → Tools → Secrets** and add these before starting anything:

| Secret | Where to get it | Blocks startup if missing |
|---|---|---|
| `GEMINI_API_KEY` | [Google AI Studio](https://aistudio.google.com/apikey) — free | Yes |
| `DATABASE_URL` | Auto-provisioned by Replit PostgreSQL integration | Yes |
| `GROQ_API_KEY` | [console.groq.com](https://console.groq.com) → API Keys — free tier | No (chat falls back to Gemini) |
| `JWT_SECRET` | Any secure random string (32+ chars) | No (insecure dev default used) |
| `CEO_PASSWORD` | Choose a strong password for the `ibaiceo` admin account | No (temp password logged at startup) |
| `CEO_RECOVERY_KEY` | Any secure random string (32+ chars) | No (recovery disabled) |

**Verify secrets are loaded:**
```
pnpm run secrets:check
```
All critical items must show ✅ before proceeding.

---

### Step 2 — Install Dependencies

```
pnpm install
```

Skip if `node_modules/.pnpm` and `pnpm-lock.yaml` already exist — they are present in the repo.

---

### Step 3 — Push Database Schema

```
pnpm run db:guard
```

This creates the 8 required tables if they don't exist. Safe to run on an empty or partially-migrated database. Will skip entirely if all tables are already present.

Required tables: `users`, `image_history`, `admin_logs`, `chat_sessions`, `chat_messages`, `user_memory`, `image_jobs`, `usage_analytics`

---

### Step 4 — Start Workflows

Start both workflows from the Replit Workflows panel:

| Workflow | Command | Port |
|---|---|---|
| **IB AI Backend** | `node scripts/kill-port.cjs 8080; ...pnpm --filter @workspace/api-server run dev` | 8099 |
| **IB AI Frontend** | `node scripts/kill-port.cjs 5000; ...pnpm --filter @workspace/ib-ai-v2 run dev` | 5000 |

Wait for both to report healthy in their console output before proceeding.

---

### Step 5 — Verify Health

```
pnpm run health
```

Expected output:
```
✔ Workflows    backend :8099 | frontend :5000
✔ Database     connected (8/8 tables)
✔ API          ok (uptime Xs, groq: ✔, gemini: ✔)
✔ Secrets      all present
System READY
```

---

### Step 6 — Run Pre-Publish Smoke Test

```
pnpm run pre-publish
```

This runs a full end-to-end check: server health, DB connectivity, real CEO login, authenticated Groq chat, image generation, and Cinematic Enhancement. All checks must pass before deploying.

---

### Step 7 — Deploy

Click **Publish** in the Replit toolbar, or use:
```
pnpm run pre-publish && echo "Ready to deploy"
```

The app will be available at `https://ib-ai-pro--innovativeib.replit.app`.

---

## Chat Provider Architecture

Chat requests use a two-provider fallback chain:

```
POST /api/chat
  └─ GROQ_API_KEY present?
       YES → Groq primary (llama-3.1-8b-instant)
               └─ Any Groq failure → Gemini fallback (gemini-2.5-flash)
                    └─ Both fail → error returned to user
       NO  → Gemini direct (gemini-2.5-flash, 2 retries)
```

**Why this matters:**
- Gemini's free tier allows ~20 chat requests/day on `gemini-2.5-flash`
- Groq's free tier allows ~14,400 requests/day on `llama-3.1-8b-instant`
- With `GROQ_API_KEY` set, the daily quota effectively becomes Groq's limit
- Gemini is still required for image generation, TTS, prompt expansion, and cinematic analysis — it is not replaced, only moved to chat fallback role

---

## Non-Chat AI Features

| Feature | Provider | Required Secret | Fallback |
|---|---|---|---|
| Chat | Groq (primary) | `GROQ_API_KEY` | Gemini |
| Chat fallback | Gemini | `GEMINI_API_KEY` | None |
| Image generation | Gemini | `GEMINI_API_KEY` | None |
| TTS | Gemini | `GEMINI_API_KEY` | None |
| Prompt expansion | Gemini | `GEMINI_API_KEY` | None |
| Cinematic analysis | Gemini | `GEMINI_API_KEY` | None |

---

## After Every Reimport from GitHub

Re-add **all** secrets — Replit does not persist secrets across forks or reimports.

```
pnpm run secrets:check   # see what's missing
# add missing secrets in Replit → Tools → Secrets
pnpm run db:guard        # re-push schema if tables are gone
pnpm run health          # verify everything is up
```

---

## Troubleshooting

### "Service temporarily unavailable" on login
Backend is still starting up. Wait 10–15 seconds and retry. The frontend retries automatically for up to 6 seconds.

### Chat returns errors immediately
1. Check `GROQ_API_KEY` is set: `pnpm run secrets:check`
2. Check Groq quota at [console.groq.com](https://console.groq.com)
3. If Groq is exhausted, Gemini fallback activates automatically — check `GEMINI_API_KEY` is present

### Image generation fails
`GEMINI_API_KEY` is required for all image features. Verify it is set and the key is valid.

### CEO account not accessible
If `CEO_PASSWORD` was not set before first startup, a temporary password was logged once at startup. Check the IB AI Backend workflow console output for the bootstrap log line. To reset: set `CEO_PASSWORD` in Secrets and restart the backend.

### Database tables missing after reimport
```
pnpm run db:guard
```
This is safe to run at any time — it will only push schema changes if tables are missing.

### Pre-publish check fails on chat test
The smoke test uses `CEO_PASSWORD` from the environment. Ensure it is set in Replit Secrets before running `pnpm run pre-publish`.
