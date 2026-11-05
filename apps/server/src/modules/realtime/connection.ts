import type { ServerResponse } from 'node:http';

/** Bounded writes: stop enqueueing immediately under backpressure. */
export function streamConnection(raw: ServerResponse, cleanup: () => void) {
  let closed = false;
  let blocked: NodeJS.Timeout | undefined;
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(blocked);
    raw.off('close', close);
    raw.off('error', close);
    raw.off('drain', drain);
    cleanup();
    raw.destroy();
  };
  const drain = () => {
    clearTimeout(blocked);
    blocked = undefined;
  };
  raw.once('close', close);
  raw.once('error', close);
  raw.on('drain', drain);
  return {
    close,
    send(frame: string) {
      if (closed || blocked) return;
      if (raw.writableLength + Buffer.byteLength(frame) > 64 * 1024) return close();
      if (!raw.write(frame)) blocked = setTimeout(close, 5000).unref();
    },
  };
}
