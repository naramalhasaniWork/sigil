import type { Metadata, Viewport } from 'next';
import type { ReactNode, JSX } from 'react';
import { Space_Grotesk } from 'next/font/google';
import './globals.css';

const grotesk = Space_Grotesk({
  subsets: ['latin'],
  weight: ['400', '500', '700'],
  variable: '--font-grotesk',
  display: 'swap',
});

/*
 * Absolute URLs are required for og:image — a relative path renders as a broken
 * card in every messaging app. Railway injects RAILWAY_PUBLIC_DOMAIN at runtime;
 * NEXT_PUBLIC_SITE_URL overrides it for a custom domain. The localhost fallback
 * only ever applies in development.
 */
const siteUrl = process.env.NEXT_PUBLIC_SITE_URL
  ?? (process.env.RAILWAY_PUBLIC_DOMAIN !== undefined
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : 'http://localhost:3000');

/*
 * Said once, used everywhere. Long enough to explain what the thing is, short
 * enough that no major platform truncates it mid-sentence.
 */
const DESCRIPTION = 'A sound design instrument for the browser. Six synthesis engines — '
  + 'analog, FM, physical modelling, granular, wavetable and sampler — with presets that '
  + 'sound good immediately, discovery by ear, and one-tap sample export to hardware.';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  /*
   * `default` is the bare wordmark; `template` gives any child page a suffix
   * without repeating it. A tab reading "SIGIL" is the whole brand.
   */
  title: { default: 'SIGIL', template: '%s · SIGIL' },
  description: DESCRIPTION,
  applicationName: 'SIGIL',
  keywords: [
    'synthesizer', 'sound design', 'FM synthesis', 'granular', 'wavetable',
    'physical modelling', 'sampler', 'web audio', 'music production',
  ],
  openGraph: {
    type: 'website',
    siteName: 'SIGIL',
    title: 'SIGIL — a sound design instrument',
    description: DESCRIPTION,
    url: siteUrl,
    locale: 'en_GB',
  },
  twitter: {
    // Large card: the mark and the engine colours need the room to read as a
    // designed object rather than a favicon beside a paragraph.
    card: 'summary_large_image',
    title: 'SIGIL — a sound design instrument',
    description: DESCRIPTION,
  },
  appleWebApp: {
    capable: true,
    title: 'SIGIL',
    statusBarStyle: 'black-translucent',
  },
  formatDetection: { telephone: false },
  /*
   * The instrument is private and behind a passcode; there is nothing here for
   * a crawler to index, and an indexed gate page is just noise.
   */
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: '#0E0E0E',
  // The instrument is a fixed control surface; pinch-zooming it just breaks the
  // layout, and viewport-fit lets the pads reach under the home indicator.
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
};

export default function RootLayout({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  return (
    <html lang="en" className={grotesk.variable}>
      <body>{children}</body>
    </html>
  );
}
