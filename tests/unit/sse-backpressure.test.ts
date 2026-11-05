import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { streamConnection } from '../../apps/server/src/modules/realtime/connection.js';

function socket() {
  const raw = Object.assign(new EventEmitter(), {
    writableLength: 0,
    write: vi.fn(() => false),
    destroy: vi.fn(),
  });
  const cleanup = vi.fn();
  const connection = streamConnection(raw as unknown as ServerResponse, cleanup);
  return { raw, cleanup, connection };
}
describe('M4 bounded SSE backpressure', () => {
  it('stops enqueueing while blocked, recovers on drain and closes after five seconds', () => {
    vi.useFakeTimers();
    try {
      const { raw, cleanup, connection } = socket();
      connection.send('a');
      connection.send('b');
      expect(raw.write).toHaveBeenCalledTimes(1);
      raw.emit('drain');
      connection.send('c');
      expect(raw.write).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(5000);
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(raw.destroy).toHaveBeenCalledTimes(1);
      expect(raw.listenerCount('drain')).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it('never writes beyond 64 KiB and releases listeners exactly once', () => {
    const { raw, cleanup, connection } = socket();
    raw.writableLength = 65530;
    connection.send('0123456789');
    connection.close();
    expect(raw.write).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(raw.eventNames()).toEqual([]);
  });
});
