import { useState, useEffect } from 'react';

/**
 * TypewriterText — animates text character by character.
 * Props:
 *   text     — the string to type
 *   speed    — ms per character (default 28)
 *   delay    — ms before typing starts (default 0)
 *   onDone   — callback when typing finishes
 *   cursor   — show blinking cursor while typing (default true)
 *   className
 */
export function TypewriterText({
  text = '',
  speed = 28,
  delay = 0,
  onDone,
  cursor = true,
  className = '',
}) {
  const [displayed, setDisplayed] = useState('');
  const [done, setDone] = useState(false);

  useEffect(() => {
    setDisplayed('');
    setDone(false);

    const startId = setTimeout(() => {
      let i = 0;
      const id = setInterval(() => {
        i++;
        setDisplayed(text.slice(0, i));
        if (i >= text.length) {
          clearInterval(id);
          setDone(true);
          onDone?.();
        }
      }, speed);
      return () => clearInterval(id);
    }, delay);

    return () => clearTimeout(startId);
  }, [text, speed, delay]);

  return (
    <span className={className} style={{ whiteSpace: 'pre-wrap' }}>
      {displayed}
      {cursor && !done && (
        <span
          style={{
            display: 'inline-block',
            width: '2px',
            height: '1em',
            background: 'hsl(var(--primary))',
            marginLeft: '1px',
            verticalAlign: 'text-bottom',
            animation: 'caret-blink 0.9s ease-out infinite',
          }}
        />
      )}
    </span>
  );
}
