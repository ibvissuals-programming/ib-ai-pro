---
name: Direct pixel edit pipeline
description: All 5 Edit tab capabilities implemented with pure Jimp pixel ops; dispatch via editType field in POST /api/image/edit; legacy pipeline preserved as fallback when editType absent.
---

## Rule
When `editType` is supplied to `POST /api/image/edit`, the route dispatches to `imageEditService.ts:runDirectEdit()` BEFORE any Gemini/APRE/FRAE processing and before Safe Enhancement Mode. This always produces a real JPEG b64Image.

**Why:** HF inference router rejects all img2img/segmentation models ("Model not supported by provider hf-inference"). Fal.ai requires FAL_KEY (paid). `gemini-2.5-flash-image` throws `provider_not_configured` code (SDK wraps API failures with that code) which bubbles up through the route's catch block. Pure Jimp pixel ops are the only reliable free path.

## Capability implementations (all in imageEditService.ts)
1. `cinematic_grade` — teal-orange per-pixel grade (shadow/highlight luminance split) + S-curve contrast (×1.15) + film grain (±10) + vignette (cos² falloff)
2. `remove_background` — Sobel edge magnitude → dilated foreground mask → box blur (R=8) background composite
3. `upscale` — Jimp 2× resize (bilinear) + unsharp mask (clone, blur(1), blend with SHARP_AMT=0.45)
4. `remove_watermark` — 3-pass luminance anomaly detection (thresholds 55/35/20 above local avg) → inverse-distance weighted inpainting from non-masked neighbors (R=12) → blur(1) seam smoothing
5. `retouch` — selective skin smoothing (low-saturation, mid-brightness 3×3 blend at 50%) + brightness lift (+8) + contrast (×1.08) + YCbCr saturation boost (×1.10)

## How to apply
- All 5 editTypes return real JPEG data URLs in 119–217ms, enhancementMode=false.
- Safe Enhancement Mode is preserved as fallback when editType is absent (legacy pipeline).
- Frontend: `DIRECT_EDIT_TYPES` array in ImageTools.jsx → Quick Edit button grid → sends `options.editType` to `editImage()` 7th param.
- Jimp v1.6.1 is installed in `artifacts/api-server`. Use `Jimp.read(buffer)` (NOT `Jimp.fromBuffer`) — both work but `read` is the tested path.
- `gemini-2.5-flash-image` model EXISTS on the API key but has quota exceeded (returns 429). Do NOT rely on it for any edit capability.
- HF inference router: `router.huggingface.co/hf-inference/models` — text-to-image ONLY; any img2img/segmentation → 400 "Model not supported by provider hf-inference".
