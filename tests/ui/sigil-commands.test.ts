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

/*
 * SIGIL is an instrument: letters get pressed constantly — to play notes, to
 * name a patch, or by a hand resting on the keyboard. A bare `f` re-rolled Hunt
 * and yanked you onto another tab mid-sound-design.
 *
 * Choosing letters outside the note map is not a fix; the next play surface or
 * text field collides again. The rule is the guard: unmodified keys belong to
 * the instrument, modified keys belong to the application.
 */
describe('no shortcut is a bare letter', () => {
  /*
   * Space is universal for play and the brackets are the octave steppers every
   * tracker has used for decades — transport, not text.
   *
   * `shift+slash` is `?`, punctuation rather than a letter, and the near
   * universal binding for help. It is safe for a second reason worth stating:
   * use-shortcuts.ts guards on isTypingTarget, so nothing fires while a text
   * field has focus. That guard is what makes any of this tolerable.
   */
  const ALLOWED_BARE = new Set(['space', 'bracketleft', 'bracketright', 'shift+slash']);

  it('gives every letter shortcut a modifier', () => {
    const offenders = SHORTCUTS
      .filter((s) => !ALLOWED_BARE.has(s.keys))
      .filter((s) => !/(^|\+)(mod|alt|ctrl|meta)\+/.test(s.keys))
      .map((s) => `${s.id} (${s.keys})`);
    expect(offenders).toEqual([]);
  });

  /*
   * shift alone is NOT enough. Shift+letter is how you type a capital, so a
   * shift-only binding fires while naming a patch.
   */
  it('does not count shift on its own as a modifier for a letter', () => {
    const shiftOnly = SHORTCUTS
      .filter((s) => s.keys.startsWith('shift+'))
      .filter((s) => !ALLOWED_BARE.has(s.keys))
      // shift+letter is how a capital is typed, so it is not a modifier here.
      .filter((s) => /^shift\+[a-z]$/.test(s.keys))
      .map((s) => `${s.id} (${s.keys})`);
    expect(shiftOnly).toEqual([]);
  });
});

/*
 * The header of shortcuts.ts states that alt+D, alt+E and alt+F are avoided
 * because Windows browsers own them — alt+D focuses the address bar and alt+F
 * opens the File menu. That rule was stated in a comment and then broken twice.
 * A comment is not a guard.
 */
describe('avoids combos the browser owns', () => {
  const OWNED = ['alt+d', 'alt+e', 'alt+f'];

  it('binds nothing to alt+D, alt+E or alt+F', () => {
    const clashes = SHORTCUTS
      .filter((s) => OWNED.some((o) => s.keys === o || s.keys === o.replace('alt+', 'alt+shift+')))
      .map((s) => `${s.id} (${s.keys})`);
    expect(clashes).toEqual([]);
  });
});
