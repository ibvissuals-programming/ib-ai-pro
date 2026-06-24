/**
 * POST /api/tiktok/transcribe
 *
 * ⚠️  BEST-EFFORT feature — depends on the unofficial tikwm.com download proxy.
 *     This endpoint WILL break without notice when tikwm.com changes its API.
 *     Every error path returns { success:false, code:"feature_unavailable" } so
 *     the caller can show a graceful "unavailable" message. This route MUST
 *     never crash or affect any other feature.
 *
 * Flow:
 *   1. Validate TikTok URL.
 *   2. Call tikwm.com API → get direct audio/video download URL + metadata.
 *   3. Download audio (capped at 20 MB).
 *   4. Transcribe with Groq Whisper (whisper-large-v3-turbo, free tier).
 *   5. Return { transcript, meta: { title, author, url } }.
 *
 * Auth:   policyEngine (requireAuth + rate limit, 0 credit cost)
 * Rate:   5 requests / min / user
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { policyEngine, deductRequestCredits, appendCreditHeaders } from "../middleware/policyEngine";
import { logger } from "../lib/logger";

const router = Router();

const TIKWM_API           = "https://tikwm.com/api/";
const GROQ_WHISPER_URL    = "https://api.groq.com/openai/v1/audio/transcriptions";
const WHISPER_MODEL       = "whisper-large-v3-turbo";
const MAX_AUDIO_BYTES     = 20 * 1024 * 1024; // 20 MB — Groq limit is 25 MB
const TIKWM_TIMEOUT_MS    = 12_000;
const DOWNLOAD_TIMEOUT_MS = 35_000;
const WHISPER_TIMEOUT_MS  = 60_000;

const TikTokSchema = z.object({
  url: z
    .string()
    .url("Must be a valid URL")
    .regex(/tiktok\.com|vm\.tiktok\.com|vt\.tiktok\.com/i, "Must be a TikTok URL"),
});

interface TikwmData {
  code?: number;
  data?: {
    music?:  string;
    play?:   string;
    wmplay?: string;
    title?:  string;
    author?: { nickname?: string };
  };
}

function unavailable(message: string) {
  return { success: false as const, code: "feature_unavailable", error: message };
}

router.post(
  "/tiktok/transcribe",
  policyEngine({
    cost: 0,
    rateKey: "tiktok_transcribe",
    rateMax: 5,
    rateWindowMs: 60_000,
    allowRecovery: false,
  }),
  async (req: Request, res: Response) => {
    const parsed = TikTokSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(unavailable("Invalid TikTok URL. Paste a full tiktok.com link."));
      return;
    }

    const groqKey = process.env.GROQ_API_KEY;
    if (!groqKey) {
      res.status(503).json(unavailable("Transcription service is not configured on this server."));
      return;
    }

    const { url } = parsed.data;
    logger.info({ url }, "[tiktok] transcribe request");

    // ── Step 1: resolve download URL via tikwm.com ─────────────────────────────
    let audioUrl   = "";
    let videoTitle = "TikTok video";
    let videoAuthor = "";

    try {
      const ctrl  = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIKWM_TIMEOUT_MS);

      const tikwmRes = await fetch(TIKWM_API, {
        method:  "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body:    new URLSearchParams({ url, hd: "1" }).toString(),
        signal:  ctrl.signal,
      });
      clearTimeout(timer);

      if (!tikwmRes.ok) throw new Error(`tikwm HTTP ${tikwmRes.status}`);

      const body = await tikwmRes.json() as TikwmData;
      if (body.code !== 0 || !body.data) throw new Error(`tikwm code=${body.code}`);

      audioUrl    = body.data.music ?? body.data.play ?? body.data.wmplay ?? "";
      videoTitle  = body.data.title  ?? "TikTok video";
      videoAuthor = body.data.author?.nickname ?? "";

      if (!audioUrl) throw new Error("tikwm returned no playable URL");
    } catch (err) {
      logger.warn({ err }, "[tiktok] tikwm proxy failed");
      res.status(503).json(
        unavailable(
          "TikTok download proxy is currently unavailable. " +
          "This is a best-effort feature that may break without notice — try again in a moment.",
        ),
      );
      return;
    }

    // ── Step 2: download audio ─────────────────────────────────────────────────
    let audioBuffer: Buffer;
    try {
      const ctrl  = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), DOWNLOAD_TIMEOUT_MS);

      const dlRes = await fetch(audioUrl, { signal: ctrl.signal });
      clearTimeout(timer);

      if (!dlRes.ok) throw new Error(`audio download HTTP ${dlRes.status}`);

      const raw = Buffer.from(await dlRes.arrayBuffer());
      if (raw.length === 0) throw new Error("empty audio download");
      if (raw.length > MAX_AUDIO_BYTES) throw new Error(`audio too large (${raw.length} bytes)`);
      audioBuffer = raw;
    } catch (err) {
      logger.warn({ err }, "[tiktok] audio download failed");
      res.status(503).json(
        unavailable(
          "Could not download audio from TikTok. " +
          "The video may be private, regional, or the download link may have expired.",
        ),
      );
      return;
    }

    // ── Step 3: transcribe with Groq Whisper ───────────────────────────────────
    let transcript: string;
    try {
      const formData = new FormData();
      formData.append("file",            new Blob([audioBuffer], { type: "audio/mpeg" }), "audio.mp3");
      formData.append("model",           WHISPER_MODEL);
      formData.append("response_format", "text");

      const ctrl  = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), WHISPER_TIMEOUT_MS);

      const whisperRes = await fetch(GROQ_WHISPER_URL, {
        method:  "POST",
        headers: { Authorization: `Bearer ${groqKey}` },
        body:    formData,
        signal:  ctrl.signal,
      });
      clearTimeout(timer);

      if (!whisperRes.ok) {
        const detail = await whisperRes.text().catch(() => "");
        throw new Error(`Whisper ${whisperRes.status}: ${detail.slice(0, 120)}`);
      }

      transcript = (await whisperRes.text()).trim();
      if (!transcript) throw new Error("Whisper returned an empty transcript");
    } catch (err) {
      logger.warn({ err }, "[tiktok] Groq Whisper failed");
      res.status(503).json(
        unavailable("Transcription failed. Groq Whisper may be temporarily unavailable — please try again."),
      );
      return;
    }

    logger.info(
      { chars: transcript.length, author: videoAuthor, title: videoTitle },
      "[tiktok] transcription complete",
    );

    deductRequestCredits(req);
    appendCreditHeaders(req, res);

    res.json({
      success:    true,
      transcript,
      meta: { title: videoTitle, author: videoAuthor, url },
    });
  },
);

export default router;
