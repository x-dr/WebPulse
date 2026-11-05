import type { CollectionEvent } from '@webpulse/shared/browser';

type Queued = { event: CollectionEvent; at: number; ack: () => void };
export class Transport {
  private queue: Queued[] = [];
  private sending = false;
  private stopped = false;
  private abort = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatBusy = false;
  constructor(
    private endpoint: string,
    private site: string,
    private cid: string,
    private expired: (page: string) => void,
  ) {}
  private payload(extra: object) {
    return JSON.stringify({ site_id: this.site, cid: this.cid, consent: 'granted', ...extra });
  }
  enqueue(event: CollectionEvent, ack: () => void) {
    if (this.stopped || this.queue.length >= 100) return;
    this.queue.push({ event, ack, at: Date.now() });
    if (this.queue.length >= 20) void this.flush();
    else if (!this.timer)
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flush();
      }, 2000);
  }
  private batch() {
    this.queue = this.queue.filter((item) => Date.now() - item.at <= 120_000);
    const batch: Queued[] = [];
    for (const item of this.queue.slice(0, 20)) {
      // Isolate interactions so a session_expired response identifies the correct page.
      if (
        batch.length &&
        (item.event.type === 'interaction' || batch[0]!.event.type === 'interaction')
      )
        break;
      if (
        new TextEncoder().encode(
          this.payload({ events: [...batch, item].map((entry) => entry.event) }),
        ).length >
        16 * 1024
      )
        break;
      batch.push(item);
    }
    return batch;
  }
  private async wait(ms: number) {
    if (this.stopped) return;
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.abort.signal.removeEventListener('abort', finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      this.abort.signal.addEventListener('abort', finish, { once: true });
    });
  }
  private async send(route: string, payload: string, page: string, born: number) {
    for (let retry = 0; retry <= 3 && !this.stopped && Date.now() - born < 120_000; retry++) {
      let delay = 2 ** retry * 1000 + Math.random() * 250;
      try {
        const response = await fetch(`${this.endpoint}/api/v1/${route}`, {
          method: 'POST',
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          headers: { 'content-type': 'text/plain;charset=UTF-8' },
          body: payload,
          signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(5000)]),
        });
        if (response.status === 204) return true;
        if (response.status === 409) {
          const result = (await response.json()) as { error?: { code?: string } };
          if (
            result.error?.code === 'session_expired' ||
            result.error?.code === 'page_view_missing'
          )
            this.expired(page);
          return false;
        }
        if (![429, 503].includes(response.status)) return false;
        const after = response.headers.get('retry-after');
        if (after) {
          const ms = /^\d+$/.test(after) ? Number(after) * 1000 : Date.parse(after) - Date.now();
          if (Number.isFinite(ms)) delay = Math.max(delay, ms);
        }
      } catch {
        if (this.stopped) return false;
      }
      if (retry < 3 && Date.now() + delay - born < 120_000) await this.wait(delay);
      else return false;
    }
    return false;
  }
  async flush() {
    if (this.sending || this.stopped || !this.queue.length) return;
    this.sending = true;
    try {
      while (!this.stopped && this.queue.length) {
        const batch = this.batch();
        if (!batch.length) return;
        const ok = await this.send(
          'collect',
          this.payload({ events: batch.map((item) => item.event) }),
          batch[0]!.event.page_view_id,
          batch[0]!.at,
        );
        const sent = new Set(batch);
        this.queue = this.queue.filter((item) => !sent.has(item));
        if (ok && !this.stopped) batch.forEach((item) => item.ack());
      }
    } finally {
      this.sending = false;
    }
  }
  async heartbeat(page: string, total: number, leaving = false) {
    if (this.stopped || this.heartbeatBusy) return;
    const body = this.payload({ page_view_id: page, total_visible_ms: total });
    if (leaving) {
      this.beacon('heartbeat', body);
      return;
    }
    this.heartbeatBusy = true;
    try {
      await this.send('heartbeat', body, page, Date.now());
    } finally {
      this.heartbeatBusy = false;
    }
  }
  private beacon(route: string, body: string) {
    try {
      if (
        ['no-referrer', 'origin', 'strict-origin'].includes(
          (document as Document & { referrerPolicy?: string }).referrerPolicy ?? '',
        ) &&
        navigator.sendBeacon?.(
          `${this.endpoint}/api/v1/${route}`,
          new Blob([body], { type: 'text/plain;charset=UTF-8' }),
        )
      )
        return;
      void fetch(`${this.endpoint}/api/v1/${route}`, {
        method: 'POST',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        keepalive: true,
        body,
        headers: { 'content-type': 'text/plain;charset=UTF-8' },
        signal: this.abort.signal,
      }).catch(() => undefined);
    } catch {
      /* Host page must remain unaffected. */
    }
  }
  leave() {
    if (this.stopped) return;
    const batch = this.batch();
    if (batch.length)
      this.beacon('collect', this.payload({ events: batch.map((item) => item.event) }));
    // Retain IDs for a future fetch acknowledgement: Beacon true does not mean delivered.
  }
  forgetPage(page: string) {
    this.queue = this.queue.filter((item) => item.event.page_view_id !== page);
  }
  destroy() {
    this.stopped = true;
    this.queue = [];
    clearTimeout(this.timer);
    this.abort.abort();
  }
}
