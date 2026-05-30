---
name: CEO password persistence bug
description: Root cause and fix for recovery-reset passwords not surviving logout/restart — UUID divergence between users.json and PostgreSQL.
---

## The Rule
`updatePasswordHashInDbOnly` must always sync the in-memory store after writing to PG. `repairCeoAccount()` must reconcile UUID divergence between JSON fallback and PG at startup.

**Why:** Two failure modes existed:
1. `loadUserStore()` can fall back to JSON if PG is slow at startup. The JSON CEO had a different UUID (`d6a2c451`) than the PG CEO (`707aa190`). Recovery reset then calls `pgGetUserById(jsonUUID)` → null → silently returns false → 500.
2. Even in the normal path, not syncing memory after `pgUpdatePasswordHashOnly` meant `pgPersistAllUsers` (triggered by any `scheduleSave()`) could INSERT the CEO with the old in-memory hash if the PG row was ever absent.

**How to apply:**
- `updatePasswordHashInDbOnly` (userStore.ts): after `pgUpdatePasswordHashOnly(effectiveUserId, newHash)` succeeds, always set `memUser.passwordHash = newHash`. Also includes UUID reconciliation: if `pgGetUserById(userId)` returns null, fall back to `pgGetUserByUsername` and resync the in-memory entry to the PG UUID before proceeding.
- `repairCeoAccount()` (userStore.ts): after finding the CEO in memory, if PG is enabled, call `pgGetUserByUsername(ceoUsername)` — if the IDs differ, delete the stale JSON entry, insert the PG-sourced entry, and call `scheduleSave()`.
- `users.json` should contain the same UUID as PG (currently `707aa190-88cb-4300-87dc-65f7f597d94d`).
