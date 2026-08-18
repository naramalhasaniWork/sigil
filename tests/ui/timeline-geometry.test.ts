import { describe, expect, it } from 'vitest';
import {
  DRAG_THRESHOLD_PX, EDGE_GRIP_PX, MAX_PX_PER_BAR, MAX_SECTION_BARS, MIN_PX_PER_BAR,
  MIN_SECTION_BARS,
  barsFromDrag, clampBars, contentWidth, edgeAtX, isDrag, layoutSections, playheadX,
  pxPerBar, sectionAtX, spanBarsOf, totalBars, trackAtY,
  type SectionBox, type TimelineSection,
} from '@/ui/timeline-geometry';

/** intro 8 | A 16 | fill 1 | drop 16 twice — 57 bars of song. */
const SONG: readonly TimelineSection[] = [
  { id: 'sec_intro', name: 'Intro', bars: 8 },
  { id: 'sec_a', name: 'A', bars: 16 },
  { id: 'sec_fill', name: 'Fill', bars: 1 },
  { id: 'sec_drop', name: 'Drop', bars: 16, repeats: 2 },
];

/** 10px a bar: intro 0..80, A 80..240, fill 240..250, drop 250..570. */
const BOXES = layoutSections(SONG, 10);

function box(boxes: readonly SectionBox[], id: string): SectionBox {
  const found = boxes.find((b) => b.id === id);
  if (found === undefined) throw new Error(`no box ${id}`);
  return found;
}

describe('clampBars', () => {
  it('holds the 1..64 range and rounds to whole bars', () => {
    expect(clampBars(8)).toBe(8);
    expect(clampBars(4.4)).toBe(4);
    expect(clampBars(4.6)).toBe(5);
    expect(clampBars(999)).toBe(MAX_SECTION_BARS);
  });

  it('refuses zero, negative and non-finite rather than laying out nothing', () => {
    expect(clampBars(0)).toBe(MIN_SECTION_BARS);
    expect(clampBars(0.4)).toBe(MIN_SECTION_BARS);
    expect(clampBars(-9)).toBe(MIN_SECTION_BARS);
    expect(clampBars(Number.NaN)).toBe(MIN_SECTION_BARS);
    expect(clampBars(Number.POSITIVE_INFINITY)).toBe(MIN_SECTION_BARS);
    expect(clampBars(Number.NEGATIVE_INFINITY)).toBe(MIN_SECTION_BARS);
  });
});

describe('spanBarsOf and totalBars', () => {
  it('counts repeats as length, because that is what the song does', () => {
    expect(spanBarsOf({ id: 'x', name: 'x', bars: 16, repeats: 2 })).toBe(32);
    expect(spanBarsOf({ id: 'x', name: 'x', bars: 16 })).toBe(16);
  });

  it('treats a broken repeat count as one pass, never as zero length', () => {
    expect(spanBarsOf({ id: 'x', name: 'x', bars: 16, repeats: 0 })).toBe(16);
    expect(spanBarsOf({ id: 'x', name: 'x', bars: 16, repeats: -3 })).toBe(16);
    expect(spanBarsOf({ id: 'x', name: 'x', bars: 16, repeats: 2.7 })).toBe(32);
    expect(spanBarsOf({ id: 'x', name: 'x', bars: 16, repeats: Number.NaN })).toBe(16);
  });

  it('totals the whole song', () => {
    expect(totalBars(SONG)).toBe(8 + 16 + 1 + 32);
  });

  it('counts a corrupt section as one bar, not as NaN', () => {
    expect(totalBars([
      { id: 'a', name: 'A', bars: Number.NaN },
      { id: 'b', name: 'B', bars: 3 },
    ])).toBe(4);
  });

  it('is zero for an empty song', () => {
    expect(totalBars([])).toBe(0);
  });
});

describe('pxPerBar', () => {
  it('fills the space when the song fits', () => {
    expect(pxPerBar(10, 800)).toBe(80);
  });

  it('stops shrinking at the floor, and the lane scrolls from there', () => {
    expect(pxPerBar(400, 800)).toBe(MIN_PX_PER_BAR);
  });

  it('stops growing so a two-bar sketch is not a feature film', () => {
    expect(pxPerBar(2, 4000)).toBe(MAX_PX_PER_BAR);
  });

  it('survives a zero-width first paint and an empty song', () => {
    expect(pxPerBar(8, 0)).toBe(MIN_PX_PER_BAR);
    expect(pxPerBar(0, 800)).toBe(MIN_PX_PER_BAR);
    expect(pxPerBar(8, -800)).toBe(MIN_PX_PER_BAR);
    expect(pxPerBar(Number.NaN, 800)).toBe(MIN_PX_PER_BAR);
    expect(pxPerBar(8, Number.NaN)).toBe(MIN_PX_PER_BAR);
  });
});

describe('layoutSections', () => {
  it('places each section at its bar position with its bar width', () => {
    expect(BOXES.map((b) => [b.x, b.width])).toEqual([[0, 80], [80, 160], [240, 10], [250, 320]]);
    expect(BOXES.map((b) => b.startBar)).toEqual([0, 8, 24, 25]);
  });

  it('starts the first section at bar 0, hard against the left edge', () => {
    expect(box(BOXES, 'sec_intro').x).toBe(0);
    expect(box(BOXES, 'sec_intro').startBar).toBe(0);
  });

  it('is bar-proportional: 16 bars is twice the width of 8', () => {
    expect(box(BOXES, 'sec_a').width).toBe(2 * box(BOXES, 'sec_intro').width);
  });

  it('draws a repeated section at its full played length', () => {
    const drop = box(BOXES, 'sec_drop');
    expect(drop.bars).toBe(16);
    expect(drop.repeats).toBe(2);
    expect(drop.spanBars).toBe(32);
    expect(drop.width).toBe(320);
  });

  it('leaves no seam between neighbours at fractional pixels per bar', () => {
    const boxes = layoutSections(SONG, 33.7);
    let expectedX = 0;
    for (const b of boxes) {
      expect(Number.isInteger(b.x)).toBe(true);
      expect(Number.isInteger(b.width)).toBe(true);
      expect(b.x).toBe(expectedX);
      expectedX += b.width;
    }
    // Rounding the cumulative EDGE, not each width, means error never accrues.
    expect(contentWidth(boxes)).toBe(Math.round(totalBars(SONG) * 33.7));
  });

  it('never emits a zero-width section, even when a bar is under one pixel', () => {
    const boxes = layoutSections(SONG, 0.2);
    for (const b of boxes) expect(b.width).toBeGreaterThanOrEqual(1);
    expect(contentWidth(boxes)).toBe(boxes.reduce((s, b) => s + b.width, 0));
  });

  it('clamps a corrupt bar count rather than laying out a negative box', () => {
    const boxes = layoutSections([{ id: 'a', name: 'A', bars: -4 }], 20);
    expect(box(boxes, 'a').bars).toBe(1);
    expect(box(boxes, 'a').width).toBe(20);
  });

  it('falls back on a broken scale instead of producing NaN', () => {
    for (const px of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      for (const b of layoutSections(SONG, px)) {
        expect(Number.isFinite(b.x)).toBe(true);
        expect(b.width).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('does not mutate its input', () => {
    const sections = [{ id: 'a', name: 'A', bars: 4 }];
    const before = JSON.stringify(sections);
    layoutSections(sections, 20);
    expect(JSON.stringify(sections)).toBe(before);
  });

  it('is empty for an empty song', () => {
    expect(layoutSections([], 20)).toEqual([]);
    expect(contentWidth([])).toBe(0);
  });
});

describe('sectionAtX', () => {
  it('is half-open, so a boundary belongs to exactly one section', () => {
    expect(sectionAtX(BOXES, 79)).toBe('sec_intro');
    expect(sectionAtX(BOXES, 80)).toBe('sec_a');
    expect(sectionAtX(BOXES, 239)).toBe('sec_a');
    expect(sectionAtX(BOXES, 240)).toBe('sec_fill');
  });

  it('finds the one-bar fill between two long sections', () => {
    expect(sectionAtX(BOXES, 244)).toBe('sec_fill');
    expect(sectionAtX(BOXES, 249)).toBe('sec_fill');
    expect(sectionAtX(BOXES, 250)).toBe('sec_drop');
  });

  it('returns null off both ends and on nonsense', () => {
    expect(sectionAtX(BOXES, -1)).toBeNull();
    expect(sectionAtX(BOXES, 570)).toBeNull();
    expect(sectionAtX(BOXES, 99999)).toBeNull();
    expect(sectionAtX(BOXES, Number.NaN)).toBeNull();
    expect(sectionAtX([], 10)).toBeNull();
  });
});

describe('edgeAtX', () => {
  it('grabs the right edge from either side within the grip', () => {
    expect(edgeAtX(BOXES, 80)).toBe('sec_intro');
    expect(edgeAtX(BOXES, 80 - EDGE_GRIP_PX)).toBe('sec_intro');
    expect(edgeAtX(BOXES, 80 + EDGE_GRIP_PX)).toBe('sec_intro');
  });

  it('gives the nearest edge when two thin sections both reach the pointer', () => {
    // A ends at 240 and the one-bar fill ends at 250: both are inside a 12px
    // grip from 246, and the nearer one has to win or the fill is unresizable.
    expect(edgeAtX(BOXES, 246)).toBe('sec_fill');
    expect(edgeAtX(BOXES, 241)).toBe('sec_a');
    // A dead heat goes to the earlier section, deterministically.
    expect(edgeAtX(BOXES, 245)).toBe('sec_a');
  });

  it('offers the last edge, so the song can be extended', () => {
    expect(edgeAtX(BOXES, 570)).toBe('sec_drop');
  });

  it('is null in the middle of a wide section and on nonsense', () => {
    expect(edgeAtX(BOXES, 160)).toBeNull();
    expect(edgeAtX(BOXES, 80 + EDGE_GRIP_PX + 1)).toBeNull();
    expect(edgeAtX(BOXES, Number.NaN)).toBeNull();
    expect(edgeAtX([], 10)).toBeNull();
  });
});

describe('barsFromDrag', () => {
  it('snaps to whole bars and nothing finer', () => {
    expect(barsFromDrag(8, 0, 40)).toBe(8);
    expect(barsFromDrag(8, 19, 40)).toBe(8);
    expect(barsFromDrag(8, 21, 40)).toBe(9);
    expect(barsFromDrag(8, -80, 40)).toBe(6);
  });

  it('rounds a pointer exactly on the half-bar boundary outward', () => {
    expect(barsFromDrag(8, 20, 40)).toBe(9);
    expect(barsFromDrag(8, -20, 40)).toBe(8);
    expect(barsFromDrag(8, -21, 40)).toBe(7);
  });

  it('is relative, so a section does not jump the instant it is grabbed', () => {
    // The drop is drawn 320px wide but is a 16-bar section. Grabbing its edge
    // and not moving must leave it at 16; an absolute pointerX/px would say 57.
    const drop = box(BOXES, 'sec_drop');
    expect(barsFromDrag(drop.bars, 0, 10)).toBe(16);
    expect(barsFromDrag(drop.bars, 10, 10)).toBe(17);
  });

  it('cannot drag a section out of existence or past 64 bars', () => {
    expect(barsFromDrag(8, -10000, 40)).toBe(MIN_SECTION_BARS);
    expect(barsFromDrag(8, 10000, 40)).toBe(MAX_SECTION_BARS);
    expect(barsFromDrag(8, -8 * 40, 40)).toBe(MIN_SECTION_BARS);
  });

  it('is inert when the layout has no width yet, or the maths cannot be done', () => {
    expect(barsFromDrag(8, 400, 0)).toBe(8);
    expect(barsFromDrag(8, 400, Number.NaN)).toBe(8);
    expect(barsFromDrag(8, Number.NaN, 40)).toBe(8);
  });
});

describe('trackAtY', () => {
  it('maps a row strip to a row index', () => {
    expect(trackAtY(4, 0, 56)).toBe(0);
    expect(trackAtY(4, 55, 56)).toBe(0);
    expect(trackAtY(4, 56, 56)).toBe(1);
    expect(trackAtY(4, 56 * 3 + 55, 56)).toBe(3);
  });

  it('is null past the last row and above the first, so a drag out cancels', () => {
    expect(trackAtY(4, 224, 56)).toBeNull();
    expect(trackAtY(4, -1, 56)).toBeNull();
    expect(trackAtY(0, 10, 56)).toBeNull();
  });

  it('is null on degenerate geometry', () => {
    expect(trackAtY(4, 10, 0)).toBeNull();
    expect(trackAtY(4, 10, Number.NaN)).toBeNull();
    expect(trackAtY(4, Number.NaN, 56)).toBeNull();
    expect(trackAtY(Number.NaN, 10, 56)).toBeNull();
  });
});

describe('playheadX', () => {
  it('is null when stopped, or pointing at a section that is gone', () => {
    expect(playheadX(BOXES, null, 4, 10)).toBeNull();
    expect(playheadX(BOXES, { sectionId: 'sec_gone', bar: 1, beat: 1 }, 4, 10)).toBeNull();
    expect(playheadX([], { sectionId: 'sec_a', bar: 1, beat: 1 }, 4, 10)).toBeNull();
  });

  it('reads bar and beat as 1-indexed, matching barBeatOfTick', () => {
    expect(playheadX(BOXES, { sectionId: 'sec_a', bar: 1, beat: 1 }, 4, 10)).toBe(80);
    expect(playheadX(BOXES, { sectionId: 'sec_a', bar: 3, beat: 3 }, 4, 10)).toBe(105);
  });

  it('sweeps a repeated section across its whole played length', () => {
    // Bar 32 beat 4 is 31.75 bars into a 32-bar span: 250 + 317.5.
    expect(playheadX(BOXES, { sectionId: 'sec_drop', bar: 32, beat: 4 }, 4, 10)).toBe(567.5);
    // The last instant of the section lands exactly on its right edge.
    expect(playheadX(BOXES, { sectionId: 'sec_drop', bar: 33, beat: 1 }, 4, 10)).toBe(570);
  });

  it('cannot escape its own section, however wrong the position is', () => {
    expect(playheadX(BOXES, { sectionId: 'sec_fill', bar: 40, beat: 1 }, 4, 10)).toBe(250);
    expect(playheadX(BOXES, { sectionId: 'sec_fill', bar: -40, beat: -4 }, 4, 10)).toBe(240);
    expect(playheadX(BOXES, { sectionId: 'sec_a', bar: 9999, beat: 9999 }, 4, 10)).toBe(240);
  });

  it('falls back rather than dividing by a broken beatsPerBar or scale', () => {
    expect(playheadX(BOXES, { sectionId: 'sec_a', bar: 1, beat: 3 }, 0, 10)).toBe(85);
    expect(playheadX(BOXES, { sectionId: 'sec_a', bar: 1, beat: 1 }, 4, 0)).toBe(80);
    expect(playheadX(BOXES, { sectionId: 'sec_a', bar: Number.NaN, beat: Number.NaN }, 4, 10))
      .toBe(80);
  });
});

describe('isDrag', () => {
  it('lets a tap stay a tap', () => {
    expect(isDrag(2, 2)).toBe(false);
    expect(isDrag(0, 0)).toBe(false);
    expect(isDrag(DRAG_THRESHOLD_PX - 1, 0)).toBe(false);
  });

  it('becomes a drag in any direction, on distance and not on either axis', () => {
    expect(isDrag(6, 0)).toBe(true);
    expect(isDrag(0, -6)).toBe(true);
    expect(isDrag(-6, 0)).toBe(true);
    expect(isDrag(DRAG_THRESHOLD_PX, 0)).toBe(true);
    // 3-4-5: neither axis reaches the threshold but the travel does.
    expect(isDrag(3, 4)).toBe(true);
  });

  it('is not a drag on nonsense input', () => {
    expect(isDrag(Number.NaN, 0)).toBe(false);
    expect(isDrag(0, Number.NaN)).toBe(false);
  });
});
