import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ApiError } from './errors.js';

export type RequestBudget = { signal: AbortSignal; deadline: number };
const budgets = new WeakMap<FastifyRequest, RequestBudget>();
export function requestBudget(request: FastifyRequest): RequestBudget {
  const value = budgets.get(request);
  if (!value) throw new Error('Request budget missing');
  return value;
}
export function registerRequestBudget(app: FastifyInstance) {
  app.addHook('onRequest', (request, reply, done) => {
    const controller = new AbortController();
    const deadline = Date.now() + 5000;
    budgets.set(request, { signal: controller.signal, deadline });
    const abort = () => controller.abort(new ApiError(503, 'request_cancelled'));
    const timer = setTimeout(() => {
      controller.abort(new ApiError(503, 'request_timeout'));
      if (!reply.sent)
        reply.code(503).send({ error: { code: 'request_timeout', message: '请求超时' } });
    }, 5000).unref();
    request.raw.once('aborted', abort);
    const close = () => {
      if (!reply.raw.writableFinished) abort();
      cleanup();
    };
    const cleanup = () => {
      clearTimeout(timer);
      request.raw.off('aborted', abort);
      reply.raw.off('close', close);
    };
    reply.raw.once('finish', cleanup);
    reply.raw.once('close', close);
    done();
  });
}

type Waiter = {
  site: string;
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  signal: AbortSignal;
  abort: () => void;
};
export class FairGate {
  private queue: Waiter[] = [];
  private active = new Map<string, number>();
  private total = 0;
  private lastSite = '';
  constructor(
    private readonly concurrency = 4,
    private readonly perSite = 2,
    private readonly capacity = 64,
    private readonly siteCapacity = 16,
  ) {}
  acquire(site: string, signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (
      this.queue.length + this.total >= this.capacity ||
      this.queue.filter((item) => item.site === site).length + (this.active.get(site) ?? 0) >=
        this.siteCapacity
    )
      return Promise.reject(new ApiError(503, 'server_busy'));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        site,
        signal,
        resolve,
        reject,
        abort: () => {
          this.queue = this.queue.filter((item) => item !== waiter);
          reject(signal.reason);
        },
      };
      signal.addEventListener('abort', waiter.abort, { once: true });
      this.queue.push(waiter);
      this.drain();
    });
  }
  private drain() {
    while (this.total < this.concurrency) {
      let index = this.queue.findIndex(
        (item) => item.site !== this.lastSite && (this.active.get(item.site) ?? 0) < this.perSite,
      );
      if (index < 0)
        index = this.queue.findIndex((item) => (this.active.get(item.site) ?? 0) < this.perSite);
      if (index < 0) return;
      const item = this.queue.splice(index, 1)[0]!;
      item.signal.removeEventListener('abort', item.abort);
      this.lastSite = item.site;
      this.total++;
      this.active.set(item.site, (this.active.get(item.site) ?? 0) + 1);
      let released = false;
      item.resolve(() => {
        if (released) return;
        released = true;
        this.total--;
        const remaining = this.active.get(item.site)! - 1;
        if (remaining) this.active.set(item.site, remaining);
        else this.active.delete(item.site);
        this.drain();
      });
    }
  }
}

export class RateLimits {
  private buckets = new Map<string, { tokens: number; at: number }>();
  private lastSweep = 0;
  take(key: string, capacity: number, perSecond: number, cost = 1) {
    const now = Date.now();
    if (now - this.lastSweep >= 60_000) {
      for (const [id, bucket] of this.buckets)
        if (now - bucket.at > 120_000) this.buckets.delete(id);
      this.lastSweep = now;
    }
    const old = this.buckets.get(key);
    if (!old && this.buckets.size >= 10_000) {
      for (const [id, bucket] of this.buckets)
        if (now - bucket.at > 120_000) this.buckets.delete(id);
      if (this.buckets.size >= 10_000) throw new ApiError(429, 'rate_limited');
    }
    const tokens = Math.min(
      capacity,
      (old?.tokens ?? capacity) + ((now - (old?.at ?? now)) / 1000) * perSecond,
    );
    if (tokens < cost) throw new ApiError(429, 'rate_limited');
    this.buckets.set(key, { tokens: tokens - cost, at: now });
  }
}
