import {
  cleanPath,
  cleanUtm,
  defaultRules,
  referrerHost,
  type CollectionRules,
  type PageViewEvent,
  type InteractionEvent,
} from '@webpulse/shared/browser';
import {
  browserIdentity,
  optedOut,
  optOutKey,
  privacyBlocked,
  removeIdentity,
} from './identity.js';
import { Transport } from './transport.js';

export type TrackerOptions = {
  siteId: string;
  endpoint: string;
  consent?: boolean;
  routingMode?: CollectionRules['routing_mode'];
};
export type Tracker = {
  consent(value: boolean): Promise<void>;
  optOut(): void;
  trackPageView(options?: { path?: string }): void;
  destroy(): void;
};
type Page = {
  id: string;
  path: string;
  confirmed: boolean;
  interacted: boolean;
  pending?: InteractionEvent;
  total: number;
  tick: number;
  born: number;
};
export function createTracker(options: TrackerOptions): Tracker {
  let granted = false;
  let starting: Promise<void> | undefined;
  let memoryOptOut = false;
  let generation = 0;
  let rules = defaultRules;
  let identity = '';
  let page: Page | undefined;
  let transport: Transport | undefined;
  let configAbort: AbortController | undefined;
  let detach: (() => void) | undefined;
  let restoring = false;
  let resumeNeeded = false;
  let lastVisible = 0;
  let navPending = false;
  const visible = () =>
    document.visibilityState === 'visible' &&
    !(document as Document & { prerendering?: boolean }).prerendering;
  const allowed = () => granted && !privacyBlocked() && !optedOut(options.siteId);
  const route = () =>
    rules.routing_mode === 'hash' ? location.hash.slice(1).split('?')[0] || '/' : location.pathname;
  const accrue = () => {
    if (!page) return;
    const now = performance.now();
    if (page.tick) page.total = Math.min(43_200_000, page.total + Math.max(0, now - page.tick));
    page.tick = visible() ? now : 0;
  };
  function heartbeat(leaving = false) {
    if (!allowed()) {
      stop(true);
      return;
    }
    accrue();
    if (page?.confirmed) void transport?.heartbeat(page.id, Math.floor(page.total), leaving);
  }
  function interaction(kind: InteractionEvent['interaction_kind']) {
    if (!allowed() || !visible() || !page || page.interacted) return;
    page.interacted = true;
    const event: InteractionEvent = {
      type: 'interaction',
      event_id: crypto.randomUUID(),
      page_view_id: page.id,
      interaction_kind: kind,
    };
    if (page.confirmed) transport?.enqueue(event, () => undefined);
    else page.pending = event;
  }
  function visit(reason: PageViewEvent['reason'], input?: string) {
    if (!allowed() || !visible() || !transport) return;
    const rawPath = input ?? route();
    const nextIdentity = `${location.origin}${rawPath.split(/[?#]/)[0]}`;
    if (reason === 'navigation' && nextIdentity === identity) return;
    heartbeat(true);
    identity = nextIdentity;
    let path: string | null;
    try {
      path = cleanPath(rawPath, rules);
    } catch {
      page = undefined;
      return;
    }
    if (path === null) {
      page = undefined;
      return;
    }
    const current: Page = {
      id: crypto.randomUUID(),
      path,
      confirmed: false,
      interacted: false,
      total: 0,
      tick: performance.now(),
      born: Date.now(),
    };
    page = current;
    const params = new URLSearchParams(location.search);
    const [source, medium, campaign] = cleanUtm(
      {
        utm_source: params.get('utm_source') ?? '',
        utm_medium: params.get('utm_medium') ?? '',
        utm_campaign: params.get('utm_campaign') ?? '',
      },
      rules,
    );
    const host = referrerHost(document.referrer);
    transport.enqueue(
      {
        type: 'page_view',
        event_id: current.id,
        page_view_id: current.id,
        page: { origin: location.origin, path },
        reason,
        referrer: host && host !== '!invalid' ? `https://${host}/` : '',
        utm: { utm_source: source, utm_medium: medium, utm_campaign: campaign },
      },
      () => {
        current.confirmed = true;
        if (current.pending && page === current) {
          transport?.enqueue(current.pending, () => undefined);
          delete current.pending;
        }
      },
    );
  }
  function scheduleNavigation() {
    if (navPending || restoring || rules.routing_mode === 'manual') return;
    navPending = true;
    queueMicrotask(() => {
      navPending = false;
      if (granted && !restoring) visit('navigation');
    });
  }
  function attach() {
    const listeners: (() => void)[] = [];
    const on = (target: EventTarget, type: string, handler: EventListener) => {
      target.addEventListener(type, handler);
      listeners.push(() => target.removeEventListener(type, handler));
    };
    const push = history.pushState;
    const replace = history.replaceState;
    const wrap = (original: typeof push): typeof push =>
      function (this: History, ...args) {
        original.apply(this, args);
        scheduleNavigation();
      };
    const wrappedPush = wrap(push),
      wrappedReplace = wrap(replace);
    if (rules.routing_mode !== 'manual') {
      history.pushState = wrappedPush;
      history.replaceState = wrappedReplace;
      on(window, 'popstate', scheduleNavigation);
      if (rules.routing_mode === 'hash') on(window, 'hashchange', scheduleNavigation);
    }
    on(document, 'visibilitychange', () => {
      if (!allowed()) {
        stop(true);
        return;
      }
      if (!visible()) {
        heartbeat(true);
        transport?.leave();
        lastVisible = Date.now();
      } else {
        if (!page && !identity && rules.routing_mode !== 'manual') visit('initial');
        else if (
          resumeNeeded ||
          Date.now() - lastVisible >= 1800_000 ||
          (page && Date.now() - page.born >= 43_200_000)
        ) {
          resumeNeeded = false;
          visit('resume');
        } else if (!page && rules.routing_mode !== 'manual') visit('initial');
        else if (page) {
          page.tick = performance.now();
          scheduleNavigation();
        }
        void transport?.flush();
      }
    });
    on(window, 'pagehide', () => {
      heartbeat(true);
      transport?.leave();
      if (page) page.tick = 0;
    });
    on(window, 'pageshow', (event) => {
      if ((event as PageTransitionEvent).persisted) {
        restoring = true;
        visit('bfcache');
        setTimeout(() => {
          restoring = false;
        }, 0);
      }
    });
    on(window, 'storage', (event) => {
      if ((event as StorageEvent).key === optOutKey(options.siteId) && optedOut(options.siteId))
        stop(true);
    });
    on(document, 'click', (event) => {
      if (event.isTrusted) interaction('click');
    });
    on(document, 'keydown', (event) => {
      if (event.isTrusted) interaction('key');
    });
    let inputAt = -Infinity;
    for (const name of ['wheel', 'touchmove'])
      on(document, name, (event) => {
        if (event.isTrusted) inputAt = performance.now();
      });
    on(document, 'scroll', (event) => {
      if (event.isTrusted && performance.now() - inputAt <= 1000) interaction('scroll');
    });
    const timer = setInterval(() => {
      if (visible()) heartbeat();
    }, 15000);
    detach = () => {
      listeners.forEach((remove) => remove());
      clearInterval(timer);
      if (history.pushState === wrappedPush) history.pushState = push;
      if (history.replaceState === wrappedReplace) history.replaceState = replace;
    };
  }
  function stop(remove: boolean) {
    generation++;
    granted = false;
    configAbort?.abort();
    detach?.();
    detach = undefined;
    transport?.destroy();
    transport = undefined;
    page = undefined;
    identity = '';
    resumeNeeded = false;
    if (remove) removeIdentity(options.siteId);
  }
  async function start() {
    if (granted || memoryOptOut || privacyBlocked() || optedOut(options.siteId)) return;
    granted = true;
    const run = ++generation;
    configAbort = new AbortController();
    const alive = () => run === generation && allowed();
    try {
      const response = await fetch(
        `${options.endpoint}/api/v1/tracker-config/${encodeURIComponent(options.siteId)}`,
        {
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          signal: AbortSignal.any([configAbort.signal, AbortSignal.timeout(5000)]),
        },
      );
      if (!response.ok || !alive()) {
        if (run === generation) stop(false);
        return;
      }
      const config = (await response.json()) as { data: { rules: CollectionRules } };
      rules = {
        ...defaultRules,
        ...config.data.rules,
        ...(options.routingMode ? { routing_mode: options.routingMode } : {}),
      };
      const cid = await browserIdentity(options.siteId, alive);
      if (!cid || !alive()) return;
      transport = new Transport(options.endpoint, options.siteId, cid, (id) => {
        transport?.forgetPage(id);
        if (page?.id !== id) return;
        delete page.pending;
        if (visible()) visit('resume');
        else resumeNeeded = true;
      });
      lastVisible = Date.now();
      attach();
      if (rules.routing_mode !== 'manual') visit('initial');
    } catch {
      if (run === generation) stop(false);
    }
  }
  const api: Tracker = {
    consent(value) {
      if (!value) {
        stop(true);
        starting = undefined;
        return Promise.resolve();
      }
      if (starting) return starting;
      const task = start();
      starting = task;
      void task.finally(() => {
        if (starting === task) starting = undefined;
      });
      return task;
    },
    optOut() {
      memoryOptOut = true;
      stop(true);
      try {
        localStorage.setItem(optOutKey(options.siteId), '1');
      } catch {
        /* Preference remains effective in memory. */
      }
    },
    trackPageView(value) {
      visit('manual', value?.path);
    },
    destroy() {
      stop(false);
    },
  };
  if (options.consent) void api.consent(true);
  return api;
}
