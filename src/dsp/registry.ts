import type { EngineModule } from '@/audio/types';
import { AnalogEngine } from './analog-voice';

/**
 * The engine registry. Adding a synthesis engine is one line here plus its
 * module — no app code changes, because the UI builds itself from descriptors.
 */
export const ENGINES: readonly EngineModule[] = [AnalogEngine];

export function engineById(id: string): EngineModule | undefined {
  return ENGINES.find((e) => e.descriptor.id === id);
}

export const DEFAULT_ENGINE_ID = 'analog';
