# IB AI — Tool Layer Safe Activation Plan
**Generated:** 2026-05-21 | **Mode:** Analysis only — zero code changes | **Baseline:** v1.0

---

## PHASE 1 — ENV VAR DEPENDENCY TRACE

### How Gemini Vars Enter the System

The Gemini client (`lib/integrations-gemini-ai/src/client.ts`) uses a **lazy proxy** pattern:

```
export const ai = new Proxy({} as GoogleGenAI, {
  get(_target, prop) {
    if (!_client) { _client = createAiClient(); }  // ← throws here if vars missing
    ...
  }
});
```

`createAiClient()` throws immediately if either var is absent:
- `"AI_INTEGRATIONS_GEMINI_BASE_URL must be set..."`
- `"AI_INTEGRATIONS_GEMINI_API_KEY must be set..."`

**Critical behaviour:** The throw happens at **call time** (first property access on `ai`), NOT at module import time. This means:
- ✅ Server boots cleanly even when vars are missing — no crash on startup
- ✅ Groq chat is completely isolated — `llm.ts` imports `ai` but only calls it in `createGeminiStream()`, which is only entered on Groq failure
- ✅ Every Gemini-dependent route has its own try/catch — failures are contained per-feature

### Availability Detection (`lib/aiMetrics.ts`)

```typescript
const geminiConfigured = !!(
  process.env.AI_INTEGRATIONS_GEMINI_BASE_URL &&
  process.env.AI_INTEGRATIONS_GEMINI_API_KEY
);
```

This is evaluated **at read time** on every call to `getAiStatus()`. It is not cached. The moment both vars are present and the backend restarts, `geminiAvailable` flips to `true` in `/api/system/ai-status` with zero code changes.

---

### Feature Dependency Chains

#### TTS (`/api/tts/generate`)

```
POST /api/tts/generate
  └─ ttsService.generateSpeech()
       └─ withProviderTimeout(15_000, "gemini-tts")
            └─ ai.models.generateContent({ model: "gemini-2.0-flash", ... })
                 └─ Proxy → createAiClient()
                      └─ throws if AI_INTEGRATIONS_GEMINI_* missing
```

**Missing vars — what happens:**
- Proxy throws `Error: "AI_INTEGRATIONS_GEMINI_BASE_URL must be set..."`
- `withProviderTimeout` propagates the error (NOT a transient error, NOT retried)
- `generateSpeech()` throws
- Route catch block: `sanitizeProviderError(err, "Text-to-speech")` → `"Text-to-speech failed. Please try again."`
- Response: `HTTP 503 { success: false, mode: "tts", error: "Text-to-speech failed. Please try again." }`
- No crash, no key leak, no infinite loop

**What partially works without Gemini:**
- `GET /api/tts/voices` — returns voice list (no AI, always works) ✅

**What requires Gemini:**
- `POST /api/tts/generate` — audio generation only ❌
- `GET /api/tts/serve/:id` — only relevant if files were previously generated ❌

---

#### Prompt Expand (`/api/prompt/expand`)

```
POST /api/prompt/expand
  └─ lib/promptExpander.expandPrompt()
       └─ withProviderTimeout(15_000, "gemini-prompt-expander")
            └─ ai.models.generateContent({ model: "gemini-2.5-flash", ... })
                 └─ Proxy → createAiClient()
                      └─ throws if AI_INTEGRATIONS_GEMINI_* missing
```

**Missing vars — what happens:**
- Same chain as TTS
- Route returns: `HTTP 503 { success: false, mode: "prompt", error: "Prompt expansion failed. Please try again." }`
- Verified in live testing: exact error confirmed

**What partially works without Gemini:**
- `GET /api/prompt/categories` — returns category metadata (no AI, always works) ✅

**What requires Gemini:**
- `POST /api/prompt/expand` — expansion only ❌

---

#### Image Analysis (`/api/analyze-image`)

```
POST /api/analyze-image
  └─ imageAnalysis route
       └─ ai.models.generateContent({ model: "gemini-2.5-flash", ... })
            └─ Proxy → createAiClient()
                 └─ throws if AI_INTEGRATIONS_GEMINI_* missing
```

**Missing vars — what happens:**
- Route catch block handles → structured error response
- Frontend `classifyImageError()` maps to: `"Image analysis failed. Please check your connection and try again."`
- No crash, clean degradation

**What partially works:**
- Image file reading and validation in frontend (entirely client-side) ✅
- The upload UI still appears and accepts files ✅

---

#### Image Editing (`/api/image/edit`) and Cinematic Prompt (`/api/image/cinematic-prompt`)

```
POST /api/image/edit
  └─ imageGenService.editImage()
       └─ multi-stage pipeline:
            Stage 1: Gemini vision pre-analysis (optional — useCinematicAnalysis flag)
            Stage 2: runImg2Img() → ai.models.generateContent({ model: "gemini-2.5-flash-image" })
            Stage 3: fallback downgrade (portrait_safe → cinematic → creative)
                └─ Proxy → createAiClient()
                     └─ throws if AI_INTEGRATIONS_GEMINI_* missing

POST /api/image/cinematic-prompt
  └─ ai.models.generateContent({ model: "gemini-2.5-flash", vision })
       └─ same proxy chain
```

**Missing vars — what happens:**
- Pipeline fails at first Gemini call → `failJob()` → route returns structured error
- All three fallback modes also fail (same Gemini dependency)
- Response: `{ success: false, mode: "image", error: "..." }`

**What partially works without Gemini:**
- `POST /api/image/generate` (text-to-image via Pollinations — NO Gemini needed) ✅
- `GET /api/image/history` ✅
- `GET /api/image/contract` ✅

---

#### Chat Groq→Gemini Fallback (`/api/chat`, `services/llm.ts`)

```
POST /api/chat
  └─ createChatStream()
       └─ GROQ_API_KEY present? YES
            └─ createGroqStream() → try Groq first
                 SUCCESS → stream (current state, 100% working)
                 FAILURE → createGeminiStream()
                              └─ ai.models.generateContentStream()
                                   └─ Proxy → createAiClient()
                                        └─ throws if AI_INTEGRATIONS_GEMINI_* missing
```

**Missing vars — what happens (Groq failure scenario):**
- Groq fails (rate limit, outage, etc.)
- Fallback attempted → Gemini proxy throws → `createGeminiStream` throws
- `createChatStream` catches both failures → throws `"Both AI providers failed. Groq: ... Gemini: ..."`
- Chat route writes SSE error event: `{error:true, code:"Both AI providers failed..."}`
- Frontend `classifyStreamError()` maps to: `"Could not reach the AI. Please check your connection and try again."`
- Clean failure — no crash, no hang

**Current dormant risk:** Today Groq succeeds 100% of the time so fallback is never triggered. If Groq degrades, users would see a full chat failure instead of transparent recovery. This risk is resolved by activating Gemini.

---

## PHASE 2 — PARTIAL ACTIVATION SIMULATION

### Simulation: Both Gemini Vars Set, Backend Restarted

| Feature | Activates? | Failure Mode | Silent? | UI Impact | Classification |
|---------|-----------|--------------|---------|-----------|----------------|
| Prompt expand | ✅ CORRECT | Rate limit → 503 clean | No | None (no UI component calls it yet) | **SAFE** |
| Prompt categories | ✅ (already working) | — | — | — | **SAFE** |
| TTS generate | ✅ CORRECT | Audio model errors → 503 clean | No | No existing button; needs UI wiring | **SAFE** |
| TTS voices | ✅ (already working) | — | — | — | **SAFE** |
| Image analysis | ✅ CORRECT | Vision errors → structured error | No | Upload flow already connected in InputBox | **SAFE** |
| Image editing (img2img) | ✅ CORRECT with caveats | Complex pipeline; mode-specific errors | Possible for mode fallbacks | Edit flow already connected in useChat | **PARTIAL** |
| Cinematic prompt | ✅ CORRECT | Vision errors → structured error | No | Already connected in imageToolsApi | **SAFE** |
| Chat Groq→Gemini fallback | ✅ CORRECT (dormant activation) | Both fail → SSE error event | No | Transparent to user on Groq success | **SAFE** |
| Text-to-image (Pollinations) | ✅ (already working) | — | — | — | **SAFE** |
| `geminiAvailable` in /api/system/ai-status | ✅ Flips true | — | — | CEO dashboard shows Gemini as active | **SAFE** |

### Failure Scenarios That Would NOT Affect Groq Core

| Scenario | What Happens | Groq Chat Affected? |
|----------|-------------|---------------------|
| Gemini API key wrong/expired | All Gemini features return 503 | ❌ NO — completely isolated |
| Gemini rate-limited | Gemini features return 503 | ❌ NO |
| Gemini model unavailable | `sanitizeProviderError` → clean 503 | ❌ NO |
| `AI_INTEGRATIONS_GEMINI_BASE_URL` missing after partial set | Backend boots fine; all Gemini calls throw at proxy | ❌ NO |
| Gemini TTS produces corrupt audio | `tts/serve/:id` returns error; other features unaffected | ❌ NO |
| Image edit pipeline fails mid-stage | `failJob()` → structured error response | ❌ NO |

### Silent Failure Risks

| Risk | Probability | Description |
|------|------------|-------------|
| Image edit mode fallback silently downgrades | MEDIUM | Pipeline may downgrade from `cinematic` → `portrait_safe` without notifying frontend clearly |
| Chat fallback activates without frontend notice | LOW | If Groq fails, Gemini picks up the stream. User sees no difference — this is correct behaviour, but may be surprising for monitoring |
| Gemini prompt injection in memory extractor | LOW | Memory extraction runs post-chat via `extractAndStoreMemory()` — if this uses Gemini internally, it could fail silently on Groq-only responses |

---

## PHASE 3 — FEATURE FLAG DESIGN

> **DO NOT IMPLEMENT — DESIGN ONLY**

### Problem with Current System
Currently there is one binary gate: both `AI_INTEGRATIONS_*` vars present → all Gemini features on. No per-feature control. A single Gemini API issue disables everything simultaneously.

### Proposed Feature Flag Structure

#### Flag Namespace
```
tools.gemini.chat_fallback.enabled      — Groq→Gemini fallback in /api/chat
tools.gemini.analyze_image.enabled      — POST /api/analyze-image
tools.gemini.prompt_expand.enabled      — POST /api/prompt/expand
tools.gemini.tts.enabled                — POST /api/tts/generate
tools.gemini.image_edit.enabled         — POST /api/image/edit
tools.gemini.cinematic_prompt.enabled   — POST /api/image/cinematic-prompt
```

#### Flag Evaluation (runtime, no restart)
```
Flag value = GEMINI_AVAILABLE AND feature_flag_enabled
```

Where `GEMINI_AVAILABLE = !!(AI_INTEGRATIONS_GEMINI_BASE_URL && AI_INTEGRATIONS_GEMINI_API_KEY)`

#### Storage Options (in priority order)
1. **Environment variables** — `FEATURE_GEMINI_TTS=true/false` — simplest, requires restart
2. **`system-config.json`** — already used for migration flags; add a `features` block — no restart, but file-based
3. **PostgreSQL `admin_logs` or new `feature_flags` table** — dynamic, CEO-toggleable via admin dashboard — most powerful

#### Default States
```
tools.gemini.chat_fallback.enabled      → TRUE   (safety net; activate first)
tools.gemini.prompt_expand.enabled      → TRUE   (low risk; read-only text)
tools.gemini.analyze_image.enabled      → TRUE   (read-only vision)
tools.gemini.cinematic_prompt.enabled   → TRUE   (read-only analysis)
tools.gemini.tts.enabled                → TRUE   (audio; slightly stateful)
tools.gemini.image_edit.enabled         → FALSE  (complex pipeline; activate last, manually)
```

#### Safe Fallback Behaviour per Flag
```
Flag OFF → feature returns:
  HTTP 503 { success: false, mode: "<feature>", error: "Feature temporarily disabled.", code: "FEATURE_DISABLED" }

Flag ON + Gemini unavailable → feature returns:
  HTTP 503 { success: false, mode: "<feature>", error: "AI service temporarily unavailable.", code: "PROVIDER_UNAVAILABLE" }
```

#### Frontend Handling Rules
```
1. On { code: "FEATURE_DISABLED" }   → show "This feature is coming soon." (no retry)
2. On { code: "PROVIDER_UNAVAILABLE" } → show "Service unavailable, try again." (allow retry)
3. On { code: "CREDITS_EXHAUSTED" }  → show upgrade prompt (existing)
4. On HTTP 401                        → redirect to login (existing)
```

#### Where Routing Decision Is Made
**Backend only.** The frontend sends to a fixed semantic endpoint. The backend reads flags and decides whether to proceed or return a `FEATURE_DISABLED` response. The frontend never selects a provider or reads feature flags directly.

---

## PHASE 4 — SAFE ACTIVATION SEQUENCE

### Activation Order and Rationale

```
Step 1: tools.gemini.prompt_expand      — LOWEST RISK
Step 2: tools.gemini.analyze_image      — LOW RISK, already frontend-wired
Step 3: tools.gemini.cinematic_prompt   — LOW RISK, read-only analysis
Step 4: tools.gemini.chat_fallback      — MEDIUM, touches chat path (fallback only)
Step 5: tools.gemini.tts               — MEDIUM, stateful (audio files, job system)
Step 6: tools.gemini.image_edit         — HIGHEST, complex multi-stage pipeline
```

---

#### Step 1: Prompt Expand

| Item | Detail |
|------|--------|
| **What activates** | `POST /api/prompt/expand` begins calling Gemini 2.5 Flash |
| **Required validation** | Send `{prompt: "a sunset"}` → expect `{success:true, mode:"prompt", expanded:string, category:string}` |
| **Success criteria** | Response contains `expanded` field with > 20 words |
| **Rollback condition** | Any 500/crash, or `expanded` field missing in response |
| **Rollback action** | Set `tools.gemini.prompt_expand.enabled = false` — Groq chat unaffected |
| **Risk** | **1/10** — isolated text endpoint, providerGuard 15s timeout, rate-limited 30/min |
| **Frontend impact** | None visible currently — no UI component calls this endpoint yet |

---

#### Step 2: Image Analysis

| Item | Detail |
|------|--------|
| **What activates** | `POST /api/analyze-image` begins calling Gemini 2.5 Flash vision |
| **Required validation** | Upload a JPEG → expect structured JSON with `analysis`, `prompts` fields |
| **Success criteria** | Response is non-empty JSON, no `error` field |
| **Rollback condition** | Crash, 500, empty response, or raw Gemini error in response body |
| **Rollback action** | Set `tools.gemini.analyze_image.enabled = false` |
| **Risk** | **2/10** — vision-only, read-only, already wired in frontend |
| **Frontend impact** | Image upload in InputBox now returns AI analysis instead of error message |

---

#### Step 3: Cinematic Prompt

| Item | Detail |
|------|--------|
| **What activates** | `POST /api/image/cinematic-prompt` begins calling Gemini 2.5 Flash vision |
| **Required validation** | Send image → expect `{sceneDescription, lightingDirection, colorGrade, cinematicEditPrompt, ...}` |
| **Success criteria** | All 8+ structured fields present, non-empty |
| **Rollback condition** | Missing required fields, raw error, 500 |
| **Rollback action** | Set `tools.gemini.cinematic_prompt.enabled = false` |
| **Risk** | **2/10** — read-only structured output |
| **Frontend impact** | Cinematic analysis button in image tools now returns results |

---

#### Step 4: Chat Groq→Gemini Fallback

| Item | Detail |
|------|--------|
| **What activates** | If Groq fails on any chat request, Gemini 2.5 Flash silently picks up the stream |
| **Required validation** | Temporarily remove `GROQ_API_KEY`, send a chat message → expect stream from Gemini |
| **Success criteria** | SSE stream completes cleanly with `[DONE]`, session saved, provider in DB shows `gemini` |
| **Rollback condition** | SSE error event, stream hangs, or Groq success rate drops |
| **Rollback action** | Disable fallback in LLM service — Groq-only mode resumes |
| **Risk** | **3/10** — fallback path is isolated; Groq primary is untouched; risk is only on Groq failure scenario |
| **Frontend impact** | Transparent to user — they see no difference when fallback fires |

---

#### Step 5: TTS

| Item | Detail |
|------|--------|
| **What activates** | `POST /api/tts/generate` begins calling Gemini 2.0 Flash audio, writing WAV files |
| **Required validation** | Send `{text: "Hello world", voice: "Aoede"}` → expect `{success:true, resultUrl:"/api/tts/serve/<id>"}` → GET that URL → expect WAV binary |
| **Success criteria** | WAV file streams correctly, duration > 0, no corrupt headers |
| **Rollback condition** | 503, empty audio, corrupt WAV, or job system failure |
| **Rollback action** | Set `tools.gemini.tts.enabled = false`; existing audio files in storage unaffected |
| **Risk** | **4/10** — stateful (writes files, uses job queue); audio model is `gemini-2.0-flash` which differs from all other features |
| **Frontend impact** | TTS button (needs wiring) now produces audio; no existing UI calls this yet |

---

#### Step 6: Image Editing

| Item | Detail |
|------|--------|
| **What activates** | `POST /api/image/edit` full pipeline: mode detection → Gemini vision pre-analysis → Gemini 2.5-flash-image img2img → mode fallback chain |
| **Required validation** | Test each mode separately: `portrait_safe`, `cinematic`, `style_transfer`, `creative`. Each must return base64 JPEG |
| **Success criteria** | All 4 modes return `{success:true, b64Image:string, mode:string}` without falling back unexpectedly |
| **Rollback condition** | Any mode producing corrupted output, unexpected fallback chain triggering, 500, identity lock violation |
| **Rollback action** | Set `tools.gemini.image_edit.enabled = false`; text-to-image (Pollinations) unaffected |
| **Risk** | **6/10** — most complex pipeline; multi-stage with mode fallback; uses `gemini-2.5-flash-image` (different model); identity lock contract means errors may be subtle (wrong face, wrong subject) |
| **Frontend impact** | When image + edit-intent text submitted, routes to edit pipeline instead of analysis |

---

## PHASE 5 — FINAL RISK ASSESSMENT

### Activation Risk Score

| Feature | Risk Score | Primary Risk Factor |
|---------|-----------|---------------------|
| Prompt expand | **1/10** | None significant |
| Image analysis | **2/10** | Vision model quota |
| Cinematic prompt | **2/10** | Vision model quota |
| Chat Groq→Gemini fallback | **3/10** | Affects chat path (fallback only) |
| TTS | **4/10** | Audio model, file system writes |
| Image editing | **6/10** | Multi-stage pipeline complexity, identity lock |
| **Overall activation** | **3/10** | Isolated architecture; Groq core protected |

### Stability Risk Factors

| Factor | Assessment |
|--------|-----------|
| Groq chat isolation | ✅ Groq and Gemini share zero code paths in normal operation |
| Lazy proxy | ✅ No boot-time crash risk from Gemini vars; errors are always call-time |
| Error containment | ✅ Every Gemini route has its own try/catch + `sanitizeProviderError` + structured response |
| Shared rate limits | ⚠️ All Gemini features share the same API quota; heavy TTS + image edit use could exhaust prompt expand's budget |
| Model version risk | ⚠️ Three different Gemini models in use (`2.5-flash`, `2.5-flash-image`, `2.0-flash` audio) — each has independent availability and quota |
| Job system coupling | ⚠️ TTS and image editing use an in-memory job queue; high concurrency could create queue pressure |
| No per-feature circuit breaker | ⚠️ Current system has no automatic per-feature disable if Gemini degrades — all features degrade together |

### Recommended Activation Method

**Staged rollout, per-feature, in the exact sequence defined in Phase 4.**

**Rationale:**
- A single-toggle activation (just setting both env vars) would work technically — the architecture supports it
- However staged activation allows validating each feature independently before the next
- The image edit pipeline in particular needs isolated testing before it can be trusted in production
- The feature flag system in Phase 3, even if implemented minimally (env vars per feature), would allow instant per-feature rollback without touching the Gemini env vars

### Recommended Activation Method (Minimal, No Code Changes)

For immediate activation with zero code changes:

```
1. Add AI_INTEGRATIONS_GEMINI_API_KEY and AI_INTEGRATIONS_GEMINI_BASE_URL as Replit secrets
2. Restart the IB AI Backend workflow
3. Validate Step 1 (prompt expand) manually
4. Validate Step 2 (image analysis) manually
5. Validate Step 3 (cinematic prompt) manually
6. Monitor /api/system/ai-status for geminiAvailable: true and no error spikes
7. Test image editing in isolation (Step 6) before marking complete
```

Rollback at any step: remove `AI_INTEGRATIONS_GEMINI_API_KEY` from secrets and restart — Groq chat continues unaffected within seconds.

---

## SUMMARY TABLE

| Phase | Groq Core Risk | Action Required | Code Changes |
|-------|---------------|-----------------|--------------|
| Add Gemini secrets + restart | ZERO | Set 2 secrets | None |
| Prompt expand validation | ZERO | 1 curl test | None |
| Image analysis validation | ZERO | Upload test image | None |
| Cinematic prompt validation | ZERO | Upload test image | None |
| Chat fallback validation | ZERO | Temp remove Groq key | None |
| TTS validation | ZERO | 1 curl test + audio check | None |
| Image edit validation | ZERO | Test all 4 modes | None |

> **The Groq core chat system is structurally isolated from Gemini at the code level.**  
> No activation step carries any risk of destabilising it.  
> Rollback at any point takes < 60 seconds.
