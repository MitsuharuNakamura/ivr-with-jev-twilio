import { describe, expect, it, vi } from 'vitest';
import { createCallEventBus, type CallEvent } from '../src/services/callEvents.js';

const caller: CallEvent = { type: 'caller', turn: 1, text: '水漏れ' };

describe('callEventBus', () => {
  it('delivers only to subscribers of the same identity and stops after unsubscribe', () => {
    const bus = createCallEventBus();
    const a = vi.fn();
    const b = vi.fn();
    const off = bus.subscribe('browser-aaaaaaaaaaaa', a);
    bus.subscribe('browser-bbbbbbbbbbbb', b);

    bus.publish('browser-aaaaaaaaaaaa', caller);
    expect(a).toHaveBeenCalledWith(caller);
    expect(b).not.toHaveBeenCalled();

    off();
    bus.publish('browser-aaaaaaaaaaaa', caller);
    expect(a).toHaveBeenCalledOnce();
  });

  it('ignores publishes with no subscriber', () => {
    expect(() => createCallEventBus().publish('browser-cccccccccccc', caller)).not.toThrow();
  });
});
