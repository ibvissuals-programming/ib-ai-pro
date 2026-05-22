/**
 * IbLogo — IB AI Studio Lab brand logo system.
 *
 * Azure Neural Mark
 *   A deep navy rounded slab with electric-blue radial glow,
 *   blue-to-indigo gradient border, and "IB / AI" embedded
 *   typography with neural-node separator dots.
 *   No images — pure SVG gradients.
 *
 * Variants:
 *   mark      — SVG mark only (default size 32)
 *   wordmark  — mark + stacked "IB AI / Studio Lab" (login, splash)
 *   nav       — mark + inline "IB AI Studio Lab" (navbars, sidebars)
 *   compact   — mark + "IB AI" only (tight spaces)
 *
 * All gradient IDs are instance-unique via useId to avoid SVG ID
 * collisions when multiple instances render on the same page.
 */

import { useId } from 'react';

function IbMark({ size = 32 }) {
  const uid      = useId().replace(/:/g, '');
  const bgId     = `ibm-bg-${uid}`;
  const glowId   = `ibm-gw-${uid}`;
  const borderId = `ibm-bd-${uid}`;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <defs>
        {/* Deep navy background */}
        <linearGradient id={bgId} x1="2" y1="2" x2="30" y2="30" gradientUnits="userSpaceOnUse">
          <stop offset="0%"   stopColor="#0c1220"/>
          <stop offset="100%" stopColor="#080c18"/>
        </linearGradient>

        {/* Electric blue radial glow — centred slightly above middle */}
        <radialGradient id={glowId} cx="50%" cy="40%" r="55%">
          <stop offset="0%"   stopColor="#3b82f6" stopOpacity="0.22"/>
          <stop offset="100%" stopColor="#3b82f6" stopOpacity="0"/>
        </radialGradient>

        {/* Blue → indigo gradient border */}
        <linearGradient id={borderId} x1="2" y1="2" x2="30" y2="30" gradientUnits="userSpaceOnUse">
          <stop offset="0%"   stopColor="#60a5fa" stopOpacity="0.80"/>
          <stop offset="45%"  stopColor="#818cf8" stopOpacity="0.45"/>
          <stop offset="100%" stopColor="#6366f1" stopOpacity="0.15"/>
        </linearGradient>
      </defs>

      {/* Base fill */}
      <rect x="1.5" y="1.5" width="29" height="29" rx="7" fill={`url(#${bgId})`}/>

      {/* Blue glow layer */}
      <rect x="1.5" y="1.5" width="29" height="29" rx="7" fill={`url(#${glowId})`}/>

      {/* Crisp gradient border */}
      <rect
        x="1.5" y="1.5" width="29" height="29" rx="7"
        stroke={`url(#${borderId})`}
        strokeWidth="0.8"
      />

      {/* "IB" — white, bold */}
      <text
        x="16" y="12.5"
        textAnchor="middle"
        dominantBaseline="middle"
        fill="#ffffff"
        fontFamily="Inter,system-ui,sans-serif"
        fontWeight="800"
        fontSize="9"
        letterSpacing="-0.4"
      >IB</text>

      {/* Separator with neural-node endpoints */}
      <line
        x1="9.5" y1="16.5" x2="22.5" y2="16.5"
        stroke="#3b82f6"
        strokeWidth="0.6"
        strokeOpacity="0.55"
      />
      <circle cx="9.5"  cy="16.5" r="0.8" fill="#60a5fa" opacity="0.65"/>
      <circle cx="22.5" cy="16.5" r="0.8" fill="#60a5fa" opacity="0.65"/>

      {/* "AI" — electric blue */}
      <text
        x="16" y="21.5"
        textAnchor="middle"
        dominantBaseline="middle"
        fill="#60a5fa"
        fontFamily="Inter,system-ui,sans-serif"
        fontWeight="800"
        fontSize="9"
        letterSpacing="-0.4"
      >AI</text>
    </svg>
  );
}

export function IbLogo({ variant = 'wordmark', size = 32, className = '' }) {
  if (variant === 'mark') {
    return (
      <span className={`inline-flex shrink-0 ${className}`}>
        <IbMark size={size} />
      </span>
    );
  }

  if (variant === 'wordmark') {
    return (
      <div className={`inline-flex items-center gap-3 ${className}`}>
        <IbMark size={size} />
        <div className="flex flex-col leading-none gap-1">
          <span
            className="font-bold text-foreground"
            style={{ fontSize: Math.round(size * 0.5) + 'px', letterSpacing: '-0.03em', fontFamily: 'Inter, sans-serif' }}
          >
            IB <span className="text-blue-400">AI</span>
          </span>
          <span
            className="text-muted-foreground font-medium uppercase tracking-[0.1em]"
            style={{ fontSize: Math.round(size * 0.265) + 'px', fontFamily: 'Inter, sans-serif' }}
          >
            Studio Lab
          </span>
        </div>
      </div>
    );
  }

  if (variant === 'nav') {
    return (
      <div className={`inline-flex items-center gap-2 ${className}`}>
        <IbMark size={24} />
        <span
          className="text-sm font-semibold tracking-tight text-foreground"
          style={{ fontFamily: 'Inter, sans-serif', letterSpacing: '-0.02em' }}
        >
          IB <span className="text-blue-400">AI</span>{' '}
          <span className="font-normal text-muted-foreground">Studio Lab</span>
        </span>
      </div>
    );
  }

  if (variant === 'compact') {
    return (
      <div className={`inline-flex items-center gap-2 ${className}`}>
        <IbMark size={22} />
        <span
          className="text-sm font-semibold tracking-tight text-foreground"
          style={{ fontFamily: 'Inter, sans-serif', letterSpacing: '-0.02em' }}
        >
          IB <span className="text-blue-400">AI</span>
        </span>
      </div>
    );
  }

  return null;
}
