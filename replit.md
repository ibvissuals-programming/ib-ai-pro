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

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

## Artifacts

### IB AI v2 (`artifacts/ib-ai-v2`)
- **Kind**: React + Vite (frontend-only, no backend)
- **Preview path**: `/`
- **Description**: AI assistant + prompt engineering SaaS prototype
- **Auth**: Mock auth via localStorage (`ib_users`, `ib_session`)
- **Persistence**: All data in localStorage (no external APIs or database)

#### Architecture
```
src/
├── auth/
│   ├── authService.js      — signup/login/logout/session (localStorage)
│   └── ProtectedRoute.jsx  — redirects unauthenticated users to /login
├── components/
│   ├── Header.jsx          — app bar with mode badge + logout
│   ├── ChatWindow.jsx      — scrollable message list + typing indicator
│   ├── MessageBubble.jsx   — user/AI bubbles with copy button
│   └── InputBox.jsx        — textarea + send/clear buttons
├── pages/
│   ├── Login.jsx           — sign in page
│   ├── Signup.jsx          — create account page
│   └── ChatApp.jsx         — main chat interface
├── services/
│   └── aiEngine.js         — detects chat vs prompt engineering mode, generates responses
├── hooks/
│   ├── useAuth.js          — current session state
│   └── useChat.js          — message history per user, localStorage persistence
├── utils/
│   └── storage.js          — localStorage abstraction
└── App.tsx                 — wouter routing
```

#### Routes
- `/` → redirect to `/chat`
- `/login` — sign in
- `/signup` — create account
- `/chat` — protected main chat (requires auth)

#### Prompt Engineering Mode
Auto-triggered when input contains: "generate a prompt", "improve this prompt", "optimize prompt", "make this better", "improve this", "optimize this"

Output format:
1. Improved Prompt
2. Why This Is Better
3. Optional Variations

#### SaaS Upgrade Path
- Auth → replace `authService.js` with Firebase/Supabase SDK
- AI → replace `aiEngine.js` with OpenAI/Claude API calls
- Persistence → replace `storage.js` with database calls
- Payments → add Stripe checkout alongside existing flow
