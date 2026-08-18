'use client';

import { useId, type JSX, type ReactNode } from 'react';

export interface PanelProps {
  title: string;
  /** Engine identity colour. Drawn as a block stripe — never as text colour. */
  accent?: string;
  /** Right-aligned controls in the title bar. Keep them small and pressable. */
  actions?: ReactNode;
  /** Controlled. Collapsing is only offered when `onToggleCollapse` is given. */
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  children?: ReactNode;
}

/**
 * The region primitive. Every surface in SIGIL is a Panel, so the app reads as
 * one information architecture rather than a pile of divs: a hard 3px border,
 * a 9px tracked title, an optional identity stripe, an optional actions slot.
 *
 * The whole title bar is the collapse control when the panel is collapsible —
 * that gives a 44px target for free and keeps the affordance obvious, rather
 * than hiding it behind a 16px chevron.
 */
export function Panel({
  title, accent, actions, collapsed = false, onToggleCollapse, children,
}: PanelProps): JSX.Element {
  const uid = useId();
  const bodyId = `${uid}-body`;
  const titleId = `${uid}-title`;
  const collapsible = onToggleCollapse !== undefined;

  const heading = (
    <span id={titleId} className="label" style={{ color: 'var(--ink)' }}>
      {title}
    </span>
  );

  return (
    <section
      aria-labelledby={titleId}
      className="border-[3px] flex flex-col"
      style={{ borderColor: 'var(--ink)', background: 'var(--panel)' }}
    >
      <header
        className="flex items-stretch border-b-[3px]"
        style={{ borderColor: 'var(--ink)' }}
      >
        {accent !== undefined && (
          <span aria-hidden="true" className="w-2.5 shrink-0" style={{ background: accent }} />
        )}

        {collapsible ? (
          <button
            type="button"
            onClick={onToggleCollapse}
            aria-expanded={!collapsed}
            aria-controls={bodyId}
            className="flex flex-1 items-center gap-2.5 min-h-11 px-3 text-left"
          >
            <span
              aria-hidden="true"
              className="w-4 h-4 shrink-0 border-[2px] flex items-center justify-center
                         text-[11px] font-bold leading-none"
              style={{ borderColor: 'var(--ink)', color: 'var(--ink)' }}
            >
              {collapsed ? '+' : '−'}
            </span>
            {heading}
          </button>
        ) : (
          <div className="flex flex-1 items-center min-h-11 px-3">{heading}</div>
        )}

        {actions !== undefined && (
          <div className="flex items-center gap-2 px-2 shrink-0">{actions}</div>
        )}
      </header>

      <div id={bodyId} hidden={collapsed} className="p-4">
        {children}
      </div>
    </section>
  );
}
