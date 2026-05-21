/**
 * creatorPresets.ts — IB AI Assistant
 *
 * Static registry of creator workflow presets for image, video, and voice generation.
 * No DB required — presets are curated constants served via GET /api/presets/:type.
 *
 * Structure per preset:
 *   - id:          machine-readable slug
 *   - label:       display name
 *   - description: one-line creator intent
 *   - emoji:       visual icon
 *   - prompt:      injected into generation request
 *   - style / mode / voiceStyle: tool-specific selector override
 */

export interface ImagePreset {
  id:          string;
  label:       string;
  description: string;
  emoji:       string;
  prompt:      string;
  style:       string;
}

export interface VideoPreset {
  id:          string;
  label:       string;
  description: string;
  emoji:       string;
  prompt:      string;
  mode:        string;
}

export interface VoicePreset {
  id:          string;
  label:       string;
  description: string;
  emoji:       string;
  text:        string;
  voiceStyle:  string;
}

// ── Image Presets ──────────────────────────────────────────────────────────────

export const IMAGE_PRESETS: ImagePreset[] = [
  {
    id:          "cinematic",
    label:       "Cinematic",
    description: "Dramatic film-grade lighting and depth",
    emoji:       "🎬",
    prompt:      "cinematic lighting, anamorphic lens flare, film grain, dramatic shadows, 4K movie still",
    style:       "artistic",
  },
  {
    id:          "luxury",
    label:       "Luxury",
    description: "Premium editorial aesthetic",
    emoji:       "💎",
    prompt:      "luxury brand aesthetic, glossy editorial, golden ratio composition, premium materials, soft bokeh, elegance",
    style:       "artistic",
  },
  {
    id:          "afro_futuristic",
    label:       "Afro-Futuristic",
    description: "Bold futuristic African-inspired vision",
    emoji:       "🌍",
    prompt:      "afrofuturism, vibrant African patterns, neon accents, chrome textures, futuristic tribal art, cinematic glow",
    style:       "artistic",
  },
  {
    id:          "viral_tiktok",
    label:       "Viral TikTok",
    description: "High-energy social media hook visual",
    emoji:       "🔥",
    prompt:      "bold colors, high contrast, dynamic energy, social media aesthetic, eye-catching composition, trending visual style",
    style:       "realistic",
  },
  {
    id:          "realistic_ad",
    label:       "Realistic Ad",
    description: "Clean product-ready ad photography",
    emoji:       "📸",
    prompt:      "commercial photography, clean white or neutral background, professional studio lighting, product ad quality, sharp focus",
    style:       "realistic",
  },
  {
    id:          "fashion_editorial",
    label:       "Fashion Editorial",
    description: "High-fashion magazine spread look",
    emoji:       "👗",
    prompt:      "fashion editorial, Vogue magazine aesthetic, dramatic styling, fashion photography, couture, bold pose, studio or urban backdrop",
    style:       "artistic",
  },
];

// ── Video Presets ──────────────────────────────────────────────────────────────

export const VIDEO_PRESETS: VideoPreset[] = [
  {
    id:          "cinematic_motion",
    label:       "Cinematic Motion",
    description: "Slow epic camera pan with depth",
    emoji:       "🎬",
    prompt:      "slow cinematic camera pan, depth of field pull, dramatic lighting shift, film grain, epic atmosphere",
    mode:        "cinematic_motion",
  },
  {
    id:          "social_zoom",
    label:       "Social Zoom",
    description: "Fast dynamic zoom for social reels",
    emoji:       "📱",
    prompt:      "fast dynamic zoom in, vibrant color pop, social media reel energy, punchy motion, high-contrast transition",
    mode:        "social_motion",
  },
  {
    id:          "parallax_reel",
    label:       "Parallax Reel",
    description: "Ken Burns parallax with layered depth",
    emoji:       "🌀",
    prompt:      "Ken Burns effect, parallax depth layers, slow zoom with atmospheric perspective, cinematic parallax motion",
    mode:        "zoom_parallax",
  },
  {
    id:          "luxury_showcase",
    label:       "Luxury Showcase",
    description: "Subtle premium ambient animation",
    emoji:       "✨",
    prompt:      "gentle ambient light movement, luxury product reveal, subtle shimmer, premium slow motion, elegant atmosphere",
    mode:        "subtle_animation",
  },
];

// ── Voice Presets ──────────────────────────────────────────────────────────────

export const VOICE_PRESETS: VoicePreset[] = [
  {
    id:          "narration",
    label:       "Documentary Narration",
    description: "Authoritative cinematic narrator",
    emoji:       "🎙️",
    text:        "In the vast expanse of human creativity, some ideas transcend time. This is the story of one such vision — a moment where technology and artistry converge to create something extraordinary.",
    voiceStyle:  "cinematic_narration",
  },
  {
    id:          "trailer",
    label:       "Movie Trailer",
    description: "Epic blockbuster trailer voice",
    emoji:       "🎬",
    text:        "In a world where boundaries are challenged every day — one platform dares to redefine what's possible. IB AI Studio. The future of creation is here.",
    voiceStyle:  "cinematic_narration",
  },
  {
    id:          "soft_story",
    label:       "Soft Storytelling",
    description: "Warm intimate narrative voice",
    emoji:       "🌸",
    text:        "Sometimes the most powerful stories are told in a whisper. Close your eyes, and let this moment carry you somewhere you've never been before. This is your story.",
    voiceStyle:  "female_soft",
  },
  {
    id:          "energetic_promo",
    label:       "Energetic Promo",
    description: "High-energy product or event promo",
    emoji:       "⚡",
    text:        "Are you ready to level up? Introducing the most powerful AI creative studio you've ever experienced. No limits. No boundaries. Just pure creative power — starting right now.",
    voiceStyle:  "energetic_social",
  },
  {
    id:          "professional_brief",
    label:       "Professional Brief",
    description: "Clear, confident business presentation",
    emoji:       "💼",
    text:        "Welcome to our quarterly overview. Today we'll walk you through our key results, strategic initiatives, and the roadmap that positions us for continued growth in the months ahead.",
    voiceStyle:  "neutral_assistant",
  },
];

// ── Lookup helpers ────────────────────────────────────────────────────────────

export function getPresetsForType(type: string): ImagePreset[] | VideoPreset[] | VoicePreset[] | null {
  if (type === "image") return IMAGE_PRESETS;
  if (type === "video") return VIDEO_PRESETS;
  if (type === "voice") return VOICE_PRESETS;
  return null;
}
