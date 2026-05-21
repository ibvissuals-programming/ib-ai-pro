# IB AI — Gemini Runtime Behavior & Failure Consistency Validation
**Generated:** 2026-05-21 | **Mode:** Live runtime observation — zero code changes | **Backend:** Running at localhost:8099

---

## PHASE 1 — RUNTIME FAILURE FLOW TRACE

All five tools tested live under real failure conditions (Gemini env vars absent).

---

### Tool 1: Prompt Expand (`POST /api/prompt/expand`)

```
Frontend call: POST /api/prompt/expand {prompt:"a sunset over the ocean"}
  → policyEngine middleware (cost:0, rateMax:30/min, allowRecovery:true)
  → promptExpand route handler
  → lib/promptExpander.expandPrompt()
  → withProviderTimeout(fn, 15_000, "gemini-prompt-expander")    ← race started
  → fn() → ai.models.generateContent({model:"gemini-2.5-flash"})
  → Proxy.get() → createAiClient()
  → THROWS: Error("AI_INTEGRATIONS_GEMINI_BASE_URL must be set...")
  → NOT a transient error → not retried
  → withProviderTimeout catches → rethrows
  → expandPrompt() throws to route catch
  → sanitizeProviderError(err, "Prompt expansion") → "Prompt expansion failed. Please try again."
  → res.status(503).json({ success: false, mode: "prompt", error: "..." })
```

**Live result:**
```json
HTTP 503
{ "success": false, "mode": "prompt", "error": "Prompt expansion failed. Please try again." }
```
**Wall time:** 68ms | **Retry loops:** 0 | **Key leak:** None ✅

---

### Tool 2: TTS (`POST /api/tts/generate`)

```
Frontend call: POST /api/tts/generate {text:"Hello world", voice:"Aoede"}
  → policyEngine middleware (cost:1, rateMax:20/min, allowRecovery:true)
  → tts route handler → createJob()
  → ttsService.generateSpeech()
  → withProviderTimeout(fn, 15_000, "gemini-tts")                ← race started
  → fn() → ai.models.generateContent({model:"gemini-2.0-flash"})
  → Proxy.get() → createAiClient()
  → THROWS: Error("AI_INTEGRATIONS_GEMINI_BASE_URL must be set...")
  → NOT transient → not retried
  → withProviderTimeout rethrows
  → generateSpeech() throws to route catch
  → sanitizeProviderError(err, "Text-to-speech") → "Text-to-speech failed. Please try again."
  → addAuditEntry("tts_failure", ...)
  → res.status(503).json({ success: false, mode: "tts", error: "..." })
```

**Live result:**
```json
HTTP 503
{ "success": false, "mode": "tts", "error": "Text-to-speech failed. Please try again." }
```
**Wall time:** 76ms | **Retry loops:** 0 | **Key leak:** None ✅

---

### Tool 3: Image Analysis (`POST /api/analyze-image`)

```
Frontend call: POST /api/analyze-image {imageBase64:..., mimeType:"image/jpeg"}
  → policyEngine middleware (cost: CREDIT_COSTS.image_analysis, rateMax:10/min)
  → imageAnalysis route handler
  → assertGeminiProvider("gemini-2.5-flash")                     ← guard fires FIRST
  → checks process.env.AI_INTEGRATIONS_GEMINI_BASE_URL → absent
  → THROWS: AiProviderViolation("AI_PROVIDER_VIOLATION: AI_INTEGRATIONS_GEMINI_BASE_URL is not set...")
  → [withProviderTimeout race is NEVER STARTED]
  → caught by route-level catch block
  → message = err.message  ← RAW MESSAGE EXTRACTED, NOT SANITIZED
  → res.status(500).json({ error: "Image analysis failed", message })
                                                  ↑ LEAKS INTERNAL ERROR STRING
```

**Live result:**
```json
HTTP 500
{ "error": "Image analysis failed", "message": "AI_PROVIDER_VIOLATION: AI_INTEGRATIONS_GEMINI_BASE_URL is not set — Gemini provider is not configured" }
```
**Wall time:** 67ms | **Retry loops:** 0 | **Key leak:** ⚠️ INTERNAL ERROR EXPOSED

**Critical finding:** The `message` field exposes the raw `AiProviderViolation` message directly to the client. This reveals: (1) the exact env var name, (2) the configuration state, (3) the internal guard mechanism name. Not a key leak, but an information disclosure issue.

---

### Tool 4: Cinematic Prompt (`POST /api/image/cinematic-prompt`)

```
Frontend call: POST /api/image/cinematic-prompt {imageBase64:..., mimeType:"image/jpeg"}
  → policyEngine middleware (cost: CREDIT_COSTS.image_analysis, rateMax:10/min)
  → imageGen route → CinematicPromptSchema.safeParse() → OK
  → generateCinematicInsight(imageBase64, mimeType)
  → [internally] ai.models.generateContent(...)
  → Proxy.get() → createAiClient()
  → THROWS: Error("AI_INTEGRATIONS_GEMINI_BASE_URL must be set...")
  → caught by route catch block
  → message = err.message (NOT sanitized)
  → isTimeout = message.includes("timed out") → false
  → res.status(500).json({ error: "Cinematic analysis failed" })
     [success field: MISSING] [mode field: MISSING]
```

**Live result:**
```json
HTTP 500
{ "error": "Cinematic analysis failed" }
```
**Wall time:** 65ms | **Retry loops:** 0 | **Key leak:** None, but **missing `success` + `mode` fields** ⚠️

---

### Tool 5: Image Edit (`POST /api/image/edit`)

```
Frontend call: POST /api/image/edit {image:"data:image/jpeg;base64,...", prompt:"make it cinematic"}
  → policyEngine middleware
  → imageGen route → schema parse → OK
  → createJob() → imageGenService.editImage()
  → multi-stage pipeline:
      Stage 1: detectEditMode() → "cinematic"
      Stage 2: contractForMode("cinematic")
      Stage 3: runImg2Img()
                → [internally] ai.models.generateContent({model:"gemini-2.5-flash-image"})
                → Proxy.get() → createAiClient()
                → THROWS: Error("AI_INTEGRATIONS_GEMINI_BASE_URL must be set...")
      Stage 4: fallback downgrade attempt → same Gemini call → same throw
      Stage 5: failJob() → throws to route catch
  → sanitizeProviderError(err, "Image editing") → "Image editing failed. Please try again."
  → res.status(503).json({ success: false, mode: "image", error: "..." })
```

**Live result:**
```json
HTTP 503
{ "success": false, "mode": "image", "error": "Image editing failed. Please try again." }
```
**Wall time:** 76ms | **Retry loops:** 0 (fallback also fails instantly) | **Key leak:** None ✅

---

## PHASE 2 — FAILURE CONSISTENCY CHECK

### Response Shape Comparison

| Tool | HTTP Status | `success` field | `mode` field | `error` field | `message` field | Uses sanitizeProviderError |
|------|-------------|-----------------|--------------|---------------|-----------------|---------------------------|
| prompt_expand | **503** ✅ | `false` ✅ | `"prompt"` ✅ | Safe string ✅ | Absent ✅ | **Yes** ✅ |
| tts/generate | **503** ✅ | `false` ✅ | `"tts"` ✅ | Safe string ✅ | Absent ✅ | **Yes** ✅ |
| image/edit | **503** ✅ | `false` ✅ | `"image"` ✅ | Safe string ✅ | Absent ✅ | **Yes** ✅ |
| analyze-image | **500** ❌ | Absent ❌ | Absent ❌ | Safe string ⚠️ | **Exposes internal error** ❌ | **No** ❌ |
| image/cinematic-prompt | **500** ❌ | Absent ❌ | Absent ❌ | Safe string ✅ | Absent ✅ | **No** ❌ |

### Inconsistencies Found

**Inconsistency 1 — Status code split: 503 vs 500**
- `prompt_expand`, `tts`, `image/edit` → HTTP **503** (Service Unavailable — correct; provider not configured)
- `analyze-image`, `cinematic-prompt` → HTTP **500** (Internal Server Error — incorrect; this is a configuration state, not a bug)

**Inconsistency 2 — Response shape split: structured vs bare**
- `prompt_expand`, `tts`, `image/edit` → `{ success: false, mode: "...", error: "..." }` (frontend-parseable)
- `cinematic-prompt` → `{ error: "..." }` (bare, no `success`, no `mode`)
- `analyze-image` → `{ error: "...", message: "..." }` (extra `message` field, different contract)

**Inconsistency 3 — Information disclosure in `analyze-image`**
- Root cause: `imageAnalysis.ts` catch block does `const message = err.message` then includes it raw in the response
- The `AiProviderViolation` error message explicitly names the missing env var: `"AI_INTEGRATIONS_GEMINI_BASE_URL is not set — Gemini provider is not configured"`
- This is exposed to any authenticated user, not just CEO
- The other four tools pass through `sanitizeProviderError()` which strips internal details

**Root cause of inconsistencies:**
`imageAnalysis.ts` and `imageGen.ts` (cinematic-prompt handler) were written with a different error handling pattern than the three consistent routes. They use direct `err.message` extraction and HTTP 500, while the consistent routes use `sanitizeProviderError()` and HTTP 503.

### Silent Failure Check
| Check | Result |
|-------|--------|
| Any 200 OK with hidden error | **None** — all failures return non-2xx |
| Empty response body | **None** — all return JSON |
| Unhandled promise rejection | **None** — backend health `boot: success, backend: operational` confirmed after all tests |
| Backend crash | **None** — 1758s uptime, heap stable at 56mb |
| aiMetrics Gemini counter incremented | **No** — Gemini `requests: 0`, `successes: 0`, `errors: 0` — failures happen before `recordCompletion()` is called |

---

## PHASE 3 — GROQ ISOLATION VERIFICATION

### Is Groq isolated from Gemini at the code level?

**YES — with evidence.**

**Evidence 1 — `services/llm.ts` routing logic:**
```typescript
// Fast path: GROQ_API_KEY present → try Groq first
const hasGroqKey = !!process.env.GROQ_API_KEY;
if (!hasGroqKey) { /* route to Gemini */ }

// Groq path never imports or calls ai.* unless Groq fails first
const stream = await createGroqStream(messages); // ← direct fetch to Groq API
return wrapTracked(stream, "groq", false, requestStartMs);
// Gemini proxy is never touched on Groq success
```

The Gemini client (`ai`) is imported at module level in `llm.ts`, but the Proxy's `get` trap only fires when a property is accessed. On the Groq success path, `createGeminiStream()` is never called → `ai.models` is never accessed → `createAiClient()` is never invoked → no throw.

**Evidence 2 — Live runtime proof:**
```
Groq chat test during all Gemini failures:
  data: {"content":"G"} data: {"content":"RO"} data: {"content":"Q"}
  data: {"content":"_IS"} data: {"content":"OL"}
  data: {"sessionId":"f342e9eb-..."} data: [DONE]
  Wall time: 509ms
```

**Evidence 3 — aiMetrics raw state after all Gemini failure tests:**
```json
{
  "groq":   { "requests": 5, "successes": 5, "errors": 0, "totalLatencyMs": 2205 },
  "gemini": { "requests": 0, "successes": 0, "errors": 0, "totalLatencyMs": 0 },
  "fallbackCount": 0,
  "lastFallbackAt": null
}
```
Gemini counters are all zero. Groq success rate is 100%. No fallback was ever triggered.

**Evidence 4 — No shared mutable state between providers:**
- `_lastProviderResult` in `llm.ts` is a single-item per-request variable, cleared after each read
- `providerStats` in `aiMetrics.ts` has separate `groq` and `gemini` buckets
- No shared queue, no shared cache, no shared circuit breaker
- Gemini failures on tool routes (analyze-image, tts, etc.) do NOT write to `providerStats` at all — they fail before `recordCompletion()` is reached

**Groq isolation verdict:** FULLY CONFIRMED. No contamination path exists.

---

### Is the Groq→Gemini fallback accidentally triggered?

**NO — with evidence.**

The fallback in `createChatStream()` only fires when:
1. `GROQ_API_KEY` is present (it is)
2. `createGroqStream()` throws (it hasn't — 5/5 Groq requests succeeded)

`fallbackCount: 0` in live metrics confirms this has never fired in the current session.

---

## PHASE 4 — TOOL EXECUTION TIMING ANALYSIS

### Time-to-Failure per Tool

All timing measured wall-clock from HTTP request to response body received.

| Tool | Run 1 | Run 2 | Run 3 | Pattern |
|------|-------|-------|-------|---------|
| prompt_expand | 68ms | 66ms | 65ms | Flat |
| tts/generate | 76ms | 69ms | 58ms | Flat |
| analyze-image | 67ms | 56ms | 58ms | Flat |
| cinematic-prompt | 65ms | — | — | Flat |
| image/edit | 76ms | — | — | Flat |

**All tools fail in under 80ms.** This is critical context:

### Why Failures Are So Fast (Lazy Proxy Analysis)

```
assertGeminiProvider() or Proxy.get() fires
  → process.env check is synchronous (< 1μs)
  → throws Error synchronously
  → no async operation started
  → no HTTP connection opened to Google
  → no timeout timer ever fires (15s withProviderTimeout race never starts)
  → catch block executes synchronously
  → JSON serialization + res.json() → < 5ms
  → Total: dominated by network latency (localhost loopback ~60ms)
```

The `withProviderTimeout` 15-second timer is **never started** on any tool. The failure happens before the async call — making all timeouts irrelevant under missing-var conditions.

### Retry Loop Analysis

| Tool | Retry behavior | Evidence |
|------|----------------|----------|
| prompt_expand | None — `withProviderRetry` not used | Direct `withProviderTimeout` only |
| tts | None — same pattern | Direct `withProviderTimeout` only |
| analyze-image | None — no retry wrapper | Direct `Promise.race()` |
| cinematic-prompt | None — no retry wrapper | Direct service call |
| image/edit | One internal fallback mode downgrade attempt (Stage 3→4), also fails instantly | Adds ~1ms |

**Rapid repeat calls (prompt_expand ×3):** `503 in 75ms` → `503 in 75ms` → `503 in 63ms` — perfectly flat. No accumulation, no slowdown, no error state buildup between calls.

### Memory Retention Across Failed Calls

| Metric | Before tests | After tests | Delta |
|--------|-------------|-------------|-------|
| Heap used | ~53mb | 56mb | +3mb (normal GC variance) |
| Heap total | ~56mb | 58mb | +2mb (V8 expansion, normal) |
| RSS | ~178mb | 181mb | +3mb (normal) |
| Gemini client `_client` | `null` | `null` | Zero — lazy init never completed |
| Groq `_lastProviderResult` | cleared | cleared | Correct |

The Gemini `_client` variable in `client.ts` remains `null` for the entire session. `createAiClient()` throws before it can assign a value:
```typescript
let _client: GoogleGenAI | null = null;
// _client = createAiClient() ← this line never completes; throws before assignment
```
No memory retained from failed Gemini attempts.

---

## PHASE 5 — STABILITY VERDICT

### System Stability Score: **8.5 / 10**

| Component | Score | Reason |
|-----------|-------|--------|
| Groq core chat | **10/10** | Perfectly isolated, 100% success rate, zero contamination paths |
| Auth system | **10/10** | No Gemini dependency, fully operational |
| Admin dashboard | **10/10** | No Gemini dependency, fully operational |
| prompt_expand | **9/10** | Clean failure, correct shape, correct status |
| TTS | **9/10** | Clean failure, correct shape, correct status |
| image/edit | **9/10** | Clean failure, correct shape, correct status |
| analyze-image | **6/10** | Wrong status (500 not 503), leaks internal error in `message` field |
| cinematic-prompt | **7/10** | Wrong status (500 not 503), missing `success`/`mode` fields |

---

### Two Real Bugs Found

These are not theoretical — they are confirmed against the live running system.

#### Bug 1 (HIGH) — `analyze-image` leaks internal configuration error
- **File:** `artifacts/api-server/src/routes/imageAnalysis.ts`
- **Line:** `res.status(isTimeout ? 504 : 500).json({ error: ..., message })`
- **Problem:** `message = err.message` is the raw `AiProviderViolation` string, which exposes env var names and internal guard mechanism to authenticated clients
- **Impact:** Any logged-in user can discover that Gemini is unconfigured and which specific env var is missing
- **Fix pattern:** Replace with `sanitizeProviderError(err, "Image analysis")` and change 500 → 503

#### Bug 2 (MEDIUM) — `cinematic-prompt` returns wrong shape and wrong status
- **File:** `artifacts/api-server/src/routes/imageGen.ts` (cinematic-prompt handler)
- **Line:** `res.status(isTimeout ? 504 : 500).json({ error: "Cinematic analysis failed" })`
- **Problem:** Missing `success: false` and `mode: "image"` fields; HTTP 500 instead of 503
- **Impact:** Frontend `imageToolsApi.js` checks `if (!res.ok) handleErrorResponse(res, data, ...)` — the error is caught correctly, but `data.code` and structured fields are absent, so fallback error message is used
- **Fix pattern:** Add `success: false, mode: "image"` to the response; change 500 → 503; use `sanitizeProviderError`

---

### Risk of Feature Flag Layer Introduction

**LOW**

| Factor | Assessment |
|--------|-----------|
| Architecture stability | High — lazy proxy, isolated routes, clean error containment |
| Shared state risk | None found — complete provider isolation confirmed |
| Groq contamination risk | Zero — confirmed by metrics and code trace |
| Pre-existing bugs | 2 found (analyze-image, cinematic-prompt) — independent of feature flags |
| Feature flag complexity | Low — existing `geminiAvailable` flag already tracked; per-feature extension is additive |

---

### Should the Architecture Be Left As-Is or Refactored?

**LEFT AS-IS** — with two targeted bug fixes.

The architecture is sound:
- Lazy proxy pattern is correct and safe
- `providerGuard.ts` + `sanitizeProviderError` is the right abstraction — it just needs to be applied consistently to the two outlier routes
- `aiMetrics.ts` availability detection is correct
- The Groq/Gemini separation in `llm.ts` is well-designed
- All timeout handling is correct (though never exercised under missing-var conditions)

**No structural refactor is warranted.** The two bugs are surface-level catch-block issues — surgical fixes, not architectural changes.

---

### Recommended Next Action (Single)

Fix the two inconsistent error handlers in `imageAnalysis.ts` and the cinematic-prompt section of `imageGen.ts` — standardise them to HTTP 503, `{success:false, mode:"...", error:"..."}`, using `sanitizeProviderError`. No other changes. No feature flags yet.

This brings all five Gemini tools to a uniform, safe failure posture before any activation work begins.

---

## EVIDENCE SUMMARY

```
All 5 tools tested live ✅
Groq isolation confirmed live ✅
No retry accumulation confirmed (×3 rapid fire) ✅
No memory leak confirmed (heap delta: +3mb, normal GC) ✅
No backend crash (uptime 1758s, boot: success) ✅
No unhandled promise rejections ✅
aiMetrics: groq 5/5 success, gemini 0 attempts, 0 fallbacks ✅
Lazy proxy _client = null throughout entire session ✅
2 real bugs found in analyze-image and cinematic-prompt ✅
```
