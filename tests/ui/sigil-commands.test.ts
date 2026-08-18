import { describe, expect, it } from 'vitest';
import { SHORTCUTS, parseKeys } from '@/ui/shortcuts';
import { buildCommands, shortcutHandlers, type SigilActions } from '@/ui/sigil-commands';

/**
 * SIGIL shipped a complete shortcut registry, a help overlay and a command
 * palette that nothing rendered and no keystroke reached — ⌘Z was advertised
 * in a table and did nothing. These tests exist so that cannot happen again by
 * omission: a shortcut with no handler, or a handler with no shortcut, fails
 * here rather than silently in someone's hands.
 */

function stubActions(): { actions: SigilActions; calls: string[] } {
  const calls: string[] = [];
  const note = (name: string) => (...args: unknown[]): void => {
    calls.push(args.length > 0 ? `${name}:${String(args[0])}` : name);
  };
  const actions: SigilActions = {
    power: note('power'),
    panic: note('panic'),
    toggleRecord: note('toggleRecord'),
    bounce: note('bounce'),
    octave: note('octave'),
    selectEngineAt: note('selectEngineAt'),
    stepPreset: note('stepPreset'),
    randomise: note('randomise'),
    save: note('save'),
    undo: note('undo'),
    redo: note('redo'),
    toggleHunt: note('toggleHunt'),
    reroll: note('reroll'),
    breed: note('breed'),
    assignPad: note('assignPad'),
    exportKit: note('exportKit'),
    togglePalette: note('togglePalette'),
    showTab: note('showTab'),
    toggleLayout: note('toggleLayout'),
    toggleHelp: note('toggleHelp'),
  };
  return { actions, calls };
}

describe('shortcut wiring', () => {
  it('gives every advertised shortcut a handler', () => {
    const handlers = shortcutHandlers(stubActions().actions);
    const missing = SHORTCUTS.filter((s) => handlers[s.id] === undefined).map((s) => s.id);
    expect(missing).toEqual([]);
  });

  it('does not handle an id that is not advertised', () => {
    const handlers = shortcutHandlers(stubActions().actions);
    const known = new Set(SHORTCUTS.map((s) => s.id));
    expect(Object.keys(handlers).filter((id) => !known.has(id))).toEqual([]);
  });

  it('parses every registered key combination', () => {
    for (const s of SHORTCUTS) expect(parseKeys(s.keys), s.id).not.toBeNull();
  });

  it('binds no combination twice', () => {
    const seen = new Map<string, string>();
    for (const s of SHORTCUTS) {
      const c = parseKeys(s.keys);
      if (c === null) continue;
      const key = `${c.code}|${String(c.mod)}${String(c.shift)}${String(c.alt)}${String(c.ctrl)}`;
      expect(seen.get(key), `${s.id} collides with ${String(seen.get(key))}`).toBeUndefined();
      seen.set(key, s.id);
    }
  });

  it('runs the action the id names', () => {
    const { actions, calls } = stubActions();
    const handlers = shortcutHandlers(actions);
    handlers['sound.undo']?.();
    handlers['sound.engine5']?.();
    handlers['transport.octaveDown']?.();
    handlers['sound.presetPrev']?.();
    expect(calls).toEqual(['undo', 'selectEngineAt:4', 'octave:-1', 'stepPreset:-1']);
  });
});

describe('command palette rows', () => {
  it('offers one row per wired shortcut, minus the palette itself', () => {
    const { actions } = stubActions();
    const commands = buildCommands(shortcutHandlers(actions), actions);
    const ids = new Set(commands.map((c) => c.id));
    expect(ids.has('view.palette')).toBe(false);
    for (const s of SHORTCUTS) {
      if (s.id === 'view.palette') continue;
      expect(ids.has(s.id), s.id).toBe(true);
    }
  });

  it('reaches every tab, including the ones with no key', () => {
    const { actions, calls } = stubActions();
    const commands = buildCommands(shortcutHandlers(actions), actions);
    for (const c of commands) c.run();
    const tabs = calls.filter((c) => c.startsWith('showTab:')).map((c) => c.slice(8));
    expect(new Set(tabs)).toEqual(
      new Set(['sculpt', 'deep', 'fx', 'hunt', 'export', 'setup']),
    );
  });

  it('prints keys only where a shortcut exists', () => {
    const { actions } = stubActions();
    const commands = buildCommands(shortcutHandlers(actions), actions);
    const byId = new Map(SHORTCUTS.map((s) => [s.id, s.keys]));
    for (const c of commands) expect(c.keys).toBe(byId.get(c.id));
  });

  it('has no duplicate command ids', () => {
    const { actions } = stubActions();
    const commands = buildCommands(shortcutHandlers(actions), actions);
    expect(new Set(commands.map((c) => c.id)).size).toBe(commands.length);
  });
});

describe('registry honesty', () => {
  it('advertises no shortcut whose label promises a surface that is gone', () => {
    const ids = SHORTCUTS.map((s) => s.id);
    // Tape transport and a standalone Visuals view never existed in the app.
    expect(ids).not.toContain('hunt.tapeBack');
    expect(ids).not.toContain('hunt.tapeForward');
    expect(ids).not.toContain('view.visuals');
  });

  it('covers every engine in the registry', async () => {
    const { ENGINES } = await import('@/dsp/registry');
    const engineShortcuts = SHORTCUTS.filter((s) => s.id.startsWith('sound.engine'));
    expect(engineShortcuts).toHaveLength(ENGINES.length);
  });

  it('never puts a bare or shift-only binding on a note key', () => {
    // use-computer-keyboard owns these unmodified; see the reservation rule.
    const NOTE_CODES = new Set([
      'KeyZ', 'KeyS', 'KeyX', 'KeyD', 'KeyC', 'KeyV', 'KeyG', 'KeyB', 'KeyH',
      'KeyN', 'KeyJ', 'KeyM', 'KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY',
      'KeyU', 'KeyI', 'Digit2', 'Digit3', 'Digit5', 'Digit6', 'Digit7',
      'Comma', 'Period',
    ]);
    for (const s of SHORTCUTS) {
      const c = parseKeys(s.keys);
      if (c === null || c.mod || c.alt || c.ctrl) continue;
      expect(NOTE_CODES.has(c.code), `${s.id} steals a playing key`).toBe(false);
    }
  });
});
