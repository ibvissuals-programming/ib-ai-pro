/**
 * IbLogo — IB AI Studio Lab brand logo system.
 *
 * Variants:
 *   mark      — SVG icon only (default size 32)
 *   wordmark  — icon + stacked "IB AI / Studio Lab" (login, splash)
 *   nav       — icon + inline "IB AI Studio Lab" (navbars, sidebars)
 *   compact   — icon + "IB AI" only (tight spaces)
 *
 * The mark: 3×3 neural grid — 4 active corner nodes + 1 bright center node,
 * 4 dim edge nodes, faint connecting grid lines.
 * Communicates: structured intelligence, control system.
 */

function IbMark({ size = 32 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      {/* Grid lines */}
      <line x1="7" y1="7"  x2="25" y2="7"  stroke="#3b82f6" strokeWidth="0.5" opacity="0.28"/>
      <line x1="7" y1="16" x2="25" y2="16" stroke="#3b82f6" strokeWidth="0.4" opacity="0.16"/>
      <line x1="7" y1="25" x2="25" y2="25" stroke="#3b82f6" strokeWidth="0.5" opacity="0.28"/>
      <line x1="7"  y1="7"  x2="7"  y2="25" stroke="#3b82f6" strokeWidth="0.5" opacity="0.28"/>
      <line x1="16" y1="7"  x2="16" y2="25" stroke="#3b82f6" strokeWidth="0.4" opacity="0.16"/>
      <line x1="25" y1="7"  x2="25" y2="25" stroke="#3b82f6" strokeWidth="0.5" opacity="0.28"/>

      {/* Dim mid-edge nodes */}
      <rect x="13.5" y="4.5"  width="5" height="5" rx="1.2" fill="#3b82f6" opacity="0.24"/>
      <rect x="4.5"  y="13.5" width="5" height="5" rx="1.2" fill="#3b82f6" opacity="0.24"/>
      <rect x="22.5" y="13.5" width="5" height="5" rx="1.2" fill="#3b82f6" opacity="0.24"/>
      <rect x="13.5" y="22.5" width="5" height="5" rx="1.2" fill="#3b82f6" opacity="0.24"/>

      {/* Active corner nodes */}
      <rect x="4.5"  y="4.5"  width="5" height="5" rx="1.2" fill="#3b82f6"/>
      <rect x="22.5" y="4.5"  width="5" height="5" rx="1.2" fill="#3b82f6"/>
      <rect x="4.5"  y="22.5" width="5" height="5" rx="1.2" fill="#3b82f6"/>
      <rect x="22.5" y="22.5" width="5" height="5" rx="1.2" fill="#3b82f6"/>

      {/* Center node — brightest, signature node */}
      <rect x="13.5" y="13.5" width="5" height="5" rx="1.2" fill="#60a5fa"/>
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
            IB <span className="text-primary">AI</span>
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
        <span className="text-sm font-semibold tracking-tight text-foreground" style={{ fontFamily: 'Inter, sans-serif', letterSpacing: '-0.02em' }}>
          IB <span className="text-primary">AI</span>{' '}
          <span className="font-normal text-muted-foreground">Studio Lab</span>
        </span>
      </div>
    );
  }

  if (variant === 'compact') {
    return (
      <div className={`inline-flex items-center gap-2 ${className}`}>
        <IbMark size={22} />
        <span className="text-sm font-semibold tracking-tight text-foreground" style={{ fontFamily: 'Inter, sans-serif', letterSpacing: '-0.02em' }}>
          IB <span className="text-primary">AI</span>
        </span>
      </div>
    );
  }

  return null;
}
