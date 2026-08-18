import { ImageResponse } from 'next/og';

export const alt = 'SIGIL — a sound design instrument';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

/**
 * The card people see when the link is pasted into a message.
 *
 * Drawn rather than shipped as a binary, for the same reason as the app icon:
 * Next rasterises it at build time, so there is no image tooling in the repo and
 * the mark can never drift from the one in the header.
 *
 * Held to the same rules as the instrument — flat fills, hard 3px edges, one
 * offset shadow, no gradients and no blur. A soft, glowy card would be a promise
 * the app does not keep.
 */

/** The six engines, in rail order. Their real identity colours. */
const ENGINES: readonly (readonly [string, string])[] = [
  ['ANALOG', '#FF6B6B'],
  ['FM', '#4ECDC4'],
  ['PHYSICAL', '#FFD93D'],
  ['GRANULAR', '#8B5CF6'],
  ['WAVETABLE', '#FF9F45'],
  ['SAMPLER', '#7BC96F'],
];

const INK = '#F5F1E6';
const BG = '#0E0E0E';

export default function OpengraphImage(): ImageResponse {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          background: BG,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: 64,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 40 }}>
          {/* The seal, boxed the way pressable things are boxed in the app. */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 152,
              height: 152,
              background: '#171717',
              border: `4px solid ${INK}`,
              boxShadow: `10px 10px 0 0 ${INK}`,
            }}
          >
            <svg width="96" height="96" viewBox="0 0 24 24">
              <g stroke={INK} strokeWidth="2.6" strokeLinecap="square" fill="none">
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

          <div style={{ display: 'flex', flexDirection: 'column', paddingTop: 8 }}>
            <div
              style={{
                fontSize: 132,
                fontWeight: 700,
                color: INK,
                letterSpacing: '0.06em',
                lineHeight: 1,
              }}
            >
              SIGIL
            </div>
            <div
              style={{
                fontSize: 34,
                color: INK,
                letterSpacing: '0.01em',
                marginTop: 18,
                maxWidth: 760,
                lineHeight: 1.3,
              }}
            >
              A sound design instrument. Six engines, discovery by ear, and samples
              that land straight on hardware.
            </div>
          </div>
        </div>

        {/* Engine colours as hard blocks — the rail, flattened. */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div style={{ display: 'flex', gap: 12 }}>
            {ENGINES.map(([name, colour]) => (
              <div
                key={name}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexGrow: 1,
                  height: 72,
                  background: colour,
                  border: `4px solid ${INK}`,
                  color: BG,
                  fontSize: 19,
                  fontWeight: 700,
                  letterSpacing: '0.14em',
                }}
              >
                {name}
              </div>
            ))}
          </div>
          <div
            style={{
              display: 'flex',
              fontSize: 22,
              color: '#F5F1E6',
              letterSpacing: '0.22em',
              fontWeight: 700,
              opacity: 0.72,
            }}
          >
            PLAY IT IN A BROWSER
          </div>
        </div>
      </div>
    ),
    size,
  );
}
