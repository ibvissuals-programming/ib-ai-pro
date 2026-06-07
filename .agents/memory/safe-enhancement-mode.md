---
name: Safe Enhancement Mode
description: Image edit pipeline that never throws — catches all Fal.ai failures and returns Gemini-powered suggestions instead of regenerating the image.
---

## The Rule
`runFreeImg2Img` must **never throw** for Fal.ai failures. All FAL errors (403, 402, exhausted balance, null response) are caught inside the function and redirected to `generateEnhancementSuggestions()`, which uses Gemini vision to return structured cinematic suggestions without modifying the original image.

**Why:** Fal.ai account can have $0 balance even when FAL_KEY is set (key present → `isFalConfigured()` returns true → FAL call attempted → 403). Prior to this fix, the throw propagated to the route's catch block, where `normalizeAIError` mapped unknown error text to `internal_error` → "An unexpected error occurred."

## Key Types
- `FreeImg2ImgResult = { kind: "image"; b64: string } | { kind: "enhancement"; data: EnhancementData }`
- `EnhancementData = { suggestions: string[]; colorGrade: string; lightingNotes: string; compositionNotes: string }`
- `EditResult` has optional enhancement fields: `enhancementMode?`, `suggestions?`, `colorGrade?`, `lightingNotes?`, `compositionNotes?`; `b64Image` is `""` when enhancement mode is active.

## How to Apply
- `runFreeImg2Img` wraps the `falImg2ImgFetch` call in try-catch; on any error → calls `generateEnhancementSuggestions()` → returns `{ kind: "enhancement", data }`.
- `runFreePipeline` checks `pipelineResult.kind`: "image" → `succeedEdit(b64, ...)`, "enhancement" → `succeedEnhancement(data, ...)`. No retry pass.
- Route (`imageGen.ts`): passes `enhancementMode`, `suggestions`, `colorGrade`, `lightingNotes`, `compositionNotes` through in the JSON response.
- Frontend (`imageToolsApi.js`): guard changed to `!data.b64Image && !data.enhancementMode` so enhancement responses aren't rejected.
- Frontend (`ImageTools.jsx`): `EnhancementPanel` component renders suggestions; `handleEdit` routes to `setEnhancementResult(res)` when `res.enhancementMode` is true.
- `normalizeAIError` updated: "exhausted balance" / "user is locked" / (fal + 402/403/credit) → `feature_disabled`, never `internal_error`.

## Safety net
`generateEnhancementSuggestions` is non-throwing — any Gemini failure falls back to `buildDefaultEnhancement(mode)` which returns hardcoded mode-appropriate suggestions. The enhancement path can never fail.
