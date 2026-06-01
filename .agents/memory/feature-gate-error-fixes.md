---
name: Feature gate & error classification fixes
description: Root causes and fixes for TTS/Video/ImageGen/ImageEdit failures — misclassified error codes and wrong feature gates.
---

## TTS — `invalid_request` instead of `feature_disabled`
**Root cause**: Gemini throws `"Model does not support the requested response modalities: audio"` (INVALID_ARGUMENT, 400). The `isModelUnsupported` check in `routes/tts.ts` only matched `"UNSUPPORTED_MODEL"` and `"not supported"` — neither matches `"does not support"` (word order differs).

**Fix**: Added `"does not support"`, `"response modalities"`, `"responseModalities"` to the `isModelUnsupported` check. TTS now returns 501 `feature_disabled` cleanly.

**Why**: `gemini-2.0-flash` with `responseModalities: ["AUDIO"]` is not available on the free-tier GEMINI_API_KEY.

## Video — fires async job instead of blocking early
**Root cause**: `isVideoEnabled()` in `videoService.ts` only called `isGeminiConfigured()`. Since GEMINI_API_KEY is set, `isVideoEnabled()` = `true` even when `VIDEO_ENABLED` env var is absent. Job was created, hit Veo API, got `NOT_FOUND 404`, and returned async `provider_not_configured`.

**Fix**: `isVideoEnabled()` now requires BOTH `isGeminiConfigured() && process.env.VIDEO_ENABLED === "true"`. Route gate catches it immediately → 501 `feature_disabled`. Also fixed `systemPolicy.ts` to return `code: "feature_disabled", httpStatus: 501` (was `provider_not_configured, 503`). Fixed TS type error: `"feature_blocked"` is not a valid `SystemEventType` — use `"provider_blocked"`.

**Why**: Veo requires separate API key provisioning beyond just a GEMINI_API_KEY.

## Image Generation — consecutive calls fail with wrong error code
**Root cause**: Pollinations (free FLUX provider) rate-limits consecutive calls from the same server IP. The timeout path threw `"Image generation temporarily unavailable"` → `provider_unavailable`. The 429/503 path also mapped to `provider_unavailable`.

**Fix**:
- Added 5-second cooldown between Pollinations calls, measured from last COMPLETED response (not request start).
- Timeout path now throws `"timed out"` → classifies as `timeout` code.
- 429 or 503 from Pollinations throws `"rate limit"` → classifies as `rate_limit` code.

**Note**: Pollinations is a free provider with no SLA. Under heavy load it times out. This is an external constraint, not fixable in backend code. The cooldown helps normal-load scenarios.

## Image Edit — `invalid_request` for small test images
**Root cause**: `runImg2Img()` in `imageGenService.ts` rejects images where `base64.length < 1000`. A 1×1 pixel test PNG produces only ~86 base64 chars → throws `"Invalid image input — image data too short."` → `normalizeAIError` sees `"invalid"` → `invalid_request`. NOT a model access issue.

**Confirmed**: `gemini-2.5-flash-image` IS accessible on the current API key. With a 128×128 PNG (65820 b64 chars), the call reaches Gemini and returns `rate_limit` (from testing burst load), not a model-unavailable error.

## Key API key tier facts (verified via live tests)
- `gemini-2.0-flash` with `responseModalities: ["AUDIO"]` → NOT available (400 INVALID_ARGUMENT)
- `gemini-2.5-flash-image` → IS available (rate-limited during testing, not blocked)
- Veo (`veo-002`) → NOT available (404 NOT_FOUND)
- Pollinations/FLUX → Available but rate-limits consecutive calls; ~5s cooldown needed
