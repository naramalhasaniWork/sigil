'use client';

import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { sanitiseSampleName } from '@/audio/kit';

/**
 * The tray of rendered samples, and the drag-out that gets them into a DAW.
 *
 * A bounce that only lands in ~/Downloads is a toy; a bounce you can drag onto
 * an Ableton track while the loop is still playing is an instrument. Dragging a
 * file *out* of a page is not a web standard — it is Chromium's `DownloadURL`
 * DataTransfer format, so the honest thing to do everywhere else is offer a
 * Download button and say why.
 */

export interface ExportItem {
  id: string;
  name: string;
  wav: Uint8Array;
  createdAt: number;
  engineId: string;
  notes: number[];
  durationMs: number;
}

export interface DragHandleProps {
  draggable: true;
  onDragStart: (e: DragEvent) => void;
  onDragEnd: () => void;
}

export interface DragExport {
  items: ExportItem[];
  add: (item: Omit<ExportItem, 'id' | 'createdAt'>) => string;
  remove: (id: string) => void;
  clear: () => void;
  dragProps: (id: string) => DragHandleProps;
  download: (id: string) => void;
  downloadAll: () => void;
}

/**
 * Each WAV is held in memory twice while it is in the tray (the bytes, plus the
 * Blob behind its object URL). A 2.6s stereo-free bounce at 46875Hz is ~250KB,
 * so 24 rows costs single-digit megabytes — enough history to be useful, small
 * enough that a long session never becomes the reason the tab dies.
 */
const MAX_ITEMS = 24;

/** Chrome refuses rapid-fire programmatic downloads; space them out. */
const DOWNLOAD_STAGGER_MS = 180;

function fileNameFor(item: ExportItem): string {
  const base = item.name.replace(/\.wav$/i, '');
  // Fold to something every filesystem between here and the DAW accepts, then
  // hyphenate: spaces survive a drop but make a mess of a DAW's clip list.
  const safe = sanitiseSampleName(base, 'sigil-sample').replace(/\s+/g, '-');
  return safe + '.wav';
}

interface UserAgentBrand { brand: string }
interface UserAgentData { brands?: readonly UserAgentBrand[] }

/**
 * `DownloadURL` is not feature-detectable — `setData` accepts any string and
 * fails silently at drop time on engines that ignore it. So this is a
 * capability *judgement*, not a probe: Chromium desktop only.
 *
 * Chrome's UA carries "Safari" for hysterical reasons, so the test is positive
 * (a Chromium token) rather than negative. CriOS is Chrome-branded WebKit on
 * iOS and cannot do this; neither can any touch-primary device, which has no
 * desktop or DAW window to drop onto.
 */
export function isDragOutSupported(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  if (window.matchMedia('(pointer: coarse)').matches) return false;

  const ua = navigator.userAgent;
  if (/CriOS|FxiOS|EdgiOS/.test(ua)) return false;

  const data = (navigator as Navigator & { userAgentData?: UserAgentData }).userAgentData;
  const brands = data?.brands;
  if (brands) {
    return brands.some((b) => b.brand === 'Chromium' || b.brand === 'Google Chrome');
  }
  return /(Chrome|Chromium|Edg)\//.test(ua) && !/Firefox/.test(ua);
}

/**
 * `null` until the first client render has happened. The tray renders neither
 * promise nor apology while support is unknown, which keeps the server and
 * client markup identical and avoids flashing "needs Chrome" at Chrome users.
 */
export function useDragOutSupport(): boolean | null {
  const [supported, setSupported] = useState<boolean | null>(null);
  useEffect(() => { setSupported(isDragOutSupported()); }, []);
  return supported;
}

export function useDragExport(): DragExport {
  const [items, setItems] = useState<ExportItem[]>([]);

  // Callbacks read the live list through this ref, so `dragProps`, `download`
  // and `downloadAll` keep stable identities and never re-render a whole tray
  // of rows just because a new bounce arrived.
  const itemsRef = useRef<ExportItem[]>(items);
  itemsRef.current = items;

  const seqRef = useRef(0);

  /**
   * Blob URL lifetime — the one thing that decides whether a drop works.
   *
   * Chromium fetches the blob *after* the drop completes, on its own schedule,
   * so revoking in `dragend` (the tempting place) truncates or kills the file
   * being written. Revoking never instead leaks a Blob per drag.
   *
   * The strategy: one URL per tray item, created lazily on first drag or
   * download, cached here, and revoked at exactly the three moments the item
   * can no longer be dropped — it is removed, the tray is cleared, or the
   * component unmounts. Lifetime is therefore bounded by MAX_ITEMS, not by how
   * many times the owner drags.
   */
  const urlsRef = useRef<Map<string, string>>(new Map());
  /**
   * Staggered downloadAll timers, keyed by item. Without cancellation a row the
   * owner just deleted still gets written to disk, and the late callback
   * re-creates a blob URL for an item no longer in the list — a URL nothing can
   * ever revoke.
   */
  const timersRef = useRef<Array<{ id: string; t: number }>>([]);

  const cancelTimers = (predicate?: (id: string) => boolean): void => {
    const keep: Array<{ id: string; t: number }> = [];
    for (const entry of timersRef.current) {
      if (predicate === undefined || predicate(entry.id)) window.clearTimeout(entry.t);
      else keep.push(entry);
    }
    timersRef.current = keep;
  };

  const urlFor = useCallback((item: ExportItem): string => {
    const cached = urlsRef.current.get(item.id);
    if (cached !== undefined) return cached;
    const bytes = item.wav.slice();
    const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    urlsRef.current.set(item.id, url);
    return url;
  }, []);

  const revoke = useCallback((id: string): void => {
    const url = urlsRef.current.get(id);
    if (url === undefined) return;
    URL.revokeObjectURL(url);
    urlsRef.current.delete(id);
  }, []);

  useEffect(() => {
    const urls = urlsRef.current;
    const timers = timersRef.current;
    return (): void => {
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
      for (const entry of timers) window.clearTimeout(entry.t);
      timers.length = 0;
    };
  }, []);

  const add = useCallback((entry: Omit<ExportItem, 'id' | 'createdAt'>): string => {
    const id = `export-${Date.now().toString(36)}-${seqRef.current++}`;
    const item: ExportItem = { ...entry, id, createdAt: Date.now() };
    setItems((prev) => {
      const next = [item, ...prev];
      // Newest first, so eviction takes from the tail — and the evicted rows
      // hand their object URLs back rather than lingering in the map.
      for (const gone of next.slice(MAX_ITEMS)) revoke(gone.id);
      return next.slice(0, MAX_ITEMS);
    });
    return id;
  }, [revoke]);

  const remove = useCallback((id: string): void => {
    cancelTimers((tid) => tid === id);
    revoke(id);
    setItems((prev) => prev.filter((i) => i.id !== id));
  }, [revoke]);

  const clear = useCallback((): void => {
    cancelTimers();
    for (const id of [...urlsRef.current.keys()]) revoke(id);
    setItems([]);
  }, [revoke]);

  const saveAs = useCallback((item: ExportItem): void => {
    const a = document.createElement('a');
    a.href = urlFor(item);
    a.download = fileNameFor(item);
    a.rel = 'noopener';
    a.click();
    // No revoke: the URL stays owned by the tray item, exactly as for drag.
  }, [urlFor]);

  const download = useCallback((id: string): void => {
    const item = itemsRef.current.find((i) => i.id === id);
    if (item) saveAs(item);
  }, [saveAs]);

  const downloadAll = useCallback((): void => {
    const list = itemsRef.current;
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      if (!item) continue;
      if (i === 0) { saveAs(item); continue; }
      const t = window.setTimeout(() => {
        timersRef.current = timersRef.current.filter((e) => e.t !== t);
        saveAs(item);
      }, i * DOWNLOAD_STAGGER_MS);
      timersRef.current.push({ id: item.id, t });
    }
  }, [saveAs]);

  const dragProps = useCallback((id: string): DragHandleProps => ({
    draggable: true,
    onDragStart: (e: DragEvent): void => {
      const item = itemsRef.current.find((i) => i.id === id);
      if (!item) return;
      const url = urlFor(item);
      const filename = fileNameFor(item);
      const dt = e.dataTransfer;
      dt.effectAllowed = 'copy';
      // Chromium's out-of-browser file drop: "<mime>:<filename>:<absolute url>".
      // Built by concatenation because every part is already a plain string and
      // the colons are the format, not punctuation.
      dt.setData('DownloadURL', 'audio/wav:' + filename + ':' + url);
      // Anything that is not a filesystem still gets something it can use.
      dt.setData('text/uri-list', url);
      dt.setData('text/plain', filename);
    },
    onDragEnd: (): void => {
      // Deliberately empty of cleanup. See the urlsRef note above: the browser
      // is still reading the blob at this point on a cross-application drop.
    },
  }), [urlFor]);

  return { items, add, remove, clear, dragProps, download, downloadAll };
}
