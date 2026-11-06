import Fastify, { LogController } from 'fastify';
import { readFile } from 'node:fs/promises';
import type pg from 'pg';
import type { SecurityConfig } from './config/security.js';
import { ApiError } from './http/errors.js';
import { registerRequestBudget, requestBudget } from './http/budget.js';
import { transaction } from './db/transaction.js';
import { checkRecoveryGate } from './db/recovery-gate.js';
import { registerAuth } from './modules/auth/routes.js';
import { registerSites } from './modules/sites/routes.js';
import { registerCollection } from './modules/collection/routes.js';
import { registerHealthRoutes } from './modules/maintenance/health.js';
import { registerReports } from './modules/reports/routes.js';
import { registerRetention } from './modules/retention/routes.js';
import { registerDeletion } from './modules/deletion/routes.js';
import type { DeletionEncryptor } from './modules/deletion/encryption.js';
import { registerDiagnostics } from './modules/maintenance/diagnostics.js';
import { registerRealtime } from './modules/realtime/routes.js';
import { registerAdmission } from './http/admission.js';
import { registerTelemetry } from './http/telemetry.js';

export function buildApp(options: {
  ready: () => Promise<void>;
  logLevel?: string;
  pool?: pg.Pool;
  security?: SecurityConfig;
  deletionKey?: DeletionEncryptor;
  trustedProxy?: string[];
  sseMax?: number;
}) {
  const app = Fastify({
    bodyLimit: 16 * 1024,
    trustProxy: options.trustedProxy?.length ? options.trustedProxy : false,
    requestTimeout: 5_000,
    logController: new LogController({ disableRequestLogging: true }),
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, allErrors: false } },
    logger: options.logLevel
      ? {
          level: options.logLevel,
          redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers.set-cookie'],
          serializers: {
            req: (request) => ({ method: request.method, route: request.routeOptions?.url }),
          },
        }
      : false,
  });
  registerRequestBudget(app);
  const telemetry = registerTelemetry(app);
  app.addHook('onRequest', (request, reply, done) => {
    reply.header('x-content-type-options', 'nosniff');
    if (request.url.startsWith('/api/')) reply.header('cache-control', 'private, no-store');
    done();
  });
  const admission = registerAdmission(app);
  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ error: { code: 'NOT_FOUND', message: '接口不存在' } });
  });
  app.setErrorHandler((error, _request, reply) => {
    const statusCode =
      typeof error === 'object' && error !== null && 'statusCode' in error
        ? error.statusCode
        : undefined;
    const status =
      typeof statusCode === 'number' && statusCode >= 400 && statusCode < 600 ? statusCode : 500;
    if (status === 429 || status === 503) reply.header('retry-after', '1');
    reply.code(status).send({
      error: {
        code:
          error instanceof ApiError
            ? error.code
            : status === 413
              ? 'payload_too_large'
              : status < 500
                ? 'invalid_schema'
                : 'INTERNAL_ERROR',
        message: status >= 500 ? '服务暂时不可用' : '请求无效',
      },
    });
  });
  if (options.pool && options.security) {
    const pool = options.pool;
    app.addHook('onRequest', async (request) => {
      if (!request.url.startsWith('/api/v1/health/'))
        await transaction(pool, requestBudget(request), (c) => checkRecoveryGate(c));
    });
    const auth = registerAuth(app, options.pool, options.security);
    registerSites(app, auth, options.security.adminOrigin);
    registerCollection(app, options.pool, options.security);
    registerReports(app, options.pool, auth);
    registerRetention(app, auth);
    registerDeletion(app, auth, options.deletionKey);
    registerDiagnostics(app, auth, () => ({
      ...telemetry(),
      ...admission(),
      database_pool: {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
        limit: pool.options.max,
      },
    }));
    registerRealtime(app, options.pool, auth, options.sseMax);
    app.get('/tracker.js', async (_request, reply) => {
      reply
        .type('application/javascript; charset=utf-8')
        .header('cache-control', 'public, max-age=300');
      return readFile(
        process.env.TRACKER_FILE ??
          new URL('../../../packages/tracker/dist/tracker.js', import.meta.url),
        'utf8',
      );
    });
  }
  registerHealthRoutes(app, options.ready);
  return app;
}
