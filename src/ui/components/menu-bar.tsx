'use client';

import {
  useCallback, useEffect, useRef, useState,
  type FocusEvent as ReactFocusEvent, type JSX, type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { formatKeys } from '@/ui/shortcuts';
import { useIsMac } from '@/ui/use-shortcuts';

export interface MenuItem {
  id: string;
  label: string;
  /** Registry key string, shown as a hint. The menu does not bind it. */
  keys?: string;
  disabled?: boolean;
  onSelect?: () => void;
  /** One level only. A submenu inside a submenu is a smell, not a feature. */
  items?: readonly MenuItem[];
}

/**
 * The system menu bar — save, load, export, kit, tuning, settings, help.
 *
 * Nothing that changes the sound goes in here. That is the law of this app:
 * sound-shaping lives on one flat surface where you can hear what you are
 * doing, and menus are for the file-level actions you do between sounds.
 */
export interface MenuBarProps {
  menus: readonly MenuItem[];
  /** Accessible name for the bar itself. */
  label?: string;
}

/** Focus addresses: `t:m` menubar button, `i:m:i` item, `s:m:i:j` submenu item. */
function topOf(key: string): number {
  return Number.parseInt(key.split(':')[1] ?? '0', 10);
}

export function MenuBar({ menus, label = 'System' }: MenuBarProps): JSX.Element {
  const isMac = useIsMac();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const nodes = useRef(new Map<string, HTMLButtonElement | null>());

  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const [subIdx, setSubIdx] = useState<number | null>(null);
  const [focus, setFocus] = useState<{ key: string; tick: number }>({ key: 't:0', tick: 0 });

  const focusNow = useCallback((key: string): void => {
    setFocus((f) => ({ key, tick: f.tick + 1 }));
  }, []);

  useEffect(() => {
    if (focus.tick === 0) return;
    nodes.current.get(focus.key)?.focus();
  }, [focus]);

  const closeAll = useCallback((restoreTo?: number): void => {
    setOpenIdx(null);
    setSubIdx(null);
    if (restoreTo !== undefined) focusNow(`t:${String(restoreTo)}`);
  }, [focusNow]);

  // Outside click dismisses. Menus are transient; they never hold the screen.
  useEffect(() => {
    if (openIdx === null) return;
    const onDown = (e: MouseEvent): void => {
      const target = e.target instanceof Node ? e.target : null;
      if (target !== null && rootRef.current?.contains(target) === true) return;
      setOpenIdx(null);
      setSubIdx(null);
    };
    document.addEventListener('mousedown', onDown);
    return (): void => document.removeEventListener('mousedown', onDown);
  }, [openIdx]);

  const onRootBlur = (e: ReactFocusEvent<HTMLDivElement>): void => {
    const next = e.relatedTarget;
    if (next instanceof Node && rootRef.current?.contains(next) === true) return;
    setOpenIdx(null);
    setSubIdx(null);
  };

  const openMenu = (m: number, item = 0): void => {
    setOpenIdx(m);
    setSubIdx(null);
    focusNow(`i:${String(m)}:${String(item)}`);
  };

  const activate = (item: MenuItem, m: number): void => {
    if (item.disabled === true) return;
    closeAll(m);
    item.onSelect?.();
  };

  const step = (index: number, delta: number, length: number): number =>
    length === 0 ? 0 : (index + delta + length) % length;

  const onTopKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>, m: number): void => {
    const items = menus[m]?.items ?? [];
    const last = menus.length - 1;
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowLeft': {
        e.preventDefault();
        const next = step(m, e.key === 'ArrowRight' ? 1 : -1, menus.length);
        if (openIdx === null) focusNow(`t:${String(next)}`);
        else openMenu(next);
        break;
      }
      case 'ArrowDown':
      case 'Enter':
      case ' ':
        e.preventDefault();
        openMenu(m);
        break;
      case 'ArrowUp':
        e.preventDefault();
        openMenu(m, Math.max(0, items.length - 1));
        break;
      case 'Home':
        e.preventDefault();
        if (openIdx === null) focusNow('t:0'); else openMenu(0);
        break;
      case 'End':
        e.preventDefault();
        if (openIdx === null) focusNow(`t:${String(last)}`); else openMenu(last);
        break;
      case 'Escape':
        e.preventDefault();
        closeAll();
        break;
      default:
        break;
    }
  };

  const onItemKeyDown = (
    e: ReactKeyboardEvent<HTMLButtonElement>, m: number, i: number, item: MenuItem,
  ): void => {
    const items = menus[m]?.items ?? [];
    const children = item.items ?? [];
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        e.preventDefault();
        const next = step(i, e.key === 'ArrowDown' ? 1 : -1, items.length);
        setSubIdx(null);
        focusNow(`i:${String(m)}:${String(next)}`);
        break;
      }
      case 'Home':
        e.preventDefault();
        setSubIdx(null);
        focusNow(`i:${String(m)}:0`);
        break;
      case 'End':
        e.preventDefault();
        setSubIdx(null);
        focusNow(`i:${String(m)}:${String(Math.max(0, items.length - 1))}`);
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (children.length > 0 && item.disabled !== true) {
          setSubIdx(i);
          focusNow(`s:${String(m)}:${String(i)}:0`);
        } else {
          openMenu(step(m, 1, menus.length));
        }
        break;
      case 'ArrowLeft':
        e.preventDefault();
        openMenu(step(m, -1, menus.length));
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (children.length > 0) {
          setSubIdx(i);
          focusNow(`s:${String(m)}:${String(i)}:0`);
        } else {
          activate(item, m);
        }
        break;
      case 'Escape':
        e.preventDefault();
        closeAll(m);
        break;
      case 'Tab':
        closeAll();
        break;
      default:
        break;
    }
  };

  const onSubKeyDown = (
    e: ReactKeyboardEvent<HTMLButtonElement>, m: number, i: number, j: number, child: MenuItem,
  ): void => {
    const children = menus[m]?.items?.[i]?.items ?? [];
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        e.preventDefault();
        const next = step(j, e.key === 'ArrowDown' ? 1 : -1, children.length);
        focusNow(`s:${String(m)}:${String(i)}:${String(next)}`);
        break;
      }
      case 'Home':
        e.preventDefault();
        focusNow(`s:${String(m)}:${String(i)}:0`);
        break;
      case 'End':
        e.preventDefault();
        focusNow(`s:${String(m)}:${String(i)}:${String(Math.max(0, children.length - 1))}`);
        break;
      case 'ArrowLeft':
      case 'Escape':
        e.preventDefault();
        setSubIdx(null);
        focusNow(`i:${String(m)}:${String(i)}`);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        activate(child, m);
        break;
      case 'Tab':
        closeAll();
        break;
      default:
        break;
    }
  };

  const itemClass = 'flex w-full items-center justify-between gap-6 px-3 min-h-11 text-left'
    + ' text-[11px] font-medium leading-none';

  const renderItem = (
    item: MenuItem, key: string, onKey: (e: ReactKeyboardEvent<HTMLButtonElement>) => void,
    onClick: () => void, onHover: () => void, expanded?: boolean,
  ): JSX.Element => {
    const off = item.disabled === true;
    // Focus is moved programmatically (hover and arrows alike), so :focus-visible
    // cannot be relied on to show where you are. Invert the row instead.
    const active = focus.key === key;
    return (
      <button
        key={item.id}
        ref={(el): void => { nodes.current.set(key, el); }}
        type="button"
        role="menuitem"
        tabIndex={-1}
        aria-disabled={off}
        aria-haspopup={expanded === undefined ? undefined : true}
        aria-expanded={expanded}
        onClick={onClick}
        onKeyDown={onKey}
        onMouseEnter={onHover}
        className={itemClass}
        style={{
          background: active && !off ? 'var(--ink)' : 'transparent',
          color: off ? 'var(--muted)' : (active ? 'var(--bg)' : 'var(--ink)'),
        }}
      >
        <span>{item.label}</span>
        {item.keys !== undefined && (
          <span className="text-[10px] tracking-[0.08em]" style={{ opacity: 0.7 }}>
            {formatKeys(item.keys, isMac)}
          </span>
        )}
        {expanded !== undefined && <span aria-hidden="true">▸</span>}
      </button>
    );
  };

  const menuSurface = 'border-[3px] py-1 min-w-56 flex flex-col';
  const surfaceStyle = { borderColor: 'var(--ink)', background: 'var(--panel)' } as const;

  return (
    <div
      ref={rootRef}
      role="menubar"
      aria-label={label}
      className="flex items-stretch relative"
      onBlur={onRootBlur}
    >
      {menus.map((menu, m) => {
        const items = menu.items ?? [];
        const open = openIdx === m;
        return (
          <div key={menu.id} role="none" className="relative">
            <button
              ref={(el): void => { nodes.current.set(`t:${String(m)}`, el); }}
              type="button"
              role="menuitem"
              aria-haspopup="true"
              aria-expanded={open}
              tabIndex={topOf(focus.key) === m ? 0 : -1}
              onClick={(): void => { if (open) closeAll(); else openMenu(m); }}
              onMouseEnter={(): void => { if (openIdx !== null && !open) openMenu(m); }}
              onKeyDown={(e): void => onTopKeyDown(e, m)}
              className="px-3 min-h-11 text-[10px] font-bold uppercase tracking-[0.16em]"
              style={{
                background: open ? 'var(--ink)' : 'transparent',
                color: open ? 'var(--bg)' : 'var(--ink)',
              }}
            >
              {menu.label}
            </button>

            {open && items.length > 0 && (
              <div
                role="menu"
                aria-label={menu.label}
                className={`absolute left-0 top-full z-40 ${menuSurface}`}
                style={surfaceStyle}
              >
                {items.map((item, i) => {
                  const children = item.items ?? [];
                  const hasSub = children.length > 0;
                  return (
                    <div key={item.id} role="none" className="relative flex">
                      {renderItem(
                        item,
                        `i:${String(m)}:${String(i)}`,
                        (e) => onItemKeyDown(e, m, i, item),
                        () => { if (hasSub) { setSubIdx(i); } else { activate(item, m); } },
                        () => {
                          focusNow(`i:${String(m)}:${String(i)}`);
                          setSubIdx(hasSub && item.disabled !== true ? i : null);
                        },
                        hasSub ? subIdx === i : undefined,
                      )}

                      {hasSub && subIdx === i && (
                        <div
                          role="menu"
                          aria-label={item.label}
                          className={`absolute left-full top-0 z-50 ${menuSurface}`}
                          style={surfaceStyle}
                        >
                          {children.map((child, j) => renderItem(
                            child,
                            `s:${String(m)}:${String(i)}:${String(j)}`,
                            (e) => onSubKeyDown(e, m, i, j, child),
                            () => activate(child, m),
                            () => focusNow(`s:${String(m)}:${String(i)}:${String(j)}`),
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
