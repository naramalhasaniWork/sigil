import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * The hand tracker fetches its WASM fileset from a version-pinned CDN path. When
 * that pin drifts from the installed package the request 404s and the UI reports
 * "Hand tracking could not be loaded. Check your connection" — a connection
 * error for what is actually a version mismatch. This test makes the drift fail
 * the build instead of the feature.
 */
describe('mediapipe version pin', () => {
  it('matches the installed @mediapipe/tasks-vision version', () => {
    const source = readFileSync('src/ui/use-hand-control.ts', 'utf8');
    const match = /const MEDIAPIPE_VERSION = '([^']+)'/.exec(source);
    expect(match, 'MEDIAPIPE_VERSION constant not found').not.toBeNull();

    const installed = JSON.parse(
      readFileSync('node_modules/@mediapipe/tasks-vision/package.json', 'utf8'),
    ) as { version: string };

    expect(match?.[1]).toBe(installed.version);
  });

  it('declares the version in package.json dependencies', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    expect(pkg.dependencies?.['@mediapipe/tasks-vision']).toBeDefined();
  });
});
