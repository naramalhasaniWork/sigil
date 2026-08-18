'use client';

import { useCallback, useState } from 'react';
import {
  createKit, setSlot, clearSlot, kitBytes, kitToZip,
  KO2_MEMORY_BYTES, DEFAULT_KIT_SIZE, type Kit,
} from '@/audio/kit';

export interface KitHandle {
  kit: Kit;
  bytes: number;
  filled: number;
  overCapacity: boolean;
  rename: (name: string) => void;
  assign: (index: number, name: string, wav: Uint8Array, durationMs: number) => void;
  clear: (index: number) => void;
  clearAll: () => void;
  exportZip: () => void;
}

/**
 * Sixteen pads, mirroring the KO II's own layout, exported as a zip you drop
 * into Teenage Engineering's EP Sample Tool. The zip writer and naming rules
 * were already built and validated against `unzip -t`, Python's zipfile and
 * afinfo — this only holds the state and hands the bytes to the browser.
 */
export function useKit(): KitHandle {
  const [kit, setKit] = useState<Kit>(() => createKit('SIGIL Kit', DEFAULT_KIT_SIZE));

  const rename = useCallback((name: string): void => {
    setKit((k) => ({ ...k, name }));
  }, []);

  const assign = useCallback((
    index: number, name: string, wav: Uint8Array, durationMs: number,
  ): void => {
    setKit((k) => setSlot(k, index, name, wav, durationMs));
  }, []);

  const clear = useCallback((index: number): void => {
    setKit((k) => clearSlot(k, index));
  }, []);

  const clearAll = useCallback((): void => {
    setKit((k) => createKit(k.name, k.slots.length));
  }, []);

  const exportZip = useCallback((): void => {
    const zip = kitToZip(kit);
    const blob = new Blob([zip.slice().buffer as ArrayBuffer], { type: 'application/zip' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${kit.name.replace(/[^\w -]+/g, '').trim() || 'sigil-kit'}.zip`;
    a.click();
    URL.revokeObjectURL(url);
  }, [kit]);

  const bytes = kitBytes(kit);

  return {
    kit,
    bytes,
    filled: kit.slots.filter((s) => s.wav !== null).length,
    overCapacity: bytes > KO2_MEMORY_BYTES,
    rename, assign, clear, clearAll, exportZip,
  };
}
