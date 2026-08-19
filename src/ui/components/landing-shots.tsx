import type { JSX } from 'react';

/**
 * The landing page's screenshots.
 *
 * Every one is a real capture of the running instrument — audio started, an
 * engine chosen, a preset loaded and notes held, so the scope and the spectrum
 * are drawing rather than sitting empty. They are shot at 2x and displayed at
 * half of that, which is what keeps the interface text in them readable.
 */

export interface Capture {
  readonly src: string;
  readonly width: number;
  readonly height: number;
}

const FRAME = { borderColor: 'var(--ink)', background: 'var(--bg)' } as const;

/** A screenshot in a hard 3px frame, with its caption under it. */
export function Shot({
  capture, alt, caption, className,
}: {
  capture: Capture; alt: string; caption: string; className?: string;
}): JSX.Element {
  return (
    <figure className={`m-0 flex flex-col gap-2${className === undefined ? '' : ` ${className}`}`}>
      <img
        src={capture.src}
        width={capture.width}
        height={capture.height}
        alt={alt}
        className="block w-full h-auto border-[3px]"
        style={FRAME}
      />
      <figcaption className="label" style={{ color: 'var(--ink)' }}>{caption}</figcaption>
    </figure>
  );
}

/**
 * One view of the instrument, captured twice — from a desktop window and from a
 * phone-width one — with the browser taking whichever it can actually read.
 *
 * A 1120px-wide desktop capture shrunk into a 335px phone column is a picture of
 * a synthesiser with no legible text in it, which argues nothing. `<picture>`
 * with a `media` source also means a phone fetches the phone capture and only
 * the phone capture: one image either way, sized for the screen it lands on.
 */
export function SwapShot({
  wide, narrow, alt, caption,
}: {
  wide: Capture; narrow: Capture; alt: string; caption: string;
}): JSX.Element {
  return (
    <figure className="m-0 flex flex-col gap-2">
      <picture>
        <source
          media="(min-width: 640px)"
          srcSet={wide.src}
          width={wide.width}
          height={wide.height}
        />
        <img
          src={narrow.src}
          width={narrow.width}
          height={narrow.height}
          alt={alt}
          className="block w-full h-auto border-[3px]"
          style={FRAME}
        />
      </picture>
      <figcaption className="label" style={{ color: 'var(--ink)' }}>{caption}</figcaption>
    </figure>
  );
}
