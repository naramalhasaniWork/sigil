import { describe, expect, it } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ENGINES } from '@/ui/components/landing-engines';
import { Landing } from '@/ui/components/landing';

/**
 * The landing page's whole argument is its evidence: screenshots of the running
 * instrument and audio rendered out of it. A missing file does not break the
 * build, does not fail a type check and does not throw at runtime — it just
 * leaves a broken image or a dead player on the one page a stranger sees.
 *
 * So the references and the files on disk are checked against each other here.
 */

const ROOT = join(import.meta.dirname, '../..');
const PUBLIC = join(ROOT, 'public');

const SOURCES = [
  'src/ui/components/landing.tsx',
  'src/ui/components/landing-engines.tsx',
  'src/ui/components/landing-shots.tsx',
  'app/start/page.tsx',
];

/** Every /shots/*.png and /audio/*.mp3 the page names, from its own source. */
function referencedAssets(): string[] {
  const found = new Set<string>();
  for (const rel of SOURCES) {
    const text = readFileSync(join(ROOT, rel), 'utf8');
    for (const m of text.matchAll(/\/(?:shots|audio)\/[A-Za-z0-9._-]+/g)) found.add(m[0]);
  }
  return [...found].sort();
}

function sizeOf(asset: string): number {
  return statSync(join(PUBLIC, asset)).size;
}

describe('landing page assets', () => {
  it('names some', () => {
    // Guards the regex above as much as the page: a rewrite that dropped every
    // image and clip would otherwise pass this file silently.
    expect(referencedAssets().length).toBeGreaterThanOrEqual(9);
  });

  it('has every referenced file on disk, and none of them empty', () => {
    for (const asset of referencedAssets()) {
      expect(() => sizeOf(asset), asset).not.toThrow();
      expect(sizeOf(asset), asset).toBeGreaterThan(4096);
    }
  });

  it('keeps the page light enough to be the first thing anyone loads', () => {
    const total = referencedAssets().reduce((sum, asset) => sum + sizeOf(asset), 0);
    // Screenshots and six demos, all of it: comfortably inside a megabyte, and
    // the audio is preload="none" so most visitors never fetch that half.
    expect(total).toBeLessThan(1_500_000);
  });
});

/** `createElement` rather than JSX because the suite is .ts, not .tsx. */
function render(buyUrl: string): string {
  return renderToStaticMarkup(createElement(Landing, { buyUrl }));
}

describe('the price', () => {
  it('is stated whether or not there is anywhere to buy yet', () => {
    // The whole point: an unset NEXT_PUBLIC_SIGIL_BUY_URL used to hide the price
    // behind "coming soon", which is the one fact a buyer came for.
    expect(render('')).toContain('$49');
    expect(render('https://example.test/buy')).toContain('$49');
  });

  it('links to the shop when there is one, and never to a dead button', () => {
    const withShop = render('https://example.test/buy');
    expect(withShop).toContain('href="https://example.test/buy"');

    const withoutShop = render('');
    expect(withoutShop).not.toContain('example.test');
    // No anchor may exist with an empty destination.
    expect(withoutShop).not.toMatch(/href=""/);
  });
});

describe('engine demos', () => {
  it('covers all six engines exactly once', () => {
    expect(ENGINES).toHaveLength(6);
    expect(new Set(ENGINES.map((e) => e.name)).size).toBe(6);
  });

  it('either plays something or says why it does not', () => {
    // The sampler is the honest gap: it plays audio you bring, so there is no
    // preset of ours to demonstrate. Every other engine must have a clip.
    const withoutDemo = ENGINES.filter((e) => e.demo === null).map((e) => e.name);
    expect(withoutDemo).toEqual(['SAMPLER']);
  });

  it('points every demo at a real audio file', () => {
    for (const engine of ENGINES) {
      if (engine.demo === null) continue;
      expect(engine.demo.src, engine.name).toMatch(/^\/audio\/[A-Za-z0-9._-]+\.mp3$/);
      expect(sizeOf(engine.demo.src), engine.name).toBeGreaterThan(10_000);
      expect(engine.demo.preset.length, engine.name).toBeGreaterThan(0);
    }
  });
});
