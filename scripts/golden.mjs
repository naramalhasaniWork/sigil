#!/usr/bin/env node
/**
 * SIGIL golden generator.
 *
 * Renders deterministic test signals through the REAL TypeScript DSP and writes
 * raw little-endian float32 goldens plus a JSON manifest to native/goldens/.
 * The C++ port is checked against these, sample for sample, by
 * native/test/parity.cpp.
 *
 *   node scripts/golden.mjs            write goldens
 *   node scripts/golden.mjs --check    regenerate into a temp dir and diff
 *
 * Uses esbuild (already a devDependency) to compile the TypeScript for Node.
 * Nothing under src/ or tests/ is read for anything but its content, and
 * nothing there is ever written.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDsp, loadProbe, flushAll, OUT_DIR, ROOT } from './golden/harness.mjs';
import {
  smoothingCases, blepCases, ladderCases, filterCases, envelopeCases, lfoCases,
} from './golden/cases-core.mjs';
import {
  fxCoreCases, reverbCases, fxChainCases, magicUnitCases, magicChainCases,
} from './golden/cases-fx.mjs';
import {
  analogCases, fmCases, physicalCases, granularCases, wavetableCases, samplerCases,
  sourceBufferCases,
} from './golden/cases-voices.mjs';

const EXPORTS = `
export { Smoother } from '@/dsp/smoothing';
export { blep, SawOscillator } from '@/dsp/blep';
export { LadderFilter } from '@/dsp/ladder';
export { StateVariableFilter, DiodeFilter, createFilter } from '@/dsp/filters';
export { Envelope } from '@/dsp/envelope';
export {
  addOsc, Lfo, WAVE_SAW, WAVE_PULSE, WAVE_TRIANGLE, WAVE_SINE,
  LFO_SINE, LFO_TRIANGLE, LFO_SQUARE, LFO_SAMPLE_HOLD, LFO_RANDOM_WALK,
} from '@/dsp/lfo';
export {
  sat, limitOut, lfo, onePole, flush, Line, N_PARAMS,
  P_DRIVE, P_DRIVE_TONE, P_CRUSH_RATE, P_CRUSH_BITS,
  P_CH_RATE, P_CH_DEPTH, P_CH_WIDTH, P_CH_MIX,
  P_DL_TIME, P_DL_FB, P_DL_TONE, P_DL_WIDTH, P_DL_MIX,
  P_RV_PREDELAY, P_RV_SIZE, P_RV_DECAY, P_RV_DAMP, P_RV_MIX, P_TRIM,
} from '@/dsp/fx-core';
export { Reverb } from '@/dsp/fx-reverb';
export { FxChain } from '@/dsp/fx';
export { FX_DESCRIPTOR } from '@/dsp/fx-descriptor';
export {
  softLimit, saturate, blend, DelayLine, Allpass2, HilbertPair, PitchShifter,
  Diffuser, Tape, FreqShifter, FORMANT_LOG, MAGIC_PARAM, FX_MAGIC_DESCRIPTOR,
} from '@/dsp/fx-magic-descriptor';
export { Freezer, Shimmer, VowelFilter, Stutter } from '@/dsp/fx-magic-units';
export { MagicChain } from '@/dsp/fx-magic';
export { AnalogEngine } from '@/dsp/analog-voice';
export { FmEngine } from '@/dsp/fm-voice';
export { PhysicalEngine } from '@/dsp/physical-voice';
export { GranularEngine } from '@/dsp/granular-voice';
export { WavetableEngine } from '@/dsp/wavetable-voice';
export { SamplerEngine, setActiveSample } from '@/dsp/sampler-voice';
`;

async function generate() {
  const D = await loadDsp(EXPORTS);

  // Module-private source builders, reached by appending an export to a COPY of
  // the file's text in memory. The file on disk is only ever read.
  const samplerProbe = await loadProbe(
    'src/dsp/sampler-voice.ts', 'export { buildDefault as __samplerDefault };',
  );
  const granularProbe = await loadProbe(
    'src/dsp/granular-voice.ts', 'export { getSource as __granularSource };',
  );
  const probes = {
    samplerDefault: samplerProbe.__samplerDefault(),
    granularSource: granularProbe.__granularSource(),
  };

  smoothingCases(D);
  blepCases(D);
  ladderCases(D);
  filterCases(D);
  envelopeCases(D);
  lfoCases(D);

  fxCoreCases(D);
  reverbCases(D);
  fxChainCases(D);
  magicUnitCases(D);
  magicChainCases(D);

  sourceBufferCases(probes);
  analogCases(D);
  fmCases(D);
  physicalCases(D);
  granularCases(D);
  wavetableCases(D);
  // MUST be last of the voices: it calls setActiveSample, which is global state
  // and would change what every later sampler case renders.
  samplerCases(D);

  return flushAll();
}

/** Regenerate in a scratch dir and byte-compare. Determinism is a requirement. */
function selfCheck() {
  const tmp = mkdtempSync(join(tmpdir(), 'sigil-golden-'));
  try {
    execFileSync(process.execPath, [join(ROOT, 'scripts/golden.mjs')], {
      env: { ...process.env, SIGIL_GOLDEN_OUT: tmp }, stdio: 'inherit',
    });
    const a = readdirSync(OUT_DIR).sort();
    const b = readdirSync(tmp).sort();
    if (a.join('\n') !== b.join('\n')) {
      console.error('MISMATCH: file lists differ');
      return 1;
    }
    let bad = 0;
    for (const f of a) {
      if (!readFileSync(join(OUT_DIR, f)).equals(readFileSync(join(tmp, f)))) {
        console.error(`MISMATCH: ${f}`);
        bad++;
      }
    }
    if (bad) { console.error(`${bad} file(s) differ between runs`); return 1; }
    console.log(`determinism OK: ${a.length} files byte-identical across two runs`);
    return 0;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const check = process.argv.includes('--check');
const r = await generate();
console.log(`wrote ${r.caseCount} cases / ${r.fileCount} files to ${OUT_DIR}`);
if (check) process.exit(selfCheck());
