import { useState } from 'react';
import { Copy, Check, Camera, Film, Sparkles, Image, Video } from 'lucide-react';
import { motion } from 'framer-motion';

function CopyBtn({ text, label = '' }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // silently skip
    }
  };

  return (
    <button
      onClick={handleCopy}
      className={`flex items-center gap-1 text-[10px] px-2 py-1 rounded-md transition-all shrink-0 ${
        copied
          ? 'text-green-400 bg-green-400/10'
          : 'text-muted-foreground hover:text-foreground hover:bg-white/6'
      }`}
      aria-label={`Copy ${label}`}
    >
      {copied ? <Check size={9} /> : <Copy size={9} />}
      <span>{copied ? 'Copied!' : 'Copy'}</span>
    </button>
  );
}

function PromptBlock({ label, emoji, text }) {
  return (
    <div className="flex flex-col gap-1.5 py-2.5 border-b border-border/25 last:border-0">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold text-foreground/80">
          {emoji} {label}
        </span>
        <CopyBtn text={text} label={label} />
      </div>
      <p className="text-xs text-muted-foreground leading-relaxed">{text}</p>
    </div>
  );
}

function Section({ icon: Icon, title, children }) {
  return (
    <div className="rounded-xl border border-border/40 bg-background/30 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border/30 bg-secondary/20">
        <Icon size={12} className="text-primary shrink-0" />
        <span className="text-[11px] font-semibold text-foreground tracking-wide uppercase">
          {title}
        </span>
      </div>
      <div className="px-3">{children}</div>
    </div>
  );
}

function AnalysisGrid({ analysis }) {
  const fields = [
    { key: 'subject', label: 'Subject' },
    { key: 'lighting', label: 'Lighting' },
    { key: 'mood', label: 'Mood' },
    { key: 'composition', label: 'Composition' },
    { key: 'colors', label: 'Colors' },
    { key: 'style', label: 'Style' },
    { key: 'environment', label: 'Environment' },
  ];

  return (
    <div className="py-2.5 space-y-1.5">
      {fields.map(({ key, label }) =>
        analysis[key] ? (
          <div key={key} className="flex gap-2 text-xs">
            <span className="text-muted-foreground/60 shrink-0 w-20">{label}</span>
            <span className="text-foreground/85 leading-relaxed">{analysis[key]}</span>
          </div>
        ) : null
      )}
    </div>
  );
}

export function ImageAnalysisCard({ data }) {
  if (!data || typeof data !== 'object') {
    return (
      <p className="text-xs text-muted-foreground">Analysis result unavailable.</p>
    );
  }

  const { analysis = {}, prompts = {} } = data;
  const { imageEdit = {}, videoEdit = '', variants = {} } = prompts;

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="space-y-3 w-full"
    >
      {/* Header */}
      <div className="flex items-center gap-2 pb-1">
        <div className="w-5 h-5 rounded-md bg-primary/15 border border-primary/20 flex items-center justify-center">
          <Camera size={10} className="text-primary" />
        </div>
        <span className="text-xs font-semibold text-foreground">Visual Analysis Complete</span>
      </div>

      {/* Visual Analysis */}
      {Object.keys(analysis).length > 0 && (
        <Section icon={Camera} title="Visual Analysis">
          <AnalysisGrid analysis={analysis} />
        </Section>
      )}

      {/* Image Edit Prompts */}
      {Object.keys(imageEdit).length > 0 && (
        <Section icon={Image} title="Image Edit Prompts">
          <div>
            {imageEdit.cinematic && (
              <PromptBlock label="Cinematic" emoji="🎬" text={imageEdit.cinematic} />
            )}
            {imageEdit.luxury && (
              <PromptBlock label="Luxury" emoji="👑" text={imageEdit.luxury} />
            )}
            {imageEdit.wallpaper && (
              <PromptBlock label="Wallpaper" emoji="🖼️" text={imageEdit.wallpaper} />
            )}
            {imageEdit.canva && (
              <PromptBlock label="Canva Design" emoji="🎨" text={imageEdit.canva} />
            )}
            {imageEdit.tiktok && (
              <PromptBlock label="TikTok" emoji="📱" text={imageEdit.tiktok} />
            )}
          </div>
        </Section>
      )}

      {/* Video Edit Prompt */}
      {videoEdit && (
        <Section icon={Video} title="Video Edit Prompt">
          <div className="py-2.5 flex flex-col gap-2">
            <p className="text-xs text-muted-foreground leading-relaxed">{videoEdit}</p>
            <div className="flex justify-end">
              <CopyBtn text={videoEdit} label="video prompt" />
            </div>
          </div>
        </Section>
      )}

      {/* Creative Variants */}
      {Object.keys(variants).length > 0 && (
        <Section icon={Sparkles} title="Creative Variants">
          <div>
            {variants.viral && (
              <PromptBlock label="Viral Social Media" emoji="🔥" text={variants.viral} />
            )}
            {variants.luxuryBrand && (
              <PromptBlock label="Luxury Brand Ad" emoji="💎" text={variants.luxuryBrand} />
            )}
            {variants.cinematic && (
              <PromptBlock label="Cinematic Film" emoji="🎞️" text={variants.cinematic} />
            )}
            {variants.aesthetic && (
              <PromptBlock label="Aesthetic Montage" emoji="✨" text={variants.aesthetic} />
            )}
          </div>
        </Section>
      )}
    </motion.div>
  );
}
