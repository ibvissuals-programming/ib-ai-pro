import { useState, useEffect } from 'react';
import { cubicBezier } from './cubicBezier.js';

/**
 * The shared easing used throughout all real scenes:
 *   transition: { ease: [0.22, 1, 0.36, 1] }
 * Aggressive ease-out — fast entry, soft settle.
 */
const ease = (t) => cubicBezier(t, 0.22, 1, 0.36, 1);

/**
 * useTween(duration, delay?)
 *
 * Returns a single eased value that travels 0 → 1 over `duration` ms,
 * starting after `delay` ms, driven by requestAnimationFrame.
 *
 * @param {number} duration  — animation length in ms
 * @param {number} [delay=0] — start offset in ms
 * @returns {number}          — eased progress value in [0, 1]
 */
export function useTween(duration, delay = 0) {
  const [value, setValue] = useState(0);

  useEffect(() => {
    let rafId;
    let startTime = null;

    function tick(ts) {
      if (startTime === null) startTime = ts;
      const elapsed = ts - startTime - delay;
      if (elapsed <= 0) {
        rafId = requestAnimationFrame(tick);
        return;
      }
      const t = Math.min(elapsed / duration, 1);
      setValue(ease(t));
      if (t < 1) rafId = requestAnimationFrame(tick);
    }

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [duration, delay]);

  return value;
}

/**
 * useStaggeredTweens(count, duration, staggerMs, initialDelay?)
 *
 * Runs `count` tweens in a single rAF loop. Each tween i starts at
 * (initialDelay + i * staggerMs) ms. All share the same `duration`.
 *
 * Returns a stable array of eased progress values in [0, 1].
 * The rAF loop stops automatically once all tweens reach 1.
 *
 * @param {number} count        — number of elements to stagger
 * @param {number} duration     — animation length per element in ms
 * @param {number} staggerMs    — delay added per successive element in ms
 * @param {number} [initialDelay=0] — offset before the first element starts
 * @returns {number[]}          — array of length `count`, each in [0, 1]
 */
export function useStaggeredTweens(count, duration, staggerMs, initialDelay = 0) {
  const [values, setValues] = useState(() => Array(count).fill(0));

  useEffect(() => {
    let rafId;
    let startTime = null;

    function tick(ts) {
      if (startTime === null) startTime = ts;
      const elapsed = ts - startTime;

      let allDone = true;
      const next = Array.from({ length: count }, (_, i) => {
        const start = initialDelay + i * staggerMs;
        const t = Math.min(Math.max((elapsed - start) / duration, 0), 1);
        if (t < 1) allDone = false;
        return t <= 0 ? 0 : t >= 1 ? 1 : ease(t);
      });

      setValues(next);
      if (!allDone) rafId = requestAnimationFrame(tick);
    }

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [count, duration, staggerMs, initialDelay]);

  return values;
}
