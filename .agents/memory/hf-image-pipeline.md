---
name: HuggingFace image pipeline
description: HF inference router endpoint quirks for Replit — required for image generation via FLUX.1-schnell.
---

# HuggingFace Image Generation Pipeline

## Rule
Use `router.huggingface.co/hf-inference/models/{model}` — NOT `api-inference.huggingface.co`.

**Why:** `api-inference.huggingface.co` has no IPv4 A record from Replit's container (ENODATA even via Google DNS 8.8.8.8). The inference router `router.huggingface.co` resolves (3.163.158.x) and TCP:443 connects.

## How to apply
- Model: `black-forest-labs/FLUX.1-schnell`
- Auth: `Authorization: Bearer {HF_API_KEY}` — required even for free-tier models; 401 without key.
- Accept header: **`image/png` only** — comma-separated multi-type Accept values (e.g. `image/jpeg,image/png`) return HTTP 400 "Accept type not supported".
- Header `X-Wait-For-Model: true` — prevents 503 on cold starts (model loading).
- Body params: `{ inputs: prompt, parameters: { width: 1024, height: 1024, num_inference_steps: 4, guidance_scale: 0 } }`
- On 503 without `X-Wait-For-Model`: retry once after 10s (cold start warm-up).
- `HF_API_KEY` is optional in config (graceful 503 + clear error message if absent).

## Pipeline (img2img)
1. Gemini 2.5 Flash — vision analysis → text prompt (text output only, free tier)
2. HuggingFace FLUX.1-schnell — text → image (HF_API_KEY required)

Replaces the prior Pollinations FLUX pipeline (HTTP 402 payment gate on all Replit egress IPs).
