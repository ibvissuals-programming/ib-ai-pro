/**
 * IbLogo — IB AI Studio Lab brand logo system.
 *
 * Uses the actual uploaded brand image (public/ib-logo.jpg).
 *
 * Variants:
 *   mark      — logo image only, in a rounded container (login, splash)
 *   wordmark  — logo image + stacked "IB AI / Studio Lab" text (large splash)
 *   nav       — small logo image + inline brand name (navbars, sidebars)
 *   compact   — small logo image + "IB AI" only (tight spaces)
 */

export function IbLogo({ variant = 'wordmark', size = 32, className = '' }) {
  if (variant === 'mark') {
    return (
      <span
        className={`inline-flex shrink-0 items-center justify-center overflow-hidden ${className}`}
        style={{ width: size, height: size, borderRadius: Math.round(size * 0.28) }}
      >
        <img
          src="/ib-logo.jpg"
          alt="IB AI Studio Lab"
          width={size}
          height={size}
          style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'center top', display: 'block' }}
          draggable={false}
        />
      </span>
    );
  }

  if (variant === 'wordmark') {
    const imgSize = size;
    return (
      <div className={`inline-flex items-center gap-3 ${className}`}>
        <span
          className="inline-flex shrink-0 items-center justify-center overflow-hidden"
          style={{ width: imgSize, height: imgSize, borderRadius: Math.round(imgSize * 0.28) }}
        >
          <img
            src="/ib-logo.jpg"
            alt="IB AI Studio Lab"
            width={imgSize}
            height={imgSize}
            style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'center top', display: 'block' }}
            draggable={false}
          />
        </span>
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
    const navImgSize = 28;
    return (
      <div className={`inline-flex items-center gap-2.5 ${className}`}>
        <span
          className="inline-flex shrink-0 items-center justify-center overflow-hidden"
          style={{ width: navImgSize, height: navImgSize, borderRadius: Math.round(navImgSize * 0.28) }}
        >
          <img
            src="/ib-logo.jpg"
            alt="IB AI Studio Lab"
            width={navImgSize}
            height={navImgSize}
            style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'center top', display: 'block' }}
            draggable={false}
          />
        </span>
        <span
          className="text-sm font-semibold tracking-tight text-foreground"
          style={{ fontFamily: 'Inter, sans-serif', letterSpacing: '-0.02em' }}
        >
          IB <span className="text-primary">AI</span>{' '}
          <span className="font-normal text-muted-foreground">Studio Lab</span>
        </span>
      </div>
    );
  }

  if (variant === 'compact') {
    const cImgSize = 22;
    return (
      <div className={`inline-flex items-center gap-2 ${className}`}>
        <span
          className="inline-flex shrink-0 items-center justify-center overflow-hidden"
          style={{ width: cImgSize, height: cImgSize, borderRadius: Math.round(cImgSize * 0.28) }}
        >
          <img
            src="/ib-logo.jpg"
            alt="IB AI"
            width={cImgSize}
            height={cImgSize}
            style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'center top', display: 'block' }}
            draggable={false}
          />
        </span>
        <span
          className="text-sm font-semibold tracking-tight text-foreground"
          style={{ fontFamily: 'Inter, sans-serif', letterSpacing: '-0.02em' }}
        >
          IB <span className="text-primary">AI</span>
        </span>
      </div>
    );
  }

  return null;
}
