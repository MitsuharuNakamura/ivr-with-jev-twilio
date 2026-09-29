import { EventEmitter } from 'node:events';
import { vi } from 'vitest';
import { loadEnv, type Env } from '../src/config/env.js';
import type { RelaySocket } from '../src/handlers/relayHandler.js';
import type { OutboundMessage } from '../src/types/conversation-relay.js';
import type { Equipment, Symptom } from '../src/config/serviceCatalog.js';
import type { JevJudgment } from '../src/types/jev.js';

export const BASE_ENV = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  // injectWS() has no underlying TCP socket for proxy-addr to inspect.
  TRUST_PROXY: 'false',
  PUBLIC_HOST: 'ivr.example.com',
  TYPESAFE_API_KEY: 'ts-test-key',
  OPENAI_API_KEY: 'sk-test-key',
  TWILIO_ACCOUNT_SID: `AC${'0'.repeat(32)}`,
} as const;

export function testEnv(overrides: Record<string, string> = {}): Env {
  return loadEnv({ ...BASE_ENV, ...overrides });
}

/** A triage answer as Jev returns it: both choices with one shared confidence, plus the emergency Noul. */
export function triage(equipment: Equipment, symptom: Symptom, confidence = 0.9, emergency = 0.05): JevJudgment['triage'] {
  return { equipment: { choice: equipment, confidence }, symptom: { choice: symptom, confidence }, emergency };
}

export function judgment(overrides: Partial<JevJudgment> = {}): JevJudgment {
  return {
    intent: 'TROUBLE',
    intentConfidence: 0.9,
    isConfident: 0.95,
    requiresHuman: 0.02,
    provides: {},
    latencyMs: 40,
    degraded: false,
    ...overrides,
  };
}

export function silentLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

export class FakeSocket extends EventEmitter implements RelaySocket {
  readyState = 1;
  readonly raw: string[] = [];

  send(data: string): void {
    this.raw.push(data);
  }

  get sent(): OutboundMessage[] {
    return this.raw.map((data) => JSON.parse(data) as OutboundMessage);
  }

  receive(message: unknown): void {
    this.emit('message', typeof message === 'string' ? message : JSON.stringify(message));
  }
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets already-resolved promise chains in the handler run to completion. */
export async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}
