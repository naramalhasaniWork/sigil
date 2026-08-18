import { ImageResponse } from 'next/og';

export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

/**
 * The iOS home-screen icon, drawn rather than shipped as a binary — Next rasterises this at
 * build time, so there is no image tooling to install and the mark can never
 * drift from the one in the header.
 *
 * It is the SIGIL seal: a stem crossed by tines of falling length, cut by a
 * diagonal so it never resolves into a letter. Generous padding because
 * maskable icons get cropped to a circle on Android.
 */
export default function AppleIcon(): ImageResponse {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          background: '#0E0E0E',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <svg width="120" height="120" viewBox="0 0 24 24">
          <g stroke="#F5F1E6" strokeWidth="2.6" strokeLinecap="square" fill="none">
            <path d="M4 2 L4 22" />
            <path d="M4 5.5 L20 5.5" />
            <path d="M4 12 L14.5 12" />
            <path d="M4 18.5 L9.5 18.5" />
          </g>
          <path
            d="M17 2.5 L10 21.5"
            stroke="#FF6B6B"
            strokeWidth="2.6"
            strokeLinecap="square"
            fill="none"
          />
        </svg>
      </div>
    ),
    size,
  );
}
