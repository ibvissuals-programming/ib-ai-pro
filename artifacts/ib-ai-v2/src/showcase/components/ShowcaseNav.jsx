import { motion } from 'framer-motion';
import { ChevronLeft, ChevronRight, X, RotateCcw, Pause, Play } from 'lucide-react';
import { Link } from 'wouter';

const SCENE_LABELS = ['Intro', 'Chat AI', 'Image Tools', 'Capabilities', 'Dashboard'];

export function ShowcaseNav({
  current,
  total,
  progress,
  paused,
  visible = true,
  onPrev,
  onNext,
  onJump,
  onTogglePause,
  onRestart,
}) {
  if (!visible) return null;

  return (
    <>
      {/* Top progress bar */}
      <div className="fixed top-0 left-0 right-0 z-50 h-0.5 bg-white/5">
        <motion.div
          className="h-full bg-primary"
          style={{ width: `${progress * 100}%` }}
          transition={{ ease: 'linear' }}
        />
      </div>

      {/* Top-right exit */}
      <div className="fixed top-4 right-4 z-50 flex items-center gap-2">
        <Link
          to="/ceo/dashboard"
          className="flex items-center gap-1.5 text-xs text-white/50 hover:text-white/90 transition-colors bg-white/5 hover:bg-white/10 border border-white/8 px-3 py-1.5 rounded-full backdrop-blur-sm"
        >
          <X size={11} />
          Exit Showcase
        </Link>
      </div>

      {/* Bottom-right compact pill */}
      <div className="fixed bottom-[40px] right-[30px] z-50">
        <div className="flex items-center gap-1 bg-black/50 border border-white/10 backdrop-blur-md rounded-full px-2 py-1.5">

          {/* Scene dots */}
          <div className="flex items-center gap-1 pl-1 pr-0.5">
            {Array.from({ length: total }).map((_, i) => (
              <button
                key={i}
                onClick={() => onJump(i)}
                title={SCENE_LABELS[i] ?? `Scene ${i + 1}`}
                className="transition-all duration-300 rounded-full focus:outline-none"
                style={{
                  width: i === current ? 14 : 5,
                  height: 5,
                  background: i === current
                    ? 'hsl(var(--primary))'
                    : i < current
                    ? 'rgba(255,255,255,0.35)'
                    : 'rgba(255,255,255,0.12)',
                }}
              />
            ))}
          </div>

          <div className="w-px h-3.5 bg-white/10 mx-0.5" />

          {/* Controls */}
          <button
            onClick={onRestart}
            className="p-1.5 rounded-full text-white/40 hover:text-white/80 hover:bg-white/8 transition-colors"
            title="Restart"
          >
            <RotateCcw size={11} />
          </button>

          <button
            onClick={onPrev}
            disabled={current === 0}
            className="p-1.5 rounded-full text-white/60 hover:text-white hover:bg-white/8 transition-colors disabled:opacity-25"
            title="Previous"
          >
            <ChevronLeft size={13} />
          </button>

          <button
            onClick={onTogglePause}
            className="px-2.5 py-1 rounded-full bg-primary/90 hover:bg-primary text-white text-[10px] font-medium transition-colors flex items-center gap-1"
          >
            {paused ? <Play size={9} /> : <Pause size={9} />}
            {paused ? 'Play' : 'Pause'}
          </button>

          <button
            onClick={onNext}
            disabled={current === total - 1}
            className="p-1.5 rounded-full text-white/60 hover:text-white hover:bg-white/8 transition-colors disabled:opacity-25"
            title="Next"
          >
            <ChevronRight size={13} />
          </button>

          <div className="w-px h-3.5 bg-white/10 mx-0.5" />

          <span className="text-[10px] text-white/30 pr-1 tabular-nums">
            {current + 1}/{total}
          </span>
        </div>
      </div>
    </>
  );
}
