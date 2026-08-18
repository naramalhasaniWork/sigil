import { SHORTCUTS } from '@/ui/shortcuts';
import type { Command } from '@/ui/components/command-palette';

/**
 * The one place a shortcut id is turned into something that happens.
 *
 * The registry says a shortcut exists; this says what it does. Keeping the two
 * in separate files, joined by id, is what lets a test assert that every
 * advertised shortcut is actually wired — the failure this app already shipped
 * once, with a full registry, a help sheet and a palette that nothing rendered
 * and no key reached.
 *
 * Actions are named after the gesture, not the key, so re-binding a shortcut
 * never touches the page and the palette gets its rows for free.
 */
export interface SigilActions {
  /** Start audio. Idempotent — the browser needs a gesture, not a toggle. */
  power: () => void;
  panic: () => void;
  toggleRecord: () => void;
  bounce: () => void;
  /** `-1` down, `+1` up. */
  octave: (delta: number) => void;
  /** Index into the engine registry. Out-of-range indices are ignored. */
  selectEngineAt: (index: number) => void;
  /** `-1` previous, `+1` next, wrapping through the current engine's presets. */
  stepPreset: (delta: number) => void;
  randomise: () => void;
  save: () => void;
  undo: () => void;
  redo: () => void;
  toggleHunt: () => void;
  reroll: () => void;
  breed: () => void;
  assignPad: () => void;
  exportKit: () => void;
  togglePalette: () => void;
  showTab: (tab: 'sculpt' | 'deep' | 'fx' | 'hunt' | 'export' | 'setup') => void;
  toggleLayout: () => void;
  toggleHelp: () => void;
}

/** Shortcut id -> the thing it runs. Keys must match {@link SHORTCUTS} exactly. */
export function shortcutHandlers(a: SigilActions): Readonly<Record<string, () => void>> {
  return {
    'transport.power': a.power,
    'transport.panic': a.panic,
    'transport.record': a.toggleRecord,
    'transport.bounce': a.bounce,
    'transport.octaveDown': (): void => a.octave(-1),
    'transport.octaveUp': (): void => a.octave(1),

    'sound.engine1': (): void => a.selectEngineAt(0),
    'sound.engine2': (): void => a.selectEngineAt(1),
    'sound.engine3': (): void => a.selectEngineAt(2),
    'sound.engine4': (): void => a.selectEngineAt(3),
    'sound.engine5': (): void => a.selectEngineAt(4),
    'sound.engine6': (): void => a.selectEngineAt(5),
    'sound.presetNext': (): void => a.stepPreset(1),
    'sound.presetPrev': (): void => a.stepPreset(-1),
    'sound.random': a.randomise,
    'sound.save': a.save,
    'sound.undo': a.undo,
    'sound.redo': a.redo,

    'hunt.toggle': a.toggleHunt,
    'hunt.reroll': a.reroll,
    'hunt.breed': a.breed,

    'kit.assign': a.assignPad,
    'kit.export': a.exportKit,

    'view.palette': a.togglePalette,
    'view.deep': (): void => a.showTab('deep'),
    'view.sculpt': (): void => a.showTab('sculpt'),
    'view.layout': a.toggleLayout,

    'help.shortcuts': a.toggleHelp,
  };
}

/**
 * Tabs with no key of their own. The palette is the discovery surface, so a
 * tab being reachable there is worth more than burning a scarce letter on it —
 * the note keys own most of the alphabet.
 */
const TAB_COMMANDS: readonly { id: string; tab: SigilTab; label: string }[] = [
  { id: 'view.tab.fx', tab: 'fx', label: 'FX view — chain & character' },
  { id: 'view.tab.hunt', tab: 'hunt', label: 'Hunt view — six variations' },
  { id: 'view.tab.export', tab: 'export', label: 'Export view — the bounce tray' },
  { id: 'view.tab.setup', tab: 'setup', label: 'Setup view — kit, MIDI, camera' },
];

type SigilTab = Parameters<SigilActions['showTab']>[0];

/**
 * Every command the palette offers: one row per wired shortcut, printing the
 * keys that would have got you there directly, plus the tabs that have no key.
 *
 * Built from the handler map rather than a second list, so the palette cannot
 * drift from the keyboard and a shortcut with no handler cannot show up
 * offering to do nothing.
 */
export function buildCommands(
  handlers: Readonly<Record<string, () => void>>,
  actions: SigilActions,
): readonly Command[] {
  const commands: Command[] = [];
  for (const s of SHORTCUTS) {
    const run = handlers[s.id];
    // The palette is not a way to open the palette.
    if (run === undefined || s.id === 'view.palette') continue;
    commands.push({ id: s.id, label: s.label, group: s.group, keys: s.keys, run });
  }
  for (const t of TAB_COMMANDS) {
    commands.push({
      id: t.id, label: t.label, group: 'View', run: (): void => actions.showTab(t.tab),
    });
  }
  return commands;
}
