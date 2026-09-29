import type { Category, Equipment, Symptom } from '../config/serviceCatalog.js';
import type { Intent } from '../types/jev.js';

/** What the browser phone page shows about a turn: who answered and how long the server took. */
export type CallEvent =
  | { readonly type: 'caller'; readonly turn: number; readonly text: string }
  | {
      readonly type: 'agent';
      readonly turn: number;
      readonly text: string;
      /** `template` = Jev judgment + fixed wording (Fast Path); `openai` = LLM-generated (Deep Path). */
      readonly source: 'template' | 'openai';
      /** Server time from receiving the caller's final transcript to sending this text. */
      readonly elapsedMs: number;
      readonly jevMs?: number;
      readonly openAiMs?: number;
      readonly intent?: Intent;
      readonly category?: Category;
      readonly equipment?: Equipment;
      readonly symptom?: Symptom;
      readonly emergency?: number;
      readonly degraded?: boolean;
    }
  | { readonly type: 'end'; readonly turn: number; readonly reason: string; readonly text: string; readonly elapsedMs: number };

export type CallEventListener = (event: CallEvent) => void;

export interface CallEventBus {
  publish(identity: string, event: CallEvent): void;
  /** Returns the unsubscribe function. */
  subscribe(identity: string, listener: CallEventListener): () => void;
}

/** In-memory fan-out keyed by the browser phone identity. One process only; fine for a demo. */
export function createCallEventBus(): CallEventBus {
  const listeners = new Map<string, Set<CallEventListener>>();
  return {
    publish(identity, event) {
      for (const listener of listeners.get(identity) ?? []) listener(event);
    },
    subscribe(identity, listener) {
      const set = listeners.get(identity) ?? new Set<CallEventListener>();
      listeners.set(identity, set.add(listener));
      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(identity);
      };
    },
  };
}
