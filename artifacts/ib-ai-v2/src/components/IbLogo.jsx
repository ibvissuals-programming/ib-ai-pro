/**
 * IbLogo — IB AI Studio Lab brand logo system.
 *
 * Glass Monolith Mark
 *   A rounded glass slab with frosted highlight, gradient border (simulates
 *   light refraction), inner blue radial glow, and "IB / AI" embedded
 *   typography. No images — pure SVG gradients.
 *
 * Variants:
 *   mark      — SVG glass mark only (default size 32)
 *   wordmark  — mark + stacked "IB AI / Studio Lab" (login, splash)
 *   nav       — mark + inline "IB AI Studio Lab" (navbars, sidebars)
 *   compact   — mark + "IB AI" only (tight spaces)
 *
 * All gradient IDs are instance-unique via a static counter to avoid
 * SVG ID collisions when multiple instances render on the same page.
 */

import { useId } from 'react';

function IbMark({ size = 32 }) {
  const uid = useId().replace(/:/g, '');
  const bgId      = `ibm-bg-${uid}`;
  const glowId    = `ibm-glow-${uid}`;
  const sheenId   = `ibm-sh-${uid}`;
  const borderId  = `ibm-bd-${uid}`;
  const clipId    = `ibm-cl-${uid}`;

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
        {/* Dark glass base — subtle blue tint */}
        <linearGradient id={bgId} x1="3" y1="3" x2="29" y2="29" gradientUnits="userSpaceOnUse">
          <stop offset="0%"   stopColor="#18223e"/>
          <stop offset="100%" stopColor="#0c1222"/>
        </linearGradient>

        {/* Inner gold radial glow — centre-top */}
        <radialGradient id={glowId} cx="50%" cy="32%" r="58%">
          <stop offset="0%"   stopColor="#d97706" stopOpacity="0.18"/>
          <stop offset="100%" stopColor="#d97706" stopOpacity="0"/>
        </radialGradient>

        {/* Frosted glass sheen — white fade, top only */}
        <linearGradient id={sheenId} x1="16" y1="2.5" x2="16" y2="15" gradientUnits="userSpaceOnUse">
          <stop offset="0%"   stopColor="#ffffff" stopOpacity="0.22"/>
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0"/>
        </linearGradient>

        {/* Glass border — gold refraction (bright top-left → dim bottom-right) */}
        <linearGradient id={borderId} x1="3" y1="3" x2="29" y2="29" gradientUnits="userSpaceOnUse">
          <stop offset="0%"   stopColor="#fbbf24" stopOpacity="0.70"/>
          <stop offset="40%"  stopColor="#d97706" stopOpacity="0.35"/>
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0.06"/>
        </linearGradient>

        {/* Clip mask — top half of the glass slab for sheen layer */}
        <clipPath id={clipId}>
          <rect x="0" y="0" width="32" height="14.5"/>
        </clipPath>
      </defs>

      {/* Base glass fill */}
      <rect x="2.5" y="2.5" width="27" height="27" rx="6.5" fill={`url(#${bgId})`}/>

      {/* Inner blue glow */}
      <rect x="2.5" y="2.5" width="27" height="27" rx="6.5" fill={`url(#${glowId})`}/>

      {/* Frosted sheen — top portion only */}
      <g clipPath={`url(#${clipId})`}>
        <rect x="2.5" y="2.5" width="27" height="27" rx="6.5" fill={`url(#${sheenId})`}/>
      </g>

      {/* Glass border — gradient stroke */}
      <rect
        x="2.5" y="2.5" width="27" height="27" rx="6.5"
        stroke={`url(#${borderId})`}
        strokeWidth="0.85"
      />

      {/* Embedded typography: "IB" white / "AI" blue */}
      <text
        x="16" y="12"
        textAnchor="middle"
        dominantBaseline="middle"
        fill="#ffffff"
        fontFamily="Inter,system-ui,sans-serif"
        fontWeight="800"
        fontSize="9"
        letterSpacing="-0.4"
      >IB</text>

      <text
        x="16" y="21.5"
        textAnchor="middle"
        dominantBaseline="middle"
        fill="#f59e0b"
        fontFamily="Inter,system-ui,sans-serif"
        fontWeight="800"
        fontSize="9"
        letterSpacing="-0.4"
      >AI</text>

      {/* Thin separator line between IB and AI */}
      <line
        x1="9" y1="16.5" x2="23" y2="16.5"
        stroke="#f59e0b"
        strokeWidth="0.5"
        strokeOpacity="0.30"
      />
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
            IB <span className="text-amber-500">AI</span>
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
          IB <span className="text-amber-500">AI</span>{' '}
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
          IB <span className="text-amber-500">AI</span>
        </span>
      </div>
    );
  }

  return null;
}
