import { build } from 'esbuild';

await build({
  entryPoints: ['src/audio/worklet/sigil-processor.ts'],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  outfile: 'public/worklet/sigil-processor.js',
  alias: { "@": "./src" },
  logLevel: "info",
});
