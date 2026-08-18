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

export const metadata: Metadata = {
  title: 'SIGIL',
  description: 'A sound design instrument.',
  applicationName: 'SIGIL',
  /*
   * iOS ignores the web manifest for home-screen installs and reads these
   * instead, so without them "Add to Home Screen" gives a browser bookmark
   * rather than a standalone app.
   */
  appleWebApp: {
    capable: true,
    title: 'SIGIL',
    statusBarStyle: 'black-translucent',
  },
  formatDetection: { telephone: false },
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
