// Stato del modello che gira sul dispositivo, condiviso tra Chat, Home e Impostazioni.
import { useEffect, useState } from 'react';

export type LocalModelState =
  | { kind: 'loading'; text: string; percent?: number }
  | { kind: 'ready'; device: string }
  | { kind: 'deleted' }
  | { kind: 'error'; text: string };

export const LOCAL_MODEL = { label: 'Qwen3 0.6B', sizeMB: 382 };

export const local = {
  state: { kind: 'loading', text: 'Avvio di QVAC…' } as LocalModelState,
  modelId: null as string | null,
  lastTokensPerSecond: null as number | null,
  answers: 0,
  // impostata dalla Chat, che possiede il modello caricato
  deleteModel: null as null | (() => Promise<void>),
};

const listeners = new Set<() => void>();

export function setLocal(patch: Partial<typeof local>) {
  Object.assign(local, patch);
  listeners.forEach((fn) => fn());
}

export function useLocal() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const fn = () => setTick((t) => t + 1);
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }, []);
  return local;
}
