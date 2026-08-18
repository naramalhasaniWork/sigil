import type { MetadataRoute } from 'next';

/**
 * Makes SIGIL installable.
 *
 * Setup used to mean cloning a repo and having Node — fine for the author,
 * hopeless for anyone he wants to hand it to. As a PWA the whole install is
 * "open the link, tap Install": a real icon, its own window with no browser
 * chrome, and on iOS an entry on the home screen. No download, no code signing,
 * no store review, no Gatekeeper warning.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'SIGIL',
    short_name: 'SIGIL',
    description:
      'A sound-design instrument. Six synthesis engines, discovery by ear, and samples that '
      + 'land straight on hardware.',
    start_url: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: '#0E0E0E',
    theme_color: '#0E0E0E',
    categories: ['music', 'entertainment', 'productivity'],
    icons: [
      { src: '/icon', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: '/apple-icon', sizes: '180x180', type: 'image/png' },
    ],
  };
}
