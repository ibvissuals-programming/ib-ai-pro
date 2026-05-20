/**
 * videoService.ts — IB AI Assistant
 *
 * Image-to-Video generation pipeline.
 * Full job infrastructure: queue, job manager, providerGuard, DB persistence.
 *
 * STATUS: Infrastructure complete. Video generation requires a compatible
 * provider (e.g. Veo 2 via Google AI or a third-party video API).
 *
 * TO ACTIVATE:
 *   1. Set VIDEO_PROVIDER_URL and VIDEO_PROVIDER_KEY environment variables.
 *   2. Implement the `callVideoProvider()` function below.
 *   3. Set VIDEO_ENABLED=true.
 *
 * Architecture: Every request flows through
 *   imageQueue.run() → createJob() → providerGuard → result
 *
 * Modes:
 *   cinematic_motion   — slow camera movement, cinematic depth
 *   zoom_parallax      — Ken Burns effect with depth-aware zoom + parallax
 *   social_motion      — fast cuts, dynamic energy, high engagement
 *   subtle_animation   — gentle light movement, minimal transformation
 */
import { withProviderTimeout } from "../lib/providerGuard";
import { logger }              from "../lib/logger";

// ── Types ─────────────────────────────────────────────────────────────────────

export const VIDEO_MODES = [
  "cinematic_motion",
  "zoom_parallax",
  "social_motion",
  "subtle_animation",
] as const;

export type VideoMode = (typeof VIDEO_MODES)[number];

const VIDEO_MODE_DESCRIPTIONS: Record<VideoMode, string> = {
  cinematic_motion: "Slow cinematic camera movement with depth-of-field emphasis",
  zoom_parallax:    "Ken Burns zoom and parallax effect with depth-aware layers",
  social_motion:    "Dynamic fast-cut motion optimized for social media engagement",
  subtle_animation: "Gentle light movement and subtle ambient animation",
};

export interface VideoJobConfig {
  imageBase64: string;
  prompt:      string;
  mode:        VideoMode;
  jobId:       string;
  userId?:     string;
}

export interface VideoResult {
  status:           "completed" | "provider_not_configured";
  videoUrl?:        string;
  durationSeconds?: number;
  resolution?:      string;
  mode:             VideoMode;
  message:          string;
}

// ── Provider check ────────────────────────────────────────────────────────────

function isVideoEnabled(): boolean {
  return process.env["VIDEO_ENABLED"] === "true" &&
    !!process.env["VIDEO_PROVIDER_URL"] &&
    !!process.env["VIDEO_PROVIDER_KEY"];
}

// ── Provider stub ─────────────────────────────────────────────────────────────
// Replace this function body with your provider integration.
// Expected: resolve with a video URL or base64 encoded mp4.

async function callVideoProvider(_config: VideoJobConfig): Promise<string> {
  throw new Error("Video provider not configured");
}

// ── Core generation ───────────────────────────────────────────────────────────

const VIDEO_TIMEOUT_MS = 120_000;

export async function generateVideo(config: VideoJobConfig): Promise<VideoResult> {
  if (!isVideoEnabled()) {
    logger.info(
      { jobId: config.jobId, mode: config.mode },
      "[video] provider not configured — returning infrastructure-ready response",
    );

    return {
      status:  "provider_not_configured",
      mode:    config.mode,
      message: "Video generation infrastructure is ready. " +
               "Set VIDEO_ENABLED=true, VIDEO_PROVIDER_URL, and VIDEO_PROVIDER_KEY " +
               "to activate video generation.",
    };
  }

  logger.info(
    { jobId: config.jobId, mode: config.mode, promptLength: config.prompt.length },
    "[video] generating video",
  );

  const videoUrl = await withProviderTimeout(
    () => callVideoProvider(config),
    VIDEO_TIMEOUT_MS,
    "video-provider",
  );

  return {
    status:          "completed",
    videoUrl,
    mode:            config.mode,
    durationSeconds: 4,
    resolution:      "1280x720",
    message:         "Video generated successfully",
  };
}

// ── Metadata helpers ──────────────────────────────────────────────────────────

export function getVideoModeDescriptions(): Record<VideoMode, string> {
  return { ...VIDEO_MODE_DESCRIPTIONS };
}

export function isValidVideoMode(mode: string): mode is VideoMode {
  return (VIDEO_MODES as readonly string[]).includes(mode);
}
