/**
 * ttsService.ts — IB AI Assistant
 *
 * Text-to-Speech engine powered by Gemini 2.0 Flash audio generation.
 * Runs through the existing imageQueue for concurrency control and
 * providerGuard for timeout + error safety.
 *
 * Output: PCM L16 (big-endian) → packaged as WAV (little-endian PCM)
 * Storage: local filesystem at artifacts/data/audio/{jobId}.wav
 * Serve: GET /api/tts/serve/:id
 *
 * Voice styles → Gemini prebuilt voice names:
 *   cinematic_narration → Charon  (deep, gravelly, dramatic)
 *   female_soft         → Aoede   (warm, gentle female)
 *   male_deep           → Fenrir  (strong, deep male)
 *   energetic_social    → Puck    (upbeat, expressive)
 *   neutral_assistant   → Leda    (clear, neutral, professional)
 */
import * as fs   from "fs";
import * as path from "path";
import { ai }                  from "@workspace/integrations-gemini-ai";
import { withProviderTimeout } from "../lib/providerGuard";
import { logger }              from "../lib/logger";

// ── Storage directory ─────────────────────────────────────────────────────────

const AUDIO_DIR = path.resolve(
  __dirname,
  "../../../../artifacts/data/audio",
);

function ensureAudioDir(): void {
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
}

ensureAudioDir();

// ── Types ─────────────────────────────────────────────────────────────────────

export const VOICE_STYLES = [
  "cinematic_narration",
  "female_soft",
  "male_deep",
  "energetic_social",
  "neutral_assistant",
] as const;

export type VoiceStyle = (typeof VOICE_STYLES)[number];

const VOICE_MAP: Record<VoiceStyle, string> = {
  cinematic_narration: "Charon",
  female_soft:         "Aoede",
  male_deep:           "Fenrir",
  energetic_social:    "Puck",
  neutral_assistant:   "Leda",
};

export interface TtsResult {
  audioFile:          string;
  audioFilename:      string;
  mimeType:           "audio/wav";
  durationEstimateMs: number;
  voiceStyle:         VoiceStyle;
  voiceName:          string;
  textLength:         number;
  sampleRate:         number;
}

// ── WAV packager ──────────────────────────────────────────────────────────────
// Gemini returns L16 big-endian PCM. WAV requires little-endian PCM.
// Swap byte order then prepend the 44-byte RIFF header.

function swapEndianness(buf: Buffer): Buffer {
  const out = Buffer.allocUnsafe(buf.length);
  for (let i = 0; i < buf.length - 1; i += 2) {
    out[i]     = buf[i + 1]!;
    out[i + 1] = buf[i]!;
  }
  return out;
}

function buildWavBuffer(
  pcmBigEndian: Buffer,
  sampleRate    = 24_000,
  channels      = 1,
  bitsPerSample = 16,
): Buffer {
  const pcm      = swapEndianness(pcmBigEndian);
  const dataSize = pcm.length;
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);

  const header = Buffer.allocUnsafe(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);                // PCM = 1
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcm]);
}

// ── Core generation ───────────────────────────────────────────────────────────

const TTS_TIMEOUT_MS = 45_000;
const SAMPLE_RATE    = 24_000;

export async function generateSpeech(
  text:       string,
  voiceStyle: VoiceStyle,
  jobId:      string,
): Promise<TtsResult> {
  ensureAudioDir();

  const voiceName = VOICE_MAP[voiceStyle];

  logger.info(
    { jobId, voiceStyle, voiceName, textLength: text.length },
    "[tts] generating speech",
  );

  const response = await withProviderTimeout(
    () => (ai.models.generateContent as Function)({
      model:    "gemini-2.0-flash-exp",
      contents: [{ role: "user", parts: [{ text }] }],
      config: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName },
          },
        },
      },
    }),
    TTS_TIMEOUT_MS,
    "gemini-tts",
  ) as Awaited<ReturnType<typeof ai.models.generateContent>>;

  const candidates = (response as any).candidates ?? [];
  const parts: Array<{ inlineData?: { mimeType?: string; data?: string } }> =
    candidates[0]?.content?.parts ?? [];

  const audioPart = parts.find(
    (p) => typeof p.inlineData?.mimeType === "string" &&
            p.inlineData.mimeType.includes("audio"),
  );

  if (!audioPart?.inlineData?.data) {
    throw new Error("TTS provider returned no audio data");
  }

  const pcmBuffer = Buffer.from(audioPart.inlineData.data, "base64");
  const wavBuffer = buildWavBuffer(pcmBuffer, SAMPLE_RATE);

  // Samples = bytes / 2 (16-bit), duration = samples / sampleRate
  const durationEstimateMs = Math.round((pcmBuffer.length / 2 / SAMPLE_RATE) * 1000);

  const filename = `${jobId}.wav`;
  const filePath = path.join(AUDIO_DIR, filename);
  fs.writeFileSync(filePath, wavBuffer);

  logger.info(
    { jobId, filePath, durationEstimateMs, voiceName, wavBytes: wavBuffer.length },
    "[tts] audio written",
  );

  return {
    audioFile:          filePath,
    audioFilename:      filename,
    mimeType:           "audio/wav",
    durationEstimateMs,
    voiceStyle,
    voiceName,
    textLength:         text.length,
    sampleRate:         SAMPLE_RATE,
  };
}

// ── File access ───────────────────────────────────────────────────────────────

export function getAudioFilePath(jobId: string): string {
  return path.join(AUDIO_DIR, `${jobId}.wav`);
}

export function audioFileExists(jobId: string): boolean {
  try {
    return fs.existsSync(getAudioFilePath(jobId));
  } catch {
    return false;
  }
}

// ── TTL cleanup ────────────────────────────────────────────────────────────────
// Audio files older than 24 hours are deleted on each server start.

const AUDIO_TTL_MS = 24 * 60 * 60 * 1000;

export function cleanOldAudioFiles(): void {
  try {
    ensureAudioDir();
    const files = fs.readdirSync(AUDIO_DIR);
    const now   = Date.now();
    let cleaned = 0;

    for (const file of files) {
      if (!file.endsWith(".wav")) continue;
      const filePath = path.join(AUDIO_DIR, file);
      const stat     = fs.statSync(filePath);
      if (now - stat.mtimeMs > AUDIO_TTL_MS) {
        fs.unlinkSync(filePath);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.debug({ cleaned }, "[tts] TTL cleanup — old audio files removed");
    }
  } catch (err) {
    logger.debug({ err }, "[tts] TTL cleanup failed (non-fatal)");
  }
}
