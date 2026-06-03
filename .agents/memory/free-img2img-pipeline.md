---
name: Free image editing pipeline
description: Image editing replaced from billing-required Gemini img2img to free two-step pipeline. Architecture and key constraints.
---

## Rule
Image editing MUST NOT use `gemini-2.5-flash-image` with `responseModalities: ["IMAGE"]` — this requires Google billing (limit: 0 on free tier).

**Free replacement:** `gemini-2.5-flash` (vision → text description, free) + Pollinations FLUX (text → image, free).

**Why:** `gemini-2.5-flash-image` fails with `provider_not_configured` (RESOURCE_EXHAUSTED 429) on free tier. Both replacement providers are already in the codebase and confirmed accessible from Replit servers.

## How to apply
- `runFreeImg2Img()` in `imageGenService.ts` is the active function for image editing.
- The legacy `runImg2Img()` (Gemini img2img) is kept but never called — do NOT call it.
- `editImage()` uses a single-pass pipeline (`runFreePipeline`) with one retry on null. The old 3-stage pipeline is removed.
- `STAGE_TIMEOUT_MS = 95_000` (covers Gemini analysis ~30s + Pollinations ~65s).
- `PIPELINE_TIMEOUT_MS = 150_000` (single pass + buffer).
- `ModelUsed` type includes `"free-img2img"` (added to `imageJobManager.ts`).
- Route error system tag is `"image"` (not `"gemini-image"`).
- Trade-off: describe-and-regenerate (not pixel-level editing). Identity preserved at description level only.

## Do NOT revert
Reverting to the Gemini img2img model requires Google billing. Do not add `responseModalities: ["IMAGE"]` anywhere without confirming billing is enabled.

## Pollinations img2img availability
Confirmed: Pollinations `/feed` shows `"image":[]` for all public jobs — no img2img endpoint exists on Pollinations. All editing goes through Gemini vision analysis + Pollinations text-to-image.
