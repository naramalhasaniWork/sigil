import type { JSX } from 'react';
import type { SignupCounts, SignupRecord } from '@/server/signups';

/**
 * The list itself. A server component: the rows are rendered to HTML and never
 * shipped to a client bundle, so a list of real addresses does not end up in a
 * JSON payload sitting in the page source for anyone with the URL.
 *
 * Plain on purpose. This is a tool — who signed up, what for, when — and a chart
 * of six email addresses would be decoration standing where the data goes.
 */

const BORDER = '3px solid var(--ink)';

/** Flat fills, dark text: both chips clear AA against --bg by a wide margin. */
const INTENT_STYLE = {
  plugin: { background: 'var(--physical)', label: 'Plugin' },
  updates: { background: 'var(--fm)', label: 'Updates' },
} as const;

/**
 * `2026-08-19 14:32 UTC`. Fixed and explicit rather than locale-formatted: a
 * server component formatting to the server's locale would render one string on
 * the box in Virginia and mean something else to the person reading it in London.
 */
function stamp(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  return `${at.toISOString().slice(0, 10)} ${at.toISOString().slice(11, 16)} UTC`;
}

function Total({ n, label }: { n: number; label: string }): JSX.Element {
  return (
    <div
      className="flex flex-col gap-1 px-4 py-3"
      style={{ border: BORDER, background: 'var(--panel)' }}
    >
      <span className="text-[28px] font-bold leading-none" style={{ color: 'var(--ink)' }}>
        {n}
      </span>
      <span className="label" style={{ color: 'var(--ink)' }}>{label}</span>
    </div>
  );
}

export function SignupList({
  rows, counts,
}: {
  rows: readonly SignupRecord[];
  counts: SignupCounts;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-5">

      {/*
        Three numbers, and the labels have to be exact. Because a repeat signup
        upgrades `updates` to `plugin` rather than adding a row, the updates count
        is people who asked for updates AND NOT the plugin — saying just "Updates"
        would read as a superset it is not.
      */}
      <div className="grid grid-cols-3 gap-3">
        <Total n={counts.updates + counts.plugin} label="Total" />
        <Total n={counts.plugin} label="Want the plugin" />
        <Total n={counts.updates} label="Updates only" />
      </div>

      {rows.length === 0 ? (
        <p
          className="px-4 py-6 text-[14px]"
          style={{ border: BORDER, background: 'var(--panel)', color: 'var(--ink)' }}
        >
          Nobody yet. The form is live — this fills in as people use it.
        </p>
      ) : (
        <div style={{ border: BORDER, background: 'var(--panel)' }}>
          {/* Column headings, desktop only: at 375px each row reads as a stacked
              block and a header line would label nothing next to it. */}
          <div
            className="hidden sm:grid gap-3 px-4 py-2"
            style={{
              gridTemplateColumns: '1fr 110px 190px',
              borderBottom: BORDER,
            }}
          >
            <span className="label" style={{ color: 'var(--ink)' }}>Email</span>
            <span className="label" style={{ color: 'var(--ink)' }}>Wants</span>
            <span className="label" style={{ color: 'var(--ink)' }}>Signed up</span>
          </div>

          <ul>
            {rows.map((row, i) => (
              <li
                key={row.id}
                className="grid gap-2 px-4 py-3 sm:gap-3 sm:py-2.5"
                style={{
                  gridTemplateColumns: '1fr',
                  // --muted is only safe for structure, never for text. A hairline
                  // between rows owes 3:1, and it clears that.
                  ...(i === 0 ? {} : { borderTop: '1px solid var(--muted)' }),
                }}
              >
                <span
                  className="text-[14px] break-all sm:hidden"
                  style={{ color: 'var(--ink)' }}
                >
                  {row.email}
                </span>
                <div className="flex items-center gap-3 sm:hidden">
                  <IntentChip intent={row.intent} />
                  <span className="text-[12px]" style={{ color: 'var(--ink)' }}>
                    {stamp(row.createdAt)}
                  </span>
                </div>

                {/* Same three values on one line once there is room for them. */}
                <div
                  className="hidden sm:grid items-center gap-3"
                  style={{ gridTemplateColumns: '1fr 110px 190px' }}
                >
                  <span className="text-[14px] break-all" style={{ color: 'var(--ink)' }}>
                    {row.email}
                  </span>
                  <span><IntentChip intent={row.intent} /></span>
                  <span className="text-[12px]" style={{ color: 'var(--ink)' }}>
                    {stamp(row.createdAt)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function IntentChip({ intent }: { intent: SignupRecord['intent'] }): JSX.Element {
  const style = INTENT_STYLE[intent];
  return (
    <span
      className="inline-block px-2 py-1 text-[9px] font-bold uppercase tracking-[0.14em]"
      style={{ border: BORDER, background: style.background, color: 'var(--bg)' }}
    >
      {style.label}
    </span>
  );
}
