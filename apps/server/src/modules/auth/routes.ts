import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import type { SecurityConfig } from '../../config/security.js';
import { transaction } from '../../db/transaction.js';
import { FairGate, RateLimits, requestBudget } from '../../http/budget.js';
import { ApiError } from '../../http/errors.js';
import { digest, identityKey } from '../identity/keys.js';
import { verifyPassword } from './password.js';

export function registerAuth(app: FastifyInstance, pool: pg.Pool, security: SecurityConfig) {
  const cookieName = security.secureCookie ? '__Host-wp_admin' : 'wp_admin_dev';
  const cookie = (token: string, age: number) =>
    `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${security.secureCookie ? '; Secure' : ''}`;
  const csrf = (token: string) =>
    createHmac('sha256', security.csrfKey).update(token).digest('base64url');
  const gate = new FairGate(2, 2, 16, 16);
  const limits = new RateLimits();
  let hashing = false;
  const logoutListeners = new Set<(token: string) => void>();
  function origin(request: FastifyRequest) {
    if (request.headers.origin !== security.adminOrigin) throw new ApiError(403, 'origin_denied');
  }
  function tokenFrom(request: FastifyRequest) {
    return (
      request.headers.cookie
        ?.split(';')
        .map((item) => item.trim())
        .find((item) => item.startsWith(`${cookieName}=`))
        ?.slice(cookieName.length + 1) ?? ''
    );
  }
  async function authenticate(client: pg.PoolClient, request: FastifyRequest, write: boolean) {
    const token = tokenFrom(request);
    if (!/^[\w-]{43}$/.test(token)) throw new ApiError(401, 'auth_required');
    const result = await client.query(
      `SELECT a.username, s.csrf_hash, s.expires_at FROM admin_sessions s JOIN admins a ON a.id=s.admin_id
      WHERE token_hash=$1 AND expires_at>clock_timestamp() AND last_seen_at>clock_timestamp()-interval '24 hours' FOR UPDATE OF s`,
      [digest(token)],
    );
    const session = result.rows[0];
    if (!session) throw new ApiError(401, 'auth_required');
    if (write) {
      origin(request);
      const supplied = request.headers['x-csrf-token'];
      if (typeof supplied !== 'string' || !timingSafeEqual(digest(supplied), session.csrf_hash))
        throw new ApiError(403, 'csrf_invalid');
    }
    await client.query(
      'UPDATE admin_sessions SET last_seen_at=clock_timestamp() WHERE token_hash=$1',
      [digest(token)],
    );
    return {
      username: session.username as string,
      expires_at: (session.expires_at as Date).toISOString(),
      csrf_token: csrf(token),
    };
  }
  async function managed<T>(request: FastifyRequest, work: (client: pg.PoolClient) => Promise<T>) {
    const release = await gate.acquire('management', requestBudget(request).signal);
    try {
      return await transaction(pool, requestBudget(request), work);
    } finally {
      release();
    }
  }
  app.post<{ Body: { username: string; password: string } }>(
    '/api/v1/auth/login',
    {
      schema: {
        body: {
          type: 'object',
          required: ['username', 'password'],
          additionalProperties: false,
          properties: {
            username: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[a-zA-Z0-9_.-]+$' },
            password: { type: 'string', minLength: 1, maxLength: 256 },
          },
        },
      },
    },
    async (request, reply) => {
      origin(request);
      limits.take(
        identityKey(security.ipKey, 'login', '', 1, request.ip).toString('hex'),
        5,
        5 / 60,
      );
      if (hashing) throw new ApiError(503, 'server_busy');
      hashing = true;
      try {
        // Keep the expensive hash outside an open DB transaction, with one hash in flight.
        const admin = await managed(
          request,
          async (client) =>
            (
              await client.query('SELECT id,password_hash FROM admins WHERE username=$1', [
                request.body.username.toLowerCase(),
              ])
            ).rows[0],
        );
        if (!(await verifyPassword(request.body.password, admin?.password_hash)))
          throw new ApiError(401, 'invalid_credentials');
        const token = randomBytes(32).toString('base64url');
        const csrfToken = csrf(token);
        const expires = await managed(request, async (client) => {
          await client.query(
            "DELETE FROM admin_sessions WHERE expires_at<=clock_timestamp() OR last_seen_at<=clock_timestamp()-interval '24 hours'",
          );
          return (
            await client.query(
              `INSERT INTO admin_sessions(token_hash,admin_id,csrf_hash,expires_at) VALUES ($1,$2,$3,clock_timestamp()+interval '7 days') RETURNING expires_at`,
              [digest(token), admin.id, digest(csrfToken)],
            )
          ).rows[0].expires_at as Date;
        });
        reply
          .header('set-cookie', cookie(token, 604800))
          .header('cache-control', 'private, no-store');
        return {
          data: {
            username: request.body.username.toLowerCase(),
            csrf_token: csrfToken,
            expires_at: expires.toISOString(),
          },
        };
      } finally {
        hashing = false;
      }
    },
  );
  app.get('/api/v1/auth/session', async (request, reply) => {
    reply.header('cache-control', 'private, no-store');
    return { data: await managed(request, (client) => authenticate(client, request, false)) };
  });
  app.post('/api/v1/auth/logout', async (request, reply) => {
    await managed(request, async (client) => {
      await authenticate(client, request, true);
      await client.query('DELETE FROM admin_sessions WHERE token_hash=$1', [
        digest(tokenFrom(request)),
      ]);
    });
    for (const listener of logoutListeners) listener(digest(tokenFrom(request)).toString('hex'));
    reply
      .header('set-cookie', cookie('', 0))
      .header('cache-control', 'private, no-store')
      .code(204)
      .send();
  });
  return {
    authenticate,
    managed,
    async streamIdentity(client: pg.PoolClient, request: FastifyRequest) {
      const hash = digest(tokenFrom(request));
      const row = (
        await client.query('SELECT admin_id FROM admin_sessions WHERE token_hash=$1', [hash])
      ).rows[0];
      if (!row) throw new ApiError(401, 'auth_required');
      return { admin: String(row.admin_id), token: hash.toString('hex') };
    },
    onLogout(listener: (token: string) => void) {
      logoutListeners.add(listener);
      return () => {
        logoutListeners.delete(listener);
      };
    },
  };
}
export type AuthService = ReturnType<typeof registerAuth>;
