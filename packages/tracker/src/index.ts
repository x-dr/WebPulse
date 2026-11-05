import { createTracker, type Tracker } from './tracker.js';
export { createTracker } from './tracker.js';
export type { Tracker, TrackerOptions } from './tracker.js';
export const version = '0.1.0';

declare global {
  interface Window {
    webpulse?: Tracker;
    webpulseQueue?: Array<
      ['consent', boolean] | ['optOut'] | ['trackPageView', { path?: string }?]
    >;
  }
}
const script = document.currentScript as HTMLScriptElement | null;
if (script?.dataset.siteId && !window.webpulse) {
  try {
    const endpoint = new URL(script.src).origin;
    const tracker = createTracker({
      siteId: script.dataset.siteId,
      endpoint,
      consent: script.dataset.consent === 'granted',
    });
    window.webpulse = tracker;
    const queued = window.webpulseQueue ?? [];
    window.webpulseQueue = [];
    void (async () => {
      for (const command of queued) {
        if (command[0] === 'consent') await tracker.consent(command[1]);
        else if (command[0] === 'optOut') tracker.optOut();
        else tracker.trackPageView(command[1]);
      }
    })();
    window.dispatchEvent(new Event('webpulse:ready'));
  } catch {
    /* An unavailable browser API must not break the host. */
  }
}
