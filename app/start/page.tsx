import type { JSX } from 'react';
import type { Metadata } from 'next';
import { Landing } from '@/ui/components/landing';

/**
 * The front door for the public build.
 *
 * The instrument itself lives at `/` and loads straight into a playable state,
 * which is right for someone returning. This page is for someone arriving: what
 * the thing is, one button into it, and one button to buy the plugin.
 */

const DESCRIPTION =
  'Six synthesis engines in a browser — analog, FM, physical modelling, granular, '
  + 'wavetable and sampler. Free, no install, nothing stored. Also a VST3 plugin.';

/**
 * The share card is the hero screenshot itself, for the same reason the page
 * leads with it: a link to a synthesiser should show the synthesiser.
 */
const SHARE_IMAGE = {
  url: '/shots/sigil-sculpt.png',
  width: 2240,
  height: 1800,
  alt: 'SIGIL running its FM engine, with a live oscilloscope and spectrum.',
};

export const metadata: Metadata = {
  // `absolute` because the root layout's "%s · SIGIL" template would otherwise
  // make this read "SIGIL - a sound design instrument · SIGIL".
  title: { absolute: 'SIGIL — a sound design instrument' },
  description: DESCRIPTION,
  openGraph: {
    title: 'SIGIL — a sound design instrument',
    description: DESCRIPTION,
    type: 'website',
    images: [SHARE_IMAGE],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'SIGIL',
    description: DESCRIPTION,
    images: [SHARE_IMAGE],
  },
  /*
   * The landing page is the one thing here that SHOULD be indexed. The root
   * layout marks the app noindex — it is a private instrument behind a gate —
   * but this page is the public face and being findable is its job.
   */
  robots: { index: true, follow: true },
};

/**
 * Where the plugin is sold. Unset until there is somewhere real to send people,
 * and the button says "coming soon" rather than pointing at a 404 — a dead buy
 * button costs more trust than an honest "not yet".
 */
const BUY_URL = process.env.NEXT_PUBLIC_SIGIL_BUY_URL ?? '';

export default function StartPage(): JSX.Element {
  return <Landing buyUrl={BUY_URL} />;
}
