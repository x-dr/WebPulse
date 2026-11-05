import { useEffect, useState } from 'react';
import type { RealtimeSnapshot } from '@webpulse/shared/browser';
import { isObject, request } from './client';

type Status = 'connecting' | 'live' | 'delayed' | 'paused' | 'unavailable';
type State = { status: Status; data?: RealtimeSnapshot };
function valid(value: unknown, site: string): value is RealtimeSnapshot {
  if (
    !isObject(value) ||
    value.site_id !== site ||
    typeof value.as_of !== 'string' ||
    !Number.isFinite(Date.parse(value.as_of))
  )
    return false;
  const count = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  return (
    count(value.active_visitors_15m) &&
    count(value.pv_last_minute) &&
    Array.isArray(value.minutes) &&
    value.minutes.length === 15 &&
    value.minutes.every((r) => isObject(r) && typeof r.start === 'string' && count(r.pv)) &&
    Array.isArray(value.active_pages) &&
    value.active_pages.length <= 10 &&
    value.active_pages.every(
      (r) => isObject(r) && typeof r.path === 'string' && count(r.visitors),
    ) &&
    Array.isArray(value.recent_pages) &&
    value.recent_pages.length <= 20 &&
    value.recent_pages.every(
      (r) =>
        isObject(r) &&
        typeof r.path === 'string' &&
        typeof r.at === 'string' &&
        typeof r.channel === 'string',
    )
  );
}

/** Visible tabs share one authenticated stream with a Web Lock and BroadcastChannel. */
export function useRealtime(site: string, retry: number) {
  const [state, setState] = useState<State>({ status: 'connecting' });
  useEffect(() => {
    let stopVisible = () => {};
    let disposed = false;
    const visible = () => {
      stopVisible();
      if (document.hidden) {
        setState((previous) => ({ ...previous, status: 'paused' }));
        return;
      }
      setState({ status: 'connecting' });
      const abort = new AbortController();
      let source: EventSource | undefined;
      let reconnect: ReturnType<typeof setTimeout> | undefined;
      let release: (() => void) | undefined;
      let last = Date.now();
      const channel =
        typeof BroadcastChannel === 'undefined'
          ? undefined
          : new BroadcastChannel(`webpulse:realtime:${site}`);
      const update = (value: State, publish = false) => {
        if (disposed || abort.signal.aborted) return;
        if (value.data && !valid(value.data, site)) return;
        last = Date.now();
        setState(value);
        if (publish) channel?.postMessage(value);
      };
      channel?.addEventListener('message', (event) => {
        const value: unknown = event.data;
        if (
          isObject(value) &&
          ['connecting', 'live', 'delayed', 'paused', 'unavailable'].includes(String(value.status))
        )
          update(value as State);
      });
      const unauthorized = () => {
        source?.close();
        channel?.postMessage({ unauthorized: true });
        window.dispatchEvent(new Event('webpulse:unauthorized'));
      };
      channel?.addEventListener('message', (event) => {
        if (event.data?.unauthorized) window.dispatchEvent(new Event('webpulse:unauthorized'));
      });
      const open = () => {
        if (abort.signal.aborted) return;
        source = new EventSource(`/api/v1/realtime?site_id=${encodeURIComponent(site)}`);
        const snapshot = (event: MessageEvent) => {
          try {
            const value: unknown = JSON.parse(event.data);
            if (!valid(value, site)) throw new Error('invalid snapshot');
            update({ status: 'live', data: value }, true);
          } catch {
            setState((previous) => ({ ...previous, status: 'delayed' }));
          }
        };
        source.addEventListener('snapshot', snapshot);
        source.addEventListener('reset', snapshot);
        source.addEventListener('auth_expired', unauthorized);
        source.addEventListener('site_unavailable', () => {
          source?.close();
          update({ status: 'unavailable' }, true);
        });
        source.addEventListener('delayed', () => {
          setState((previous) => ({ ...previous, status: 'delayed' }));
          channel?.postMessage({ status: 'delayed' });
        });
        source.onerror = () => {
          setState((previous) => ({ ...previous, status: 'delayed' }));
          // EventSource hides handshake HTTP status. The session endpoint handles 401.
          void request('/auth/session', { signal: abort.signal }).catch(() => {});
          // A non-200 handshake may permanently close native EventSource.
          // The elected tab keeps retrying a full snapshot through API restarts.
          if (source?.readyState === EventSource.CLOSED && !reconnect && !abort.signal.aborted)
            reconnect = setTimeout(() => {
              reconnect = undefined;
              source?.close();
              open();
            }, 5000);
        };
      };
      const connect = async () => {
        if (abort.signal.aborted) return;
        open();
        await new Promise<void>((resolve) => {
          release = resolve;
          if (abort.signal.aborted) resolve();
        });
      };
      if (channel && navigator.locks) {
        void navigator.locks
          .request(`webpulse:realtime:${site}`, { signal: abort.signal }, connect)
          .catch(() => {});
      } else void connect();
      const stale = setInterval(() => {
        if (Date.now() - last > 15000)
          setState((previous) =>
            previous.status === 'live' ? { ...previous, status: 'delayed' } : previous,
          );
      }, 5000);
      stopVisible = () => {
        abort.abort();
        source?.close();
        release?.();
        channel?.close();
        clearInterval(stale);
        clearTimeout(reconnect);
      };
    };
    visible();
    document.addEventListener('visibilitychange', visible);
    return () => {
      disposed = true;
      stopVisible();
      document.removeEventListener('visibilitychange', visible);
    };
  }, [site, retry]);
  return state;
}
