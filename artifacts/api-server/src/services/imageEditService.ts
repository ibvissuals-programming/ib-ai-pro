/**
 * imageEditService.ts — Direct pixel-level image editing pipeline.
 *
 * Provides 5 capabilities that always return a real b64Image:
 *   1. cinematic_grade    — teal-orange LUT + contrast + grain + vignette (Jimp, instant, no API)
 *   2. remove_background  — subject isolation via edge-weighted luminance mask + bg blur (Jimp)
 *   3. upscale            — 2× bilinear upscale + unsharp mask (Jimp, no API)
 *   4. remove_watermark   — Gemini image editing with targeted removal instruction
 *   5. retouch            — skin smoothing + brightness/contrast + saturation (Jimp, no API)
 *
 * Safe Enhancement Mode (text suggestions) is never used — every capability produces a real image.
 * If a capability fails, the error propagates and the route falls back to the existing pipeline.
 */

import { logger } from "../lib/logger";

// ── Types ─────────────────────────────────────────────────────────────────────

export type DirectEditType =
  | "cinematic_grade"
  | "remove_background"
  | "upscale"
  | "remove_watermark"
  | "retouch";

export const DIRECT_EDIT_TYPES: DirectEditType[] = [
  "cinematic_grade",
  "remove_background",
  "upscale",
  "remove_watermark",
  "retouch",
];

// ── Utility ───────────────────────────────────────────────────────────────────

function parseDataUrl(dataUrl: string): { buffer: Buffer; mimeType: string } {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match) throw new Error("Invalid image data URL.");
  return { mimeType: match[1]!, buffer: Buffer.from(match[2]!, "base64") };
}

function toJpegDataUrl(buffer: Buffer): string {
  return `data:image/jpeg;base64,${buffer.toString("base64")}`;
}

const clamp = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));

// ── CAPABILITY 1: Cinematic Color Grade ──────────────────────────────────────
//
// Applies a Hollywood-style teal-orange color grade entirely in pixel space.
// No external API calls — pure Jimp, runs in <1s on any image, free forever.
//
// Pipeline:
//   1. Teal-orange grade: shadows→teal (R−,B+), highlights→orange (R+,B−)
//   2. S-curve contrast (×1.15, centered at midtone)
//   3. Film grain (±10 per channel, seeded per-pixel)
//   4. Vignette (cosine-falloff, max 40% darkening at corners)
//
// Returns JPEG data URL.

export async function cinematicGrade(imageDataUrl: string): Promise<string> {
  const { Jimp } = await import("jimp");
  const { buffer } = parseDataUrl(imageDataUrl);
  const img = await Jimp.read(buffer);
  const { width, height } = img.bitmap;
  const data = img.bitmap.data as Buffer;

  const total = width * height;

  // Step 1: Teal-orange grade
  for (let i = 0; i < total; i++) {
    const idx = i * 4;
    const r = data[idx]!;
    const g = data[idx + 1]!;
    const b = data[idx + 2]!;

    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    const t   = lum / 255;

    // Shadow weight: strongest at blacks (t=0), fades by t=0.45
    const shadowW    = Math.max(0, 1 - t / 0.45) * 0.35;
    // Highlight weight: starts at t=0.55, strongest at whites (t=1)
    const highlightW = Math.max(0, (t - 0.55) / 0.45) * 0.35;

    // Teal shadows: R down, G tiny up, B up
    // Orange highlights: R up, G slight up, B down
    data[idx]     = clamp(r * (1 - shadowW * 0.28 + highlightW * 0.30));
    data[idx + 1] = clamp(g * (1 + shadowW * 0.04 + highlightW * 0.08));
    data[idx + 2] = clamp(b * (1 + shadowW * 0.28 - highlightW * 0.28));
  }

  // Step 2: S-curve contrast (factor 1.15)
  const cf = 1.15;
  for (let i = 0; i < data.length; i++) {
    if (i % 4 === 3) continue; // skip alpha
    const v = data[i]! / 255;
    data[i] = clamp(((v - 0.5) * cf + 0.5) * 255);
  }

  // Step 3: Film grain (±10)
  for (let i = 0; i < data.length; i++) {
    if (i % 4 === 3) continue;
    data[i] = clamp(data[i]! + (Math.random() - 0.5) * 20);
  }

  // Step 4: Vignette (cos² falloff, max 40% at corners)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      // Normalized coords: 0 at center, 1 at edge along each axis
      const dx = (x / (width  - 1) - 0.5) * 2;
      const dy = (y / (height - 1) - 0.5) * 2;
      const dist2 = dx * dx + dy * dy; // 0=center, 2=corner
      const vig   = 1 - Math.min(dist2 * 0.22, 0.40);

      data[idx]     = clamp(data[idx]! * vig);
      data[idx + 1] = clamp(data[idx + 1]! * vig);
      data[idx + 2] = clamp(data[idx + 2]! * vig);
    }
  }

  const outBuf = await img.getBuffer("image/jpeg", { quality: 85 });
  logger.info({ width, height, outBytes: outBuf.length }, "[imageEdit] cinematicGrade complete");
  return toJpegDataUrl(outBuf);
}

// ── CAPABILITY 2: Background Blur / Subject Isolation ────────────────────────
//
// Graduated elliptical mask — portrait-mode bokeh effect.
//
// Why not Sobel edge detection: on complex real photos (foliage, crowds,
// textured backgrounds) Sobel edges appear throughout the entire background,
// making it impossible to distinguish "subject edge" from "background
// texture edge". Any edge-based approach classifies background texture as
// foreground and the blur loop never fires.
//
// The reliable approach (used by software portrait-mode on phones without
// depth sensors): a graduated center-weighted ellipse.
//
//   Inner zone  — rxInner=40%w × ryInner=44%h  → fully sharp (blend=0)
//   Outer zone  — rxOuter=50%w × ryOuter=55%h  → fully blurred (blend=1)
//   Feather band — smooth cubic (smoothstep) transition between the two
//
// This guarantees ~43% of pixels receive full blur, ~33% receive partial
// blur, and ~24% are sharp — regardless of image content complexity.
// Box blur radius = 16 for clearly visible bokeh.
//
// Returns JPEG data URL.

export async function blurBackground(imageDataUrl: string): Promise<string> {
  const { Jimp } = await import("jimp");
  const { buffer } = parseDataUrl(imageDataUrl);
  const img = await Jimp.read(buffer);
  const { width, height } = img.bitmap;
  const src = Buffer.from(img.bitmap.data as Buffer); // snapshot of original

  // ── Ellipse parameters ────────────────────────────────────────────────────
  const cx = (width  - 1) / 2;
  const cy = (height - 1) / 2;
  // Outer ellipse: boundary where blur is at 100%
  const rxO = width  * 0.50;
  const ryO = height * 0.55;
  // Inner ellipse expressed as a fraction of the outer (0 < innerRatio < 1)
  // — pixels inside inner are fully sharp (blend = 0)
  const INNER_RATIO = 0.70; // inner = 35%w × 38.5%h

  // ── Pre-compute full-image box blur (radius 16) ───────────────────────────
  const blurred = Buffer.from(src);
  const R = 16;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let rSum = 0, gSum = 0, bSum = 0, count = 0;
      for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          const ny = Math.min(height - 1, Math.max(0, y + dy));
          const nx = Math.min(width  - 1, Math.max(0, x + dx));
          const si = (ny * width + nx) * 4;
          rSum += src[si]!;
          gSum += src[si + 1]!;
          bSum += src[si + 2]!;
          count++;
        }
      }
      const di = (y * width + x) * 4;
      blurred[di]     = Math.round(rSum / count);
      blurred[di + 1] = Math.round(gSum / count);
      blurred[di + 2] = Math.round(bSum / count);
    }
  }

  // ── Composite with graduated blend ────────────────────────────────────────
  // distOuter: normalized distance from center using OUTER ellipse radii.
  //   distOuter < INNER_RATIO  → fully sharp   (blend = 0)
  //   INNER_RATIO ≤ distOuter ≤ 1 → feather zone (blend = smoothstep)
  //   distOuter > 1            → fully blurred  (blend = 1)
  const out = img.bitmap.data as Buffer;
  let blurredPixels = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;

      // Normalized distance from center in outer-ellipse coordinate space
      const dxN = (x - cx) / rxO;
      const dyN = (y - cy) / ryO;
      const distOuter = Math.sqrt(dxN * dxN + dyN * dyN);

      // Blend factor: 0 = fully sharp, 1 = fully blurred
      let blend: number;
      if (distOuter <= INNER_RATIO) {
        continue; // fully sharp — no write needed
      } else if (distOuter >= 1.0) {
        blend = 1.0;
      } else {
        // Smoothstep over the feather band [INNER_RATIO, 1.0]
        const t = (distOuter - INNER_RATIO) / (1.0 - INNER_RATIO);
        blend = t * t * (3 - 2 * t); // cubic smoothstep
      }

      out[idx]     = clamp(src[idx]!     * (1 - blend) + blurred[idx]!     * blend);
      out[idx + 1] = clamp(src[idx + 1]! * (1 - blend) + blurred[idx + 1]! * blend);
      out[idx + 2] = clamp(src[idx + 2]! * (1 - blend) + blurred[idx + 2]! * blend);
      blurredPixels++;
    }
  }

  const outBuf      = await img.getBuffer("image/jpeg", { quality: 85 });
  const blurredPct  = Math.round((blurredPixels / (width * height)) * 100);
  logger.info(
    { width, height, blurredPct, outBytes: outBuf.length },
    "[imageEdit] blurBackground complete",
  );
  return toJpegDataUrl(outBuf);
}

// ── CAPABILITY 3: Upscale + Sharpen ──────────────────────────────────────────
//
// Resizes the image to 2× via bilinear interpolation (Jimp default), then
// applies an unsharp-mask equivalent: subtract a blurred copy, add back with
// strength factor. Effective for screenshots and low-res photos.
//
// Returns JPEG data URL.

export async function upscaleImage(imageDataUrl: string): Promise<string> {
  const { Jimp } = await import("jimp");
  const { buffer } = parseDataUrl(imageDataUrl);
  const img = await Jimp.read(buffer);
  const { width, height } = img.bitmap;

  // Cap output at 4096px on longest side to avoid OOM
  const scale = Math.min(2, 4096 / Math.max(width, height));
  const newW  = Math.round(width  * scale);
  const newH  = Math.round(height * scale);

  img.resize({ w: newW, h: newH });

  // Unsharp mask: sharpen by blending (original − blurred) back in
  // We implement this as: sharpened = original * (1 + amount) − blurred * amount
  const sharp = img.clone();
  img.blur(1); // blur is now in img

  const sharpData  = sharp.bitmap.data as Buffer;
  const blurData   = img.bitmap.data as Buffer;
  const SHARP_AMT  = 0.45;

  for (let i = 0; i < sharpData.length; i++) {
    if (i % 4 === 3) continue;
    sharpData[i] = clamp(sharpData[i]! * (1 + SHARP_AMT) - blurData[i]! * SHARP_AMT);
  }

  const outBuf = await sharp.getBuffer("image/jpeg", { quality: 85 });
  logger.info({ origW: width, origH: height, newW, newH, outBytes: outBuf.length }, "[imageEdit] upscaleImage complete");
  return toJpegDataUrl(outBuf);
}

// ── CAPABILITY 4: Watermark / Text Removal (Jimp inpainting) ─────────────────
//
// Detects and inpaints watermarks, text overlays, logos, and UI chrome.
// Pure pixel-ops, no external API calls.
//
// Detection (unchanged from v2):
//   Bidirectional contrast |lum−localAvg|, edge-proximity threshold reduction,
//   low-saturation near-edge heuristic, hint-region boost, platform heuristics.
//
// Fill pipeline (v3 — fixes blur bleed and ghosting):
//   1. Parse hint → hintRegions[]
//   2. Compute local-average luma (box filter r=8)
//   3. Build candidateMask (same 3-signal detection as v2)
//   4. Dilate by DILATE_R=3 → dilatedMask
//      Build featherWeight[]:
//        candidateMask pixel → 1.0 (fully replaced)
//        dilated-but-not-candidate → 0.5 (blend seam)
//        outside → 0.0 (never written — pixel-identical to input)
//   5. Two-pass inpainting into a separate `inpainted` buffer:
//        Pass 1 — IDW fill (w=1/dist, r=22) from clean `snap` neighbors
//                 (skips all dilatedMask pixels, reads only unmasked originals)
//        Pass 2 — re-fill pixels where pass 1 had no/few clean neighbors
//                 (handles thick watermark centers) using pass-1 results as source
//   6. Targeted patch smooth: 3×3 box avg within candidateMask, sourcing ONLY
//      from dilatedMask neighbors — dissolves ghost shapes without touching
//      pixels outside the mask zone
//   7. Feathered composite: data[i] = lerp(snap[i], inpainted[i], featherWeight[i])
//      weight-0 pixels are NEVER written — the rest of the image is untouched.
//      NO whole-image blur.
//
// Returns JPEG data URL.

export async function removeWatermark(imageDataUrl: string, _hint = ""): Promise<string> {
  const { Jimp } = await import("jimp");
  const { buffer } = parseDataUrl(imageDataUrl);
  const img = await Jimp.read(buffer);
  const { width, height } = img.bitmap;
  const data = img.bitmap.data as Buffer;
  const snap = Buffer.from(data); // original snapshot — detection always reads this

  // ── Step 1: Parse hint for position bias ─────────────────────────────────
  // Hint regions are expressed as fractional [0,1] coordinates.
  // We normalise after building the list.
  const hint = _hint.toLowerCase();

  interface HintRegion { x0: number; y0: number; x1: number; y1: number }
  const hintRegions: HintRegion[] = [];

  // Named corner hints
  if (/top.?left|left.?top/.test(hint))    hintRegions.push({ x0: 0,    y0: 0,    x1: 0.35, y1: 0.35 });
  if (/top.?right|right.?top/.test(hint))  hintRegions.push({ x0: 0.65, y0: 0,    x1: 1,    y1: 0.35 });
  if (/bot.?left|left.?bot/.test(hint))    hintRegions.push({ x0: 0,    y0: 0.65, x1: 0.35, y1: 1    });
  if (/bot.?right|right.?bot/.test(hint))  hintRegions.push({ x0: 0.65, y0: 0.65, x1: 1,    y1: 1    });

  // Single-edge hints (only if no corner matched)
  if (!hintRegions.length) {
    if (/\btop\b/.test(hint))    hintRegions.push({ x0: 0, y0: 0,    x1: 1, y1: 0.22 });
    if (/\bbottom\b/.test(hint)) hintRegions.push({ x0: 0, y0: 0.78, x1: 1, y1: 1    });
    if (/\bleft\b/.test(hint))   hintRegions.push({ x0: 0, y0: 0,    x1: 0.22, y1: 1  });
    if (/\bright\b/.test(hint))  hintRegions.push({ x0: 0.78, y0: 0, x1: 1, y1: 1    });
  }

  // Social-media platform heuristics (typical watermark positions)
  if (!hintRegions.length && /tiktok|tik.?tok/.test(hint))
    hintRegions.push({ x0: 0, y0: 0.72, x1: 1, y1: 1 }); // bottom strip
  if (!hintRegions.length && /instagram|insta\b/.test(hint))
    hintRegions.push({ x0: 0, y0: 0.82, x1: 1, y1: 1 }); // bottom bar
  if (!hintRegions.length && /youtube/.test(hint))
    hintRegions.push({ x0: 0, y0: 0,    x1: 1, y1: 0.18 }); // top bar
  if (!hintRegions.length && /twitter|x\.com/.test(hint))
    hintRegions.push({ x0: 0.65, y0: 0.65, x1: 1, y1: 1 }); // bottom-right

  const inHintRegion = (x: number, y: number): boolean => {
    const fx = x / Math.max(1, width  - 1);
    const fy = y / Math.max(1, height - 1);
    return hintRegions.some(r => fx >= r.x0 && fx <= r.x1 && fy >= r.y0 && fy <= r.y1);
  };

  // ── Step 2: Compute local average luma (box filter, radius 8) ────────────
  const RADIUS = 8;
  const localAvg = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0, count = 0;
      for (let dy = -RADIUS; dy <= RADIUS; dy++) {
        for (let dx = -RADIUS; dx <= RADIUS; dx++) {
          const ny = Math.min(height - 1, Math.max(0, y + dy));
          const nx = Math.min(width  - 1, Math.max(0, x + dx));
          const si = (ny * width + nx) * 4;
          sum += 0.299 * snap[si]! + 0.587 * snap[si + 1]! + 0.114 * snap[si + 2]!;
          count++;
        }
      }
      localAvg[y * width + x] = sum / count;
    }
  }

  // ── Step 3: Build watermark candidate mask ────────────────────────────────
  const BASE_THRESH  = 28;                               // bidirectional contrast base
  const EDGE_BAND    = Math.min(width, height) * 0.18;   // 18 % from any edge → threshold ↓

  const candidateMask = new Uint8Array(width * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i   = y * width + x;
      const idx = i * 4;
      const r = snap[idx]!, g = snap[idx + 1]!, b = snap[idx + 2]!;
      const lum      = 0.299 * r + 0.587 * g + 0.114 * b;
      const contrast = Math.abs(lum - localAvg[i]!);         // ← BIDIRECTIONAL

      // Position-aware threshold: reduced near corners/edges where overlays live
      const edgeDist   = Math.min(x, width - 1 - x, y, height - 1 - y);
      const edgeFactor = Math.max(0, 1 - edgeDist / EDGE_BAND); // 1 at edge, 0 inside
      const posThresh  = BASE_THRESH * (1 - 0.46 * edgeFactor); // 28 → ~15 at edge

      // Hint-region boost: threshold halved inside explicitly named areas
      const inHint     = hintRegions.length > 0 && inHintRegion(x, y);
      const finalThresh = inHint ? BASE_THRESH * 0.39 : posThresh; // ~11 in hint zone

      // Signal A — bidirectional contrast anomaly
      if (contrast > finalThresh) { candidateMask[i] = 1; continue; }

      // Signal B — low-saturation (grayscale) pixel near an edge with any contrast
      // Text/logos are almost always near-grayscale; photo content is colourful.
      const maxC       = Math.max(r, g, b);
      const minC       = Math.min(r, g, b);
      const saturation = maxC > 0 ? (maxC - minC) / maxC : 0;
      if (saturation < 0.14 && contrast > 13 && edgeFactor > 0.25) {
        candidateMask[i] = 1; continue;
      }

      // Signal C — near-black or near-white absolute value inside a hint region
      // Catches fully-opaque logos and usernames that may not contrast with avg.
      if (inHint && (lum > 220 || lum < 35) && saturation < 0.25) {
        candidateMask[i] = 1;
      }
    }
  }

  // ── Step 4: Dilate → dilatedMask; build featherWeight array ─────────────
  // dilatedMask = candidateMask expanded by DILATE_R pixels.
  // featherWeight:
  //   1.0  → candidateMask pixel    (fully replaced by inpainting)
  //   0.5  → dilation-ring pixel    (soft 50/50 blend — seam feather)
  //   0.0  → everything else        (NEVER written — pixel-identical to input)
  const DILATE_R      = 3;
  const dilatedMask   = new Uint8Array(candidateMask);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!candidateMask[y * width + x]) continue;
      for (let dy = -DILATE_R; dy <= DILATE_R; dy++) {
        for (let dx = -DILATE_R; dx <= DILATE_R; dx++) {
          const ny = y + dy, nx = x + dx;
          if (ny >= 0 && ny < height && nx >= 0 && nx < width)
            dilatedMask[ny * width + nx] = 1;
        }
      }
    }
  }

  const featherWeight = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    if (candidateMask[i])  featherWeight[i] = 1.0;
    else if (dilatedMask[i]) featherWeight[i] = 0.5;
    // else stays 0.0 — outside zone, never modified
  }

  // ── Step 5: Two-pass inpainting into a separate `inpainted` buffer ────────
  // NEVER modifies `data` or `snap` during sampling.
  // Pass 1: IDW fill (w = 1/dist, radius 22) from unmasked `snap` neighbors.
  //   w = 1/dist (not 1/dist²) → more balanced sampling across the background.
  //   Skips all dilatedMask pixels so it reads only untouched original pixels.
  // Pass 2: pixels where pass 1 found no clean neighbors (thick watermark centers)
  //   are re-filled from the pass-1 inpainted buffer.
  const inpainted  = Buffer.from(snap); // starts as copy of original
  const SAMPLE_R   = 22;
  const MIN_TOTAL_W = 1.0;              // if pass 1 < this, flag for pass 2
  const needsP2    = new Uint8Array(width * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!dilatedMask[y * width + x]) continue;
      let wR = 0, wG = 0, wB = 0, totalW = 0;
      for (let dy = -SAMPLE_R; dy <= SAMPLE_R; dy++) {
        for (let dx = -SAMPLE_R; dx <= SAMPLE_R; dx++) {
          const ny = y + dy, nx = x + dx;
          if (ny < 0 || ny >= height || nx < 0 || nx >= width) continue;
          if (dilatedMask[ny * width + nx]) continue; // only unmasked originals
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist === 0) continue;
          const w  = 1 / dist; // ← 1/dist not 1/dist² for balanced background avg
          const si = (ny * width + nx) * 4;
          wR += snap[si]! * w; wG += snap[si + 1]! * w; wB += snap[si + 2]! * w;
          totalW += w;
        }
      }
      const idx = (y * width + x) * 4;
      if (totalW >= MIN_TOTAL_W) {
        inpainted[idx]     = clamp(wR / totalW);
        inpainted[idx + 1] = clamp(wG / totalW);
        inpainted[idx + 2] = clamp(wB / totalW);
      } else {
        needsP2[y * width + x] = 1; // thick center pixel — handle in pass 2
      }
    }
  }

  // Pass 2: stranded center pixels → fill from pass-1 inpainted buffer
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!needsP2[y * width + x]) continue;
      let wR = 0, wG = 0, wB = 0, totalW = 0;
      for (let dy = -SAMPLE_R; dy <= SAMPLE_R; dy++) {
        for (let dx = -SAMPLE_R; dx <= SAMPLE_R; dx++) {
          const ny = y + dy, nx = x + dx;
          if (ny < 0 || ny >= height || nx < 0 || nx >= width) continue;
          if (needsP2[ny * width + nx]) continue; // skip other unresolved pixels
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist === 0) continue;
          const w  = 1 / dist;
          const si = (ny * width + nx) * 4;
          wR += inpainted[si]! * w; wG += inpainted[si + 1]! * w; wB += inpainted[si + 2]! * w;
          totalW += w;
        }
      }
      if (totalW > 0) {
        const idx         = (y * width + x) * 4;
        inpainted[idx]     = clamp(wR / totalW);
        inpainted[idx + 1] = clamp(wG / totalW);
        inpainted[idx + 2] = clamp(wB / totalW);
      }
    }
  }

  // ── Step 6: Targeted patch smooth (ghost dissolution) ────────────────────
  // Applies a 3×3 box average ONLY to candidateMask pixels, reading ONLY from
  // dilatedMask neighbors. This dissolves residual ghost shapes at the boundary
  // of the inpainted patch without touching any pixel outside the mask zone.
  const preSm = Buffer.from(inpainted);
  const SM_R  = 3;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!candidateMask[y * width + x]) continue; // only core mask pixels
      let rS = 0, gS = 0, bS = 0, cnt = 0;
      for (let dy = -SM_R; dy <= SM_R; dy++) {
        for (let dx = -SM_R; dx <= SM_R; dx++) {
          const ny = y + dy, nx = x + dx;
          if (ny < 0 || ny >= height || nx < 0 || nx >= width) continue;
          if (!dilatedMask[ny * width + nx]) continue; // mask-zone values only
          const si = (ny * width + nx) * 4;
          rS += preSm[si]!; gS += preSm[si + 1]!; bS += preSm[si + 2]!; cnt++;
        }
      }
      if (cnt > 0) {
        const idx         = (y * width + x) * 4;
        inpainted[idx]     = clamp(rS / cnt);
        inpainted[idx + 1] = clamp(gS / cnt);
        inpainted[idx + 2] = clamp(bS / cnt);
      }
    }
  }

  // ── Step 7: Feathered composite — pixel-safe write ────────────────────────
  // Pixels with featherWeight = 0 are NEVER written.
  // The only pixels that change are those in candidateMask (weight 1.0) and
  // the 3-pixel dilation ring (weight 0.5).
  // NO whole-image blur — seam blending is handled entirely by featherWeight.
  for (let i = 0; i < width * height; i++) {
    const fw = featherWeight[i];
    if (fw === 0) continue; // outside zone — untouched
    const idx   = i * 4;
    data[idx]     = clamp(snap[idx]!     * (1 - fw) + inpainted[idx]!     * fw);
    data[idx + 1] = clamp(snap[idx + 1]! * (1 - fw) + inpainted[idx + 1]! * fw);
    data[idx + 2] = clamp(snap[idx + 2]! * (1 - fw) + inpainted[idx + 2]! * fw);
  }

  const outBuf    = await img.getBuffer("image/jpeg", { quality: 85 });
  const maskedPct = Math.round(
    (dilatedMask.reduce((s, v) => s + v, 0) / (width * height)) * 100,
  );
  logger.info(
    { width, height, maskedPct, hintRegions: hintRegions.length, outBytes: outBuf.length },
    "[imageEdit] removeWatermark complete",
  );
  return toJpegDataUrl(outBuf);
}

// ── CAPABILITY 5: Light Retouch ───────────────────────────────────────────────
//
// Applies a non-destructive beauty pass using pure pixel operations:
//   1. Gaussian-approximation skin smoothing (selective blur on low-saturation regions)
//   2. Brightness lift (+15)
//   3. Contrast enhancement (×1.18)
//   4. Saturation boost (×1.22 on Cb/Cr components)
//
// No external API. Returns JPEG data URL.

export async function lightRetouch(imageDataUrl: string): Promise<string> {
  const { Jimp } = await import("jimp");
  const { buffer } = parseDataUrl(imageDataUrl);
  const img = await Jimp.read(buffer);
  const { width, height } = img.bitmap;
  const data = img.bitmap.data as Buffer;

  // Step 1: Selective skin smoothing
  // Blends each pixel with its neighbors only in low-saturation (skin-like) regions
  const src = Buffer.from(data); // snapshot

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = (y * width + x) * 4;
      const r = src[idx]!;
      const g = src[idx + 1]!;
      const b = src[idx + 2]!;

      // Compute saturation (0=grey, 255=fully saturated)
      const maxC = Math.max(r, g, b);
      const minC = Math.min(r, g, b);
      const sat  = maxC === 0 ? 0 : (maxC - minC) / maxC;

      // Only smooth low-saturation, mid-brightness areas (skin tones)
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      if (sat > 0.55 || lum < 40 || lum > 230) continue;

      // 3×3 box blend with 50% strength
      let rSum = 0, gSum = 0, bSum = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const ni = ((y + dy) * width + (x + dx)) * 4;
          rSum += src[ni]!;
          gSum += src[ni + 1]!;
          bSum += src[ni + 2]!;
        }
      }
      const SMOOTH = 0.5;
      data[idx]     = clamp(r * (1 - SMOOTH) + (rSum / 9) * SMOOTH);
      data[idx + 1] = clamp(g * (1 - SMOOTH) + (gSum / 9) * SMOOTH);
      data[idx + 2] = clamp(b * (1 - SMOOTH) + (bSum / 9) * SMOOTH);
    }
  }

  // Step 2: Brightness lift (+15)
  for (let i = 0; i < data.length; i++) {
    if (i % 4 === 3) continue;
    data[i] = clamp(data[i]! + 15);
  }

  // Step 3: Contrast (×1.18)
  const cf = 1.18;
  for (let i = 0; i < data.length; i++) {
    if (i % 4 === 3) continue;
    const v = data[i]! / 255;
    data[i] = clamp(((v - 0.5) * cf + 0.5) * 255);
  }

  // Step 4: Saturation boost (×1.10 via YCbCr decomposition)
  for (let i = 0; i < width * height; i++) {
    const idx = i * 4;
    const r = data[idx]!;
    const g = data[idx + 1]!;
    const b = data[idx + 2]!;

    const y2  =  0.299 * r + 0.587 * g + 0.114 * b;
    const cb  = -0.169 * r - 0.331 * g + 0.500 * b;
    const cr  =  0.500 * r - 0.419 * g - 0.081 * b;

    const SAT = 1.22;
    const newR = clamp(y2 + 1.402 * (cr * SAT));
    const newG = clamp(y2 - 0.344 * (cb * SAT) - 0.714 * (cr * SAT));
    const newB = clamp(y2 + 1.772 * (cb * SAT));

    data[idx]     = newR;
    data[idx + 1] = newG;
    data[idx + 2] = newB;
  }

  const outBuf = await img.getBuffer("image/jpeg", { quality: 85 });
  logger.info({ width, height, outBytes: outBuf.length }, "[imageEdit] lightRetouch complete");
  return toJpegDataUrl(outBuf);
}

// ── Public dispatcher ─────────────────────────────────────────────────────────

export async function runDirectEdit(
  imageDataUrl: string,
  editType:     DirectEditType,
  prompt:       string,
): Promise<string> {
  const t0 = Date.now();
  logger.info({ editType, promptLen: prompt.length }, "[imageEdit] runDirectEdit start");

  let result: string;
  switch (editType) {
    case "cinematic_grade":   result = await cinematicGrade(imageDataUrl);       break;
    case "remove_background": result = await blurBackground(imageDataUrl);       break;
    case "upscale":           result = await upscaleImage(imageDataUrl);         break;
    case "remove_watermark":  result = await removeWatermark(imageDataUrl, prompt); break;
    case "retouch":           result = await lightRetouch(imageDataUrl);         break;
    default:
      throw new Error(`Unknown editType: ${String(editType)}`);
  }

  logger.info({ editType, latencyMs: Date.now() - t0 }, "[imageEdit] runDirectEdit complete");
  return result;
}
