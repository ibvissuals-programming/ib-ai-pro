/**
 * videoService.ts — IB AI Assistant
 *
 * Image-to-Video generation pipeline using Gemini Veo.
 *
 * Architecture:
 *   imageQueue.run() → createJob() → Gemini Veo (async poll) → mp4 file
 *
 * Provider: Gemini Veo (veo-002) via @workspace/integrations-gemini-ai
 *   - Uses GEMINI_API_KEY — no separate VIDEO_PROVIDER_URL/KEY required
 *   - If Veo is not enabled for this API key: returns provider_not_configured
 *   - Video stored to artifacts/data/video/{jobId}.mp4
 *   - Serve via GET /api/video/serve/:jobId
 *
 * Async job pattern:
 *   Route creates job → fires background generation → responds immediately
 *   Client polls GET /api/video/status/:jobId until status changes
 *
 * Modes:
 *   cinematic_motion   — slow camera movement, cinematic depth
 *   zoom_parallax      — Ken Burns effect with depth-aware zoom + parallax
 *   social_motion      — fast cuts, dynamic energy, high engagement
 *   subtle_animation   — gentle light movement, minimal transformation
 */
import * as fs   from "fs";
import * as path from "path";
import { ai }                  from "@workspace/integrations-gemini-ai";
import { withProviderTimeout } from "../lib/providerGuard";
import { isGeminiConfigured }  from "../lib/geminiEnv";
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

const VIDEO_MODE_PROMPTS: Record<VideoMode, string> = {
  cinematic_motion: "Slow, cinematic camera push-in. Shallow depth of field. Gentle parallax. Film-quality motion. No jump cuts. Continuous smooth movement.",
  zoom_parallax:    "Ken Burns zoom effect with natural depth separation. Foreground elements drift slightly as background zooms. Smooth, organic parallax motion.",
  social_motion:    "Dynamic, energetic motion. Quick camera pans and zoom pulses. High-energy visual flow optimized for social media attention retention.",
  subtle_animation: "Very gentle, barely perceptible movement. Subtle light ripple and ambient breathing motion. Peaceful, meditative quality.",
};

export interface VideoJobConfig {
  imageBase64: string;
  prompt:      string;
  mode:        VideoMode;
  jobId:       string;
  userId?:     string;
}

export type VideoStatus =
  | "processing"
  | "completed"
  | "failed"
  | "provider_not_configured";

export interface VideoResult {
  status:           VideoStatus;
  videoUrl?:        string;
  videoFilePath?:   string;
  durationSeconds?: number;
  resolution?:      string;
  mode:             VideoMode;
  message:          string;
}

// ── Storage ────────────────────────────────────────────────────────────────────

const VIDEO_DIR = path.resolve(
  __dirname,
  "../../../../artifacts/data/video",
);

function ensureVideoDir(): void {
  fs.mkdirSync(VIDEO_DIR, { recursive: true });
}

ensureVideoDir();

export function getVideoFilePath(jobId: string): string {
  return path.join(VIDEO_DIR, `${jobId}.mp4`);
}

export function videoFileExists(jobId: string): boolean {
  try { return fs.existsSync(getVideoFilePath(jobId)); }
  catch { return false; }
}

// ── In-memory result store ────────────────────────────────────────────────────
// Stores the final result URL and status for completed/failed video jobs.
// Survives as long as the process is alive (resets on restart — same as jobs).

interface VideoResultEntry {
  status:  VideoStatus;
  url?:    string;
  error?:  string;
  mode:    VideoMode;
  durationSeconds?: number;
}

const videoResults = new Map<string, VideoResultEntry>();

export function setVideoResult(jobId: string, entry: VideoResultEntry): void {
  videoResults.set(jobId, entry);
}

export function getVideoResult(jobId: string): VideoResultEntry | undefined {
  return videoResults.get(jobId);
}

// ── Provider check ────────────────────────────────────────────────────────────
//
// Video requires BOTH a configured Gemini key AND the VIDEO_ENABLED flag set
// to "true". Checking only isGeminiConfigured() is insufficient — the Veo
// model requires separate API provisioning. Without VIDEO_ENABLED=true the
// route returns a clean 501 feature_disabled instead of firing a job that
// immediately fails with provider_not_configured.

export function isVideoEnabled(): boolean {
  return isGeminiConfigured() && process.env["VIDEO_ENABLED"] === "true";
}

// ── Error classifier ──────────────────────────────────────────────────────────

function isProviderUnavailableError(err: unknown): boolean {
  const msg = err instanceof Error
    ? `${err.message} ${(err as { code?: string }).code ?? ""}`
    : String(err);
  return (
    msg.includes("404") ||
    msg.includes("NOT_FOUND") ||
    msg.includes("PERMISSION_DENIED") ||
    msg.includes("403") ||
    msg.includes("not found") ||
    msg.includes("not supported") ||
    msg.includes("not available") ||
    msg.includes("UNIMPLEMENTED") ||
    msg.includes("veo") && msg.toLowerCase().includes("access")
  );
}

// ── Image parsing helpers ─────────────────────────────────────────────────────

function parseImageDataUrl(dataUrl: string): { base64: string; mimeType: string } {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (match) {
    return { mimeType: match[1]!, base64: match[2]! };
  }
  // Assume raw base64 jpeg if no data URL prefix
  return { mimeType: "image/jpeg", base64: dataUrl };
}

// ── Motion prompt builder ─────────────────────────────────────────────────────

function buildVideoPrompt(mode: VideoMode, userPrompt: string): string {
  const modeDirective = VIDEO_MODE_PROMPTS[mode];
  if (!userPrompt.trim()) return modeDirective;
  return `${userPrompt.trim()}. ${modeDirective}`;
}

// ── Core generation ───────────────────────────────────────────────────────────

const VIDEO_TIMEOUT_MS    = 120_000;  // 2 minutes total budget
const VEO_POLL_INTERVAL_MS = 5_000;   // poll every 5 seconds
const VEO_MODEL            = "veo-002";
const VIDEO_DURATION_SECS  = 5;

export async function generateVideo(config: VideoJobConfig): Promise<VideoResult> {
  if (!isVideoEnabled()) {
    logger.info({ jobId: config.jobId }, "[video] Gemini not configured — returning provider_not_configured");
    return {
      status:  "provider_not_configured",
      mode:    config.mode,
      message: "Video generation requires a configured GEMINI_API_KEY.",
    };
  }

  ensureVideoDir();

  const { base64, mimeType } = parseImageDataUrl(config.imageBase64);
  const fullPrompt = buildVideoPrompt(config.mode, config.prompt);

  logger.info(
    { jobId: config.jobId, mode: config.mode, promptLen: fullPrompt.length, mimeType },
    "[video] starting Gemini Veo generation",
  );

  try {
    // ── Launch Veo operation ─────────────────────────────────────────────────
    const operationPromise = withProviderTimeout(
      async () => {
        // Start the generation operation
        const operation = await (ai.models as unknown as {
          generateVideos: (params: {
            model:   string;
            prompt:  string;
            image?:  { imageBytes: string; mimeType: string };
            config?: {
              numberOfVideos:    number;
              durationSeconds:   number;
              aspectRatio:       string;
              personGeneration:  string;
              enhancePrompt:     boolean;
            };
          }) => Promise<{
            done:     boolean;
            result?:  { generatedVideos?: Array<{ video?: { videoBytes?: string; uri?: string } }> };
            refresh?: () => Promise<unknown>;
            wait?:    () => Promise<unknown>;
          }>;
        }).generateVideos({
          model:  VEO_MODEL,
          prompt: fullPrompt,
          image: {
            imageBytes: base64,
            mimeType:   mimeType,
          },
          config: {
            numberOfVideos:   1,
            durationSeconds:  VIDEO_DURATION_SECS,
            aspectRatio:      "16:9",
            personGeneration: "allow_adult",
            enhancePrompt:    false,
          },
        });

        // Poll until done or timeout
        let op = operation;
        const deadline = Date.now() + VIDEO_TIMEOUT_MS - 10_000; // 10s buffer for file write

        while (!op.done && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, VEO_POLL_INTERVAL_MS));
          if (typeof op.refresh === "function") {
            op = (await op.refresh()) as typeof op;
          } else if (typeof op.wait === "function") {
            op = (await op.wait()) as typeof op;
            break;
          } else {
            break;
          }
        }

        if (!op.done) {
          throw new Error("Video generation timed out waiting for Veo operation");
        }

        return op.result;
      },
      VIDEO_TIMEOUT_MS,
      "gemini-veo",
    );

    const result = await operationPromise;

    const video = result?.generatedVideos?.[0];
    const videoBytes = video?.video?.videoBytes;

    if (!videoBytes) {
      throw new Error("Veo returned no video data");
    }

    // ── Write to disk ────────────────────────────────────────────────────────
    const filePath = getVideoFilePath(config.jobId);
    const mp4Buffer = Buffer.from(videoBytes, "base64");
    fs.writeFileSync(filePath, mp4Buffer);

    const videoUrl = `/api/video/serve/${config.jobId}`;

    logger.info(
      { jobId: config.jobId, filePath, bytes: mp4Buffer.length },
      "[video] Veo video written to disk",
    );

    setVideoResult(config.jobId, {
      status:          "completed",
      url:             videoUrl,
      mode:            config.mode,
      durationSeconds: VIDEO_DURATION_SECS,
    });

    return {
      status:          "completed",
      videoUrl,
      videoFilePath:   filePath,
      durationSeconds: VIDEO_DURATION_SECS,
      resolution:      "1280x720",
      mode:            config.mode,
      message:         "Video generated successfully",
    };

  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);

    if (isProviderUnavailableError(err)) {
      logger.info(
        { jobId: config.jobId, err: errMsg },
        "[video] Veo model not available for this API key — returning provider_not_configured",
      );
      setVideoResult(config.jobId, {
        status:  "provider_not_configured",
        mode:    config.mode,
      });
      return {
        status:  "provider_not_configured",
        mode:    config.mode,
        message: "Video generation (Veo) is not enabled for this API key. Contact your administrator.",
      };
    }

    logger.error({ err, jobId: config.jobId }, "[video] Veo generation failed");
    setVideoResult(config.jobId, {
      status: "failed",
      error:  errMsg.slice(0, 200),
      mode:   config.mode,
    });
    throw err;
  }
}

// ── TTL cleanup ───────────────────────────────────────────────────────────────

const VIDEO_TTL_MS = 24 * 60 * 60 * 1000;

export function cleanOldVideoFiles(): void {
  try {
    ensureVideoDir();
    const files = fs.readdirSync(VIDEO_DIR);
    const now   = Date.now();
    let cleaned = 0;
    for (const file of files) {
      if (!file.endsWith(".mp4")) continue;
      const fp   = path.join(VIDEO_DIR, file);
      const stat = fs.statSync(fp);
      if (now - stat.mtimeMs > VIDEO_TTL_MS) {
        fs.unlinkSync(fp);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      logger.debug({ cleaned }, "[video] TTL cleanup — old video files removed");
    }
  } catch (err) {
    logger.debug({ err }, "[video] TTL cleanup failed (non-fatal)");
  }
}

// Run TTL cleanup on load
cleanOldVideoFiles();

// ── Metadata helpers ──────────────────────────────────────────────────────────

export function getVideoModeDescriptions(): Record<VideoMode, string> {
  return { ...VIDEO_MODE_DESCRIPTIONS };
}

export function isValidVideoMode(mode: string): mode is VideoMode {
  return (VIDEO_MODES as readonly string[]).includes(mode);
}
