---
name: Free image editing pipeline
description: Architecture for identity-preserving image editing on the free stack. HF inference API does NOT support img2img. Fal.ai is the only working solution.
---

## Core constraint (CONFIRMED EXHAUSTIVELY)
**HuggingFace inference API (router.huggingface.co/hf-inference) does NOT support image-to-image tasks.** Every img2img model — SD v1.5, SDXL Refiner, InstructPix2Pix, FLUX.1-Redux-dev — returns 400 "Model not supported by provider hf-inference".

The `fal-ai` provider via HF router only whitelists `fal-ai/flux/schnell` for text-to-image. All img2img variants return 400 "not supported". FLUX rejects `image` param with "FluxPipeline.__call__() got an unexpected keyword argument 'image'".

## Two-path pipeline (runFreeImg2Img in imageGenService.ts)

### PATH A — True img2img, identity preserved — requires FAL_KEY
1. Gemini 2.5 Flash → SHORT style prompt (15–40 words, style only, no subject description)
2. Fal.ai FLUX.1-dev img2img: `https://fal.run/fal-ai/flux/dev/image-to-image`
   - Auth: `Authorization: Key {FAL_KEY}` (NOT Bearer)
   - Params: `{prompt, image_url (base64 data URI), strength, num_inference_steps:28, guidance_scale:3.5}`
   - Response: JSON `{"images":[{"url":"https://v3b.fal.media/..."}]}` → fetch CDN URL → convert to base64
   - Strength per mode: restore=0.15, portrait_safe=0.20, polish=0.20, social=0.30, cinematic=0.35, luxury=0.35, style_transfer=0.55, creative=0.65
   - Timeout: 120s (FLUX dev slower than schnell)

### PATH B — Text-to-image fallback, identity NOT preserved — HF_API_KEY only
1. Gemini 2.5 Flash → FULL scene description (120–200 words including subject)
2. HF FLUX.1-schnell text-to-image (router.huggingface.co/hf-inference)
   - Accept: `image/png` ONLY (comma-separated multi-type returns 400)
   - Response: binary image data → convert to base64

## fal.run behaviour
- DNS resolves from Replit: `fal.run → 35.224.27.103`
- Free tier: $10 credit on signup ≈ 3000+ img2img edits at ~$0.003/image
- FAL_KEY added to envConfig.ts and requiredSecrets.ts as OPTIONAL

## Do NOT revert
- Do NOT call `runImg2Img()` (legacy Gemini img2img) — requires Google billing (limit:0 free tier)
- Do NOT use `responseModalities: ["IMAGE"]` on any Gemini call without confirmed billing
- Do NOT pass `image` param to FLUX schnell — it's rejected
- `STAGE_TIMEOUT_MS = 95_000`, `PIPELINE_TIMEOUT_MS = 150_000`
