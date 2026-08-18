#!/usr/bin/env node
/**
 * SIGIL desktop launcher.
 *
 * Double-click SIGIL.command (macOS) or run `pnpm desktop`. It installs what is
 * missing, builds only when the build is stale, starts the production server on
 * a free port and opens the browser. No passcode locally: the gate only arms
 * itself when SIGIL_PASSCODE is set, which is a deployment concern.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);

const say = (msg) => process.stdout.write(`  ${msg}\n`);
const rule = () => process.stdout.write(`  ${'─'.repeat(52)}\n`);

process.stdout.write('\n');
rule();
say('SIGIL');
rule();

/** Newest mtime under a directory, ignoring build output and dependencies. */
function newestMtime(dir, skip = new Set(['node_modules', '.next', '.git', 'out'])) {
  let newest = 0;
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else {
        const m = fs.statSync(p).mtimeMs;
        if (m > newest) newest = m;
      }
    }
  };
  walk(dir);
  return newest;
}

function run(cmd, args, label) {
  say(label);
  const res = spawnSync(cmd, args, { stdio: 'inherit', shell: false });
  if (res.status !== 0) {
    say(`FAILED: ${label}`);
    say('Nothing was started. The error above is the reason.');
    process.exit(res.status ?? 1);
  }
}

function freePort(start) {
  return new Promise((resolve, reject) => {
    const tryPort = (port) => {
      if (port > start + 40) { reject(new Error('no free port found')); return; }
      const srv = createServer();
      srv.once('error', () => tryPort(port + 1));
      srv.once('listening', () => srv.close(() => resolve(port)));
      srv.listen(port, '127.0.0.1');
    };
    tryPort(start);
  });
}

async function waitForHealth(port, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/api/health`);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

// ---- 1. dependencies ------------------------------------------------------
const pkgManager = fs.existsSync(path.join(ROOT, 'pnpm-lock.yaml')) ? 'pnpm' : 'npm';
if (!fs.existsSync(path.join(ROOT, 'node_modules'))) {
  run(pkgManager, ['install'], 'Installing dependencies (first run only)…');
} else {
  say('Dependencies present.');
}

// ---- 2. build, only when stale -------------------------------------------
const buildStamp = path.join(ROOT, '.next', 'BUILD_ID');
const built = fs.existsSync(buildStamp) ? fs.statSync(buildStamp).mtimeMs : 0;
const sourceChanged = newestMtime(ROOT) > built;

if (sourceChanged) {
  run(pkgManager, ['run', 'build'], built === 0 ? 'Building…' : 'Source changed — rebuilding…');
} else {
  say('Build is current.');
}

// ---- 3. serve -------------------------------------------------------------
const port = await freePort(4173);
const url = `http://localhost:${port}`;

const server = spawn(pkgManager, ['exec', 'next', 'start', '--port', String(port)], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, NODE_ENV: 'production' },
});

let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d.toString(); });
server.stderr.on('data', (d) => { serverLog += d.toString(); });

const stop = () => {
  if (!server.killed) server.kill('SIGTERM');
};
process.on('SIGINT', () => { say('\n  Stopping SIGIL.'); stop(); process.exit(0); });
process.on('SIGTERM', () => { stop(); process.exit(0); });
server.on('exit', (code) => {
  if (code !== 0 && code !== null) {
    say('The server stopped unexpectedly:');
    process.stdout.write(serverLog.split('\n').slice(-15).join('\n') + '\n');
    process.exit(code);
  }
});

say(`Starting on port ${port}…`);
const healthy = await waitForHealth(port);
if (!healthy) {
  say('The server did not become healthy in time. Last output:');
  process.stdout.write(serverLog.split('\n').slice(-15).join('\n') + '\n');
  stop();
  process.exit(1);
}

if (process.platform === 'darwin') spawnSync('open', [url]);
else if (process.platform === 'win32') spawnSync('cmd', ['/c', 'start', '', url]);
else spawnSync('xdg-open', [url]);

process.stdout.write('\n');
rule();
say(`Running at  ${url}`);
say('');
say('Click POWER, then play with the keys or the pads.');
say('Chrome or Edge is recommended: MIDI, drag-to-DAW and');
say('audio routing to hardware need them. Safari plays fine.');
say('');
say('Close this window or press Control-C to stop.');
rule();
process.stdout.write('\n');
