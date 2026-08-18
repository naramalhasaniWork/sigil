/**
 * The vocabulary a patch is named from.
 *
 * Materials, weather and architecture only: nothing jokey, no adjectives pressed
 * into service as nouns, nothing that will read as a random word generator in six
 * months. Eight synonyms per polarity rather than five, because siblings in a hunt
 * share a character and a short list had two of six cards coming back "Quiet".
 *
 * Split out of `signature.ts` purely for size — this is data, and it will keep
 * growing as the vocabulary is tuned by ear.
 */

interface Polarity {
  readonly adj: readonly string[];
  readonly noun: readonly string[];
}

export interface AxisWords {
  readonly high: Polarity;
  readonly low: Polarity;
}

export const AXIS_WORDS: readonly AxisWords[] = [
  { // body
    high: {
      adj: ['Heavy', 'Deep', 'Leaden', 'Thick', 'Sunken', 'Broad', 'Weighted', 'Low'],
      noun: ['Slab', 'Hull', 'Anvil', 'Stone', 'Girder', 'Keel', 'Bedrock', 'Vault'],
    },
    low: {
      adj: ['Thin', 'Hollow', 'Bare', 'Faint', 'Narrow', 'Slight', 'Spare', 'Frail'],
      noun: ['Thread', 'Reed', 'Wire', 'Husk', 'Paper', 'Filament', 'Splinter', 'Rind'],
    },
  },
  { // air
    high: {
      adj: ['Bright', 'Silver', 'Keen', 'Pale', 'Open', 'Glazed', 'Lucid', 'Sheer'],
      noun: ['Halo', 'Sheen', 'Frost', 'Chrome', 'Spire', 'Lantern', 'Lattice', 'Prism'],
    },
    low: {
      adj: ['Dim', 'Dusk', 'Muted', 'Umber', 'Shuttered', 'Veiled', 'Sullen', 'Banked'],
      noun: ['Shade', 'Wool', 'Peat', 'Cellar', 'Loam', 'Hollow', 'Cinder', 'Thicket'],
    },
  },
  { // grit
    high: {
      adj: ['Rusted', 'Burnt', 'Scarred', 'Coarse', 'Charred', 'Bitten', 'Ragged', 'Scorched'],
      noun: ['Ash', 'Cinder', 'Tar', 'Slag', 'Grindstone', 'Flint', 'Gravel', 'Iron'],
    },
    low: {
      adj: ['Clean', 'Smooth', 'Clear', 'Fine', 'Soft', 'Polished', 'Plain', 'Even'],
      noun: ['Silk', 'Milk', 'Vellum', 'Salt', 'Ivory', 'Linen', 'Glass', 'Chalk'],
    },
  },
  { // motion
    high: {
      adj: ['Drifting', 'Restless', 'Tidal', 'Wandering', 'Shivering', 'Turning', 'Unsettled', 'Loose'],
      noun: ['Tide', 'Swarm', 'Current', 'Pulse', 'Weather', 'Eddy', 'Drift', 'Migration'],
    },
    low: {
      adj: ['Still', 'Fixed', 'Steady', 'Held', 'Quiet', 'Set', 'Moored', 'Level'],
      noun: ['Anchor', 'Slate', 'Column', 'Pane', 'Well', 'Plinth', 'Ledger', 'Mast'],
    },
  },
];
