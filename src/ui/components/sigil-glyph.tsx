import type { JSX } from 'react';
import type { Sigil } from '@/dsp/signature';

interface SigilGlyphProps {
  sigil: Sigil;
  /** Identity colour. Drawn as strokes — the mark is never filled with it. */
  colour: string;
  size?: number;
  /** Unselected cards draw the same mark in the dead grey, so it recedes. */
  dim?: boolean;
  /** Screen-reader text. Pass the patch's name; omit inside a labelled control. */
  title?: string;
}

/**
 * The grey an unselected mark recedes into. --muted (4.14:1 on panel) rather than
 * the #3A3A38 used for hairlines elsewhere: at 64px on a phone that hairline grey
 * was invisible, and a mark you cannot see is not a mark. It clears the 3:1
 * non-text contrast bar; the AA text rule that rules --muted out does not apply
 * to a 2.6px stroke.
 */
const DEAD = 'var(--muted)';

/**
 * A patch's mark.
 *
 * Nine spokes whose lengths are the patch's own parameter values, a silhouette
 * through their tips, one filled node on the longest, and a single cut across the
 * whole form. All of it comes from `sigilOf`, so the same sound always draws the
 * same mark and you start recognising a patch before you hear it — which is the
 * entire reason a grid of six mutations can be read at a glance where six bar
 * charts could not.
 *
 * Every stroke is straight and flat. No curves, no gradients, nothing soft.
 */
export function SigilGlyph({
  sigil, colour, size = 64, dim = false, title,
}: SigilGlyphProps): JSX.Element {
  const ink = dim ? DEAD : colour;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      role={title === undefined ? 'presentation' : 'img'}
      aria-hidden={title === undefined ? true : undefined}
      aria-label={title}
    >
      {/* The cut goes down first, so the form sits on top of it rather than
          being sliced apart by it. */}
      <line
        x1={sigil.cut.x1} y1={sigil.cut.y1} x2={sigil.cut.x2} y2={sigil.cut.y2}
        stroke={dim ? DEAD : 'var(--ink)'} strokeWidth={2} strokeLinecap="square"
      />

      {sigil.spokes.map((p, i) => (
        <line
          key={i}
          x1={50} y1={50} x2={p.x} y2={p.y}
          stroke={ink} strokeWidth={1.6} strokeLinecap="square"
        />
      ))}

      <polygon
        points={sigil.spokes.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ')}
        fill="none" stroke={ink} strokeWidth={2.6} strokeLinejoin="miter"
      />

      <rect x={sigil.node.x - 3.5} y={sigil.node.y - 3.5} width={7} height={7} fill={ink} />
    </svg>
  );
}
