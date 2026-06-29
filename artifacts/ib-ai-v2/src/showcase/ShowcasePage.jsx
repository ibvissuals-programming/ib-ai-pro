import { useState, useEffect, useRef, useCallback } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { SceneLanding }    from './scenes/SceneLanding';
import { SceneChat }       from './scenes/SceneChat';
import { SceneImageTools } from './scenes/SceneImageTools';
import { SceneFeatures }   from './scenes/SceneFeatures';
import { SceneDashboard }  from './scenes/SceneDashboard';
import { ShowcaseNav }     from './components/ShowcaseNav';

// ── Scene registry ─────────────────────────────────────────────────────────────
//   duration: ms before auto-advancing (null = stay forever)
const SCENES = [
  { id: 'landing',   Component: SceneLanding,   duration: 5500  },
  { id: 'chat',      Component: SceneChat,       duration: 10000 },
  { id: 'image',     Component: SceneImageTools, duration: 9000  },
  { id: 'features',  Component: SceneFeatures,   duration: 6500  },
  { id: 'dashboard', Component: SceneDashboard,  duration: null  },
];

// Slide transition variants — cross-fade + subtle zoom
const variants = {
  enter:  (dir) => ({ opacity: 0, scale: dir >= 0 ? 1.03 : 0.97, filter: 'blur(4px)' }),
  center: {          opacity: 1, scale: 1,                         filter: 'blur(0px)' },
  exit:   (dir) => ({ opacity: 0, scale: dir >= 0 ? 0.97 : 1.03, filter: 'blur(4px)' }),
};
const transition = { duration: 0.55, ease: [0.22, 1, 0.36, 1] };

// ── Main component ─────────────────────────────────────────────────────────────
export default function ShowcasePage() {
  const [current, setCurrent]   = useState(0);
  const [dir, setDir]           = useState(1);     // 1=forward, -1=backward
  const [paused, setPaused]     = useState(false);
  const [progress, setProgress] = useState(0);
  const [navVisible, setNavVisible] = useState(true);

  const timerRef    = useRef(null);
  const startRef    = useRef(null);
  const progressRef = useRef(null);

  const total = SCENES.length;

  // ── Scene navigation ──
  const goTo = useCallback((index, direction) => {
    const clamped = Math.max(0, Math.min(total - 1, index));
    setDir(direction ?? (clamped > current ? 1 : -1));
    setCurrent(clamped);
    setProgress(0);
  }, [current, total]);

  const goNext = useCallback(() => {
    if (current < total - 1) goTo(current + 1, 1);
  }, [current, total, goTo]);

  const goPrev = useCallback(() => {
    if (current > 0) goTo(current - 1, -1);
  }, [current, goTo]);

  const restart = useCallback(() => goTo(0, 1), [goTo]);

  // ── Auto-advance timer ──
  useEffect(() => {
    clearTimeout(timerRef.current);
    cancelAnimationFrame(progressRef.current);
    setProgress(0);

    const duration = SCENES[current].duration;
    if (!duration || paused) return;

    startRef.current = performance.now();

    // Smooth progress bar via rAF
    function tick(now) {
      const elapsed = now - startRef.current;
      const p = Math.min(elapsed / duration, 1);
      setProgress(p);
      if (p < 1) {
        progressRef.current = requestAnimationFrame(tick);
      }
    }
    progressRef.current = requestAnimationFrame(tick);

    timerRef.current = setTimeout(() => {
      if (current < total - 1) goTo(current + 1, 1);
    }, duration);

    return () => {
      clearTimeout(timerRef.current);
      cancelAnimationFrame(progressRef.current);
    };
  }, [current, paused, total]);   // goTo intentionally excluded — stable enough

  // ── Keyboard shortcuts ──
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'ArrowRight' || e.key === 'l') goNext();
      if (e.key === 'ArrowLeft'  || e.key === 'h') goPrev();
      if (e.key === ' ')                            { e.preventDefault(); setPaused(p => !p); }
      if (e.key === 'r')                            restart();
      if (e.key === 'Escape')                       window.location.href = '/ceo/dashboard';
      if (e.key === 'H')                            setNavVisible(v => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goNext, goPrev, restart]);

  const { Component } = SCENES[current];

  return (
    <div
      className="relative w-screen h-screen overflow-hidden bg-background"
      style={{ userSelect: 'none' }}
    >
      {/* ── Ambient background glow (persistent across scenes) ── */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        <motion.div
          className="absolute rounded-full"
          style={{
            top: '10%', left: '50%', translateX: '-50%',
            width: 1000, height: 600,
            background: 'hsl(217 91% 60% / 0.04)',
            filter: 'blur(140px)',
          }}
          animate={{ scale: [1, 1.06, 1], opacity: [0.7, 1, 0.7] }}
          transition={{ duration: 8, repeat: Infinity, ease: 'easeInOut' }}
        />
        <motion.div
          className="absolute rounded-full"
          style={{
            bottom: '5%', right: '15%',
            width: 400, height: 400,
            background: 'hsl(270 60% 60% / 0.03)',
            filter: 'blur(100px)',
          }}
          animate={{ scale: [1, 1.1, 1] }}
          transition={{ duration: 10, repeat: Infinity, ease: 'easeInOut', delay: 2 }}
        />
      </div>

      {/* ── Scene renderer ── */}
      <AnimatePresence mode="wait" custom={dir}>
        <motion.div
          key={current}
          custom={dir}
          variants={variants}
          initial="enter"
          animate="center"
          exit="exit"
          transition={transition}
          className="absolute inset-0 overflow-auto pb-[110px]"
        >
          <Component />
        </motion.div>
      </AnimatePresence>

      {/* ── Navigation UI ── */}
      <ShowcaseNav
        current={current}
        total={total}
        progress={progress}
        paused={paused}
        visible={navVisible}
        onPrev={goPrev}
        onNext={goNext}
        onJump={(i) => goTo(i)}
        onTogglePause={() => setPaused(p => !p)}
        onRestart={restart}
      />

      {/* ── Keyboard hint (fades out after 4s) ── */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: [0, 1, 1, 0] }}
        transition={{ duration: 4, times: [0, 0.1, 0.7, 1], delay: 0.8 }}
        className="fixed top-4 left-4 text-[10px] text-white/25 pointer-events-none"
      >
        ← → to navigate · Space to pause · R to restart
      </motion.div>
    </div>
  );
}
