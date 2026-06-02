---
name: Gemini image quota and model notes
description: Image editing models all have limit:0 on free tier; requires billing. normalizeAIError bugs fixed.
---

## Image Editing Model
- Model: `gemini-2.5-flash-image` (v1beta API, generateContent)
- `gemini-2.0-flash-exp` is NOT in v1beta — returns 404 (removed)
- All image gen models (`gemini-2.5-flash-image`, `gemini-3.1-flash-image-preview`, etc.) have `limit: 0` on free tier — billing required at ai.google.dev

**Why:** Image generation via Gemini requires a paid API key plan. The code is correct; this is an account-level constraint.

**How to apply:** When image edit fails with `provider_not_configured`, tell user to enable billing on their Gemini API key.

## normalizeAIError Bugs Fixed
1. `lower.includes("rate")` matched `"generateContent"` (gene-RATE-content) → changed to explicit phrases: "rate limit", "rate-limit", "ratelimit", "too many requests", "resource_exhausted", "429", "quota"
2. `"limit: 0"` quota errors (billing not enabled) were classified as `rate_limit` → now detects `lower.includes("limit: 0") && (quota|resource_exhausted)` → `provider_not_configured` (prioritized before rate_limit check)
