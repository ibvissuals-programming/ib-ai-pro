/**
 * presets.ts — IB AI Assistant
 *
 * GET /api/presets/:type — returns creator workflow presets
 *   type: "image" | "video" | "voice"
 *
 * No auth required — presets are public read-only static data.
 */
import { Router, type Request, type Response } from "express";
import { getPresetsForType } from "../lib/creatorPresets";

const router = Router();

router.get("/presets/:type", (req: Request, res: Response) => {
  const { type } = req.params;
  const presets = getPresetsForType(type as string);

  if (!presets) {
    res.status(400).json({
      success: false,
      error:   `Unknown preset type: ${type}. Valid types: image, video, voice`,
    });
    return;
  }

  res.json({ success: true, type, presets });
});

export default router;
