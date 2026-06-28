import { motion } from 'framer-motion';
import { ChevronLeft, ChevronRight, X, RotateCcw, Pause, Play } from 'lucide-react';
import { Link } from 'wouter';

const SCENE_LABELS = ['Intro', 'Chat AI', 'Image Tools', 'Capabilities', 'Dashboard'];

export function ShowcaseNav({
  current,
  total,
  progress,
  paused,
  onPrev,
  onNext,
  onJump,
  onTogglePause,
  onRestart,
}) {
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

      {/* Bottom controls */}
      <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex flex-col items-center gap-3">
        {/* Scene dots */}
        <div className="flex items-center gap-1.5">
          {Array.from({ length: total }).map((_, i) => (
            <button
              key={i}
              onClick={() => onJump(i)}
              title={SCENE_LABELS[i] ?? `Scene ${i + 1}`}
              className="transition-all duration-300 rounded-full focus:outline-none"
              style={{
                width: i === current ? 20 : 6,
                height: 6,
                background: i === current
                  ? 'hsl(var(--primary))'
                  : i < current
                  ? 'rgba(255,255,255,0.35)'
                  : 'rgba(255,255,255,0.12)',
              }}
            />
          ))}
        </div>

        {/* Controls */}
        <div className="flex items-center gap-1 bg-black/40 border border-white/8 backdrop-blur-md rounded-full px-2 py-1.5">
          <button
            onClick={onRestart}
            className="p-1.5 rounded-full text-white/40 hover:text-white/80 hover:bg-white/8 transition-colors"
            title="Restart"
          >
            <RotateCcw size={12} />
          </button>

          <button
            onClick={onPrev}
            disabled={current === 0}
            className="p-1.5 rounded-full text-white/60 hover:text-white hover:bg-white/8 transition-colors disabled:opacity-25"
            title="Previous"
          >
            <ChevronLeft size={14} />
          </button>

          <button
            onClick={onTogglePause}
            className="px-3 py-1 rounded-full bg-primary/90 hover:bg-primary text-white text-[11px] font-medium transition-colors flex items-center gap-1.5"
          >
            {paused ? <Play size={10} /> : <Pause size={10} />}
            {paused ? 'Play' : 'Pause'}
          </button>

          <button
            onClick={onNext}
            disabled={current === total - 1}
            className="p-1.5 rounded-full text-white/60 hover:text-white hover:bg-white/8 transition-colors disabled:opacity-25"
            title="Next"
          >
            <ChevronRight size={14} />
          </button>

          <div className="w-px h-4 bg-white/10 mx-0.5" />

          <span className="text-[10px] text-white/30 pr-1 tabular-nums">
            {current + 1}/{total}
          </span>
        </div>

        {/* Scene label */}
        <motion.span
          key={current}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          className="text-[10px] text-white/30 tracking-widest uppercase"
        >
          {SCENE_LABELS[current] ?? `Scene ${current + 1}`}
        </motion.span>
      </div>
    </>
  );
}
