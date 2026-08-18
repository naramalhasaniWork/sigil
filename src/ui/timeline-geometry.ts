/**
 * Pure timeline geometry — bars to pixels, pixels to bars, and the hit-testing
 * between them. No React, no DOM, no audio, and nothing imported from a
 * component: every function here is deterministic, so the one genuinely fiddly
 * part of the arrangement UI is testable in a node environment. Vitest here is
 * environment 'node' and collects only tests/**\/*.test.ts, so maths that lives
 * in a .tsx is maths nobody can test. It lives here instead.
 *
 * The timeline is BAR-PROPORTIONAL: a 16-bar section is twice as wide as an
 * 8-bar one, and a clip's x and width ARE its section's, because section 1.3 of
 * docs/design/arrangement-ia.md refuses free clip lengths — a clip fills the
 * cell it is in. So there is no sub-bar position anywhere in this file, no zoom
 * level to persist, and nothing to snap to but whole bars.
 *
 * Two things here are easy to get wrong and are therefore pinned by tests:
 *
 *  - REPEATS ARE LENGTH. A 16-bar section played twice occupies 32 bars of the
 *    song, so that is how wide it is drawn. Laying out from `bars` alone puts
 *    every later section, and the playhead, in the wrong place.
 *  - EDGES ARE ROUNDED CUMULATIVELY, never per section. Rounding each width on
 *    its own accumulates error and leaves a one-pixel seam between neighbours at
 *    fractional zoom, which on a 3px-ruled grid reads as a broken table.
 */

/** Matches SectionRecord.bars in section 3.3 of the IA. */
export const MIN_SECTION_BARS = 1;
export const MAX_SECTION_BARS = 64;

/**
 * Zoom floor and ceiling. There is no zoom control — sections are the grid
 * (section 5.1.9) — so this is the whole model: fit the song into the pane when
 * it fits, stop shrinking at the floor, and scroll the lane from there.
 */
export const MIN_PX_PER_BAR = 6;
export const MAX_PX_PER_BAR = 96;

/**
 * Half-width of the grab strip on a section's right edge. The strip straddles
 * the boundary, so 12 gives a 24px-wide target on a 44px-tall header — findable
 * with a thumb without stealing taps meant for the section name.
 */
export const EDGE_GRIP_PX = 12;

/**
 * Travel before a press becomes a drag. Under this, a tap on a clip stays a
 * tap: a finger never lands perfectly still, and a 2px twitch that reassigns a
 * clip to another track is the kind of bug people describe as "it moved on its
 * own".
 */
export const DRAG_THRESHOLD_PX = 5;

/** What the timeline needs to know about a section. A view model, not a record. */
export interface TimelineSection {
  readonly id: string;
  readonly name: string;
  /** 1..64. Clamped here rather than trusted. */
  readonly bars: number;
  /** Play the whole section this many times. Default 1. */
  readonly repeats?: number;
  readonly colour?: string;
}

/** What the timeline needs to know about a track. */
export interface TimelineTrack {
  readonly id: string;
  readonly name: string;
  readonly engineId: string;
  /** Engine identity colour, resolved upstream. Components never look it up. */
  readonly colour: string;
  /** 0..1. */
  readonly gain: number;
  readonly muted: boolean;
  readonly soloed: boolean;
  /** Loaded, but this build cannot sound it. Drawn, never played. */
  readonly unplayable?: boolean;
}

/** One cell of the song table. Density is a fill height, never a piano roll. */
export interface TimelineCell {
  readonly clipId: string | null;
  /** 0..1. */
  readonly density: number;
  readonly noteCount: number;
  readonly muted: boolean;
  readonly playing: boolean;
}

/** A section resolved to pixels. Produced only by layoutSections. */
export interface SectionBox {
  readonly id: string;
  readonly index: number;
  /** Absolute bar the section starts on, 0-based, repeats included. */
  readonly startBar: number;
  /** The section's own bar count, 1..64 — what a resize edits. */
  readonly bars: number;
  /** 1 or more. */
  readonly repeats: number;
  /** bars * repeats: how much song this section actually is. */
  readonly spanBars: number;
  /** Left edge in px, relative to the start of the lane area. */
  readonly x: number;
  readonly width: number;
}

/** 1-indexed, matching barBeatOfTick in src/dsp/sequencer.ts. */
export interface PlayheadPosition {
  readonly sectionId: string;
  readonly bar: number;
  readonly beat: number;
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * A bar count that can be trusted downstream. Anything non-finite, fractional
 * or out of range becomes a whole number in [1, 64], rather than propagating
 * into a NaN width — which renders as a section of no pixels that nobody can
 * click and nobody can find again.
 */
export function clampBars(bars: number): number {
  if (!Number.isFinite(bars)) return MIN_SECTION_BARS;
  return clamp(Math.round(bars), MIN_SECTION_BARS, MAX_SECTION_BARS);
}

function repeatsOf(section: TimelineSection): number {
  const raw = section.repeats;
  if (raw === undefined || !Number.isFinite(raw)) return 1;
  return Math.max(1, Math.floor(raw));
}

/** How many bars of song a section is: its length times its repeats. */
export function spanBarsOf(section: TimelineSection): number {
  return clampBars(section.bars) * repeatsOf(section);
}

export function totalBars(sections: readonly TimelineSection[]): number {
  let sum = 0;
  for (const section of sections) sum += spanBarsOf(section);
  return sum;
}

/**
 * Pixels per bar that fits the whole song into `availableWidth` when it can and
 * bottoms out when it cannot, at which point the lane area scrolls.
 */
export function pxPerBar(bars: number, availableWidth: number): number {
  if (!Number.isFinite(bars) || bars <= 0) return MIN_PX_PER_BAR;
  if (!Number.isFinite(availableWidth) || availableWidth <= 0) return MIN_PX_PER_BAR;
  return clamp(availableWidth / bars, MIN_PX_PER_BAR, MAX_PX_PER_BAR);
}

/**
 * Tile the sections left to right. Edges are whole pixels — a 3px column rule
 * straddling a half pixel is the difference between a ruled table and a row of
 * boxes that almost line up — and every edge is rounded once from its cumulative
 * bar position, so `boxes[i].x + boxes[i].width === boxes[i + 1].x` exactly, at
 * any zoom, with no drift accumulated across a long song.
 *
 * `px` is floored at MIN_PX_PER_BAR so no section can be laid out too narrow to
 * see or to hit.
 */
export function layoutSections(
  sections: readonly TimelineSection[],
  px: number,
): SectionBox[] {
  const scale = Number.isFinite(px) && px > 0 ? Math.max(px, MIN_PX_PER_BAR) : MIN_PX_PER_BAR;
  const boxes: SectionBox[] = [];
  let startBar = 0;

  sections.forEach((section, index) => {
    const bars = clampBars(section.bars);
    const repeats = repeatsOf(section);
    const spanBars = bars * repeats;
    const x = Math.round(startBar * scale);
    const width = Math.round((startBar + spanBars) * scale) - x;
    boxes.push({ id: section.id, index, startBar, bars, repeats, spanBars, x, width });
    startBar += spanBars;
  });

  return boxes;
}

/** Total laid-out width. Zero for an empty song, never NaN. */
export function contentWidth(boxes: readonly SectionBox[]): number {
  const last = boxes[boxes.length - 1];
  return last === undefined ? 0 : last.x + last.width;
}

/**
 * The section under `x`, by id. Half-open, so the boundary pixel belongs to
 * exactly one section and a press on a column rule never lands in the gap
 * between two of them.
 */
export function sectionAtX(boxes: readonly SectionBox[], x: number): string | null {
  if (!Number.isFinite(x) || x < 0) return null;
  for (const box of boxes) {
    if (x >= box.x && x < box.x + box.width) return box.id;
  }
  return null;
}

/**
 * The section whose RIGHT edge is being grabbed, by id, or null in open space.
 *
 * The resize affordance lives on a section edge and nowhere else: a section's
 * bar count is the only length in the model, so it is the only thing an edge
 * drag can mean. Clip blocks deliberately have no edge handle at all — a handle
 * that silently resizes something other than what you grabbed is worse than no
 * handle.
 *
 * When two thin sections both reach the pointer the nearer edge wins, and a dead
 * heat goes to the earlier section so the result is deterministic.
 */
export function edgeAtX(
  boxes: readonly SectionBox[],
  x: number,
  grip: number = EDGE_GRIP_PX,
): string | null {
  if (!Number.isFinite(x)) return null;
  const reach = Number.isFinite(grip) && grip > 0 ? grip : EDGE_GRIP_PX;
  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const box of boxes) {
    const distance = Math.abs(x - (box.x + box.width));
    if (distance <= reach && distance < bestDistance) {
      best = box.id;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * New bar count for a section whose right edge is being dragged. Snaps to whole
 * bars, because there is no finer grid to snap to.
 *
 * Deliberately RELATIVE — bars at the start of the gesture plus the bars the
 * hand has travelled, never an absolute pointerX / px. The absolute form makes
 * a section jump the instant it is grabbed by however much its drawn edge
 * disagrees with its bar count, which is every repeated or rounded section.
 */
export function barsFromDrag(startBars: number, deltaX: number, px: number): number {
  const from = clampBars(startBars);
  if (!Number.isFinite(deltaX) || !Number.isFinite(px) || px <= 0) return from;
  return clampBars(from + Math.round(deltaX / px));
}

/**
 * Track row index at `y`, measured from the top of the rows area. Strict: above
 * the first row or below the last returns null, so a clip dragged out of the
 * grid is dropped rather than silently reassigned to the nearest track.
 */
export function trackAtY(trackCount: number, y: number, rowHeight: number): number | null {
  if (!Number.isFinite(y) || !Number.isFinite(rowHeight) || rowHeight <= 0) return null;
  if (!Number.isFinite(trackCount) || trackCount <= 0 || y < 0) return null;
  const index = Math.floor(y / rowHeight);
  return index >= 0 && index < trackCount ? index : null;
}

/**
 * Where to draw the playhead, in lane-area pixels, or null when there is
 * nothing to draw — the transport is stopped, or the position names a section
 * that has since been removed. `bar` and `beat` are 1-indexed inside the
 * section; a position past the section's end is clamped to its right edge
 * rather than drawn over the next section.
 */
export function playheadX(
  boxes: readonly SectionBox[],
  position: PlayheadPosition | null,
  beatsPerBar: number,
  px: number,
): number | null {
  if (position === null) return null;
  let box: SectionBox | undefined;
  for (const candidate of boxes) {
    if (candidate.id === position.sectionId) { box = candidate; break; }
  }
  if (box === undefined) return null;

  const beats = Number.isFinite(beatsPerBar) && beatsPerBar > 0 ? beatsPerBar : 4;
  const scale = Number.isFinite(px) && px > 0 ? px : MIN_PX_PER_BAR;
  const bar = Number.isFinite(position.bar) ? position.bar - 1 : 0;
  const beat = Number.isFinite(position.beat) ? position.beat - 1 : 0;
  const local = clamp(bar + beat / beats, 0, box.spanBars);
  return Math.min(box.x + local * scale, box.x + box.width);
}

/** Has this press travelled far enough to mean "move this" rather than "select this"? */
export function isDrag(dx: number, dy: number): boolean {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false;
  return Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX;
}
