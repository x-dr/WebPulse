import Fastify, { LogController } from 'fastify';
import { registerHealthRoutes } from './modules/maintenance/health.js';

export function buildApp(options: { ready: () => Promise<void>; logLevel?: string }) {
  const app = Fastify({
    bodyLimit: 16 * 1024,
    trustProxy: false,
    requestTimeout: 10_000,
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
  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ error: { code: 'NOT_FOUND', message: '接口不存在' } });
  });
  app.setErrorHandler((error, _request, reply) => {
    const code =
      typeof error === 'object' && error !== null && 'statusCode' in error
        ? error.statusCode
        : undefined;
    const status =
      typeof code === 'number' && Number.isInteger(code) && code >= 400 && code < 500 ? code : 500;
    reply.code(status).send({
      error: {
        code: status === 500 ? 'INTERNAL_ERROR' : 'INVALID_REQUEST',
        message: status === 500 ? '服务暂时不可用' : '请求无效',
      },
    });
  });
  registerHealthRoutes(app, options.ready);
  return app;
}
