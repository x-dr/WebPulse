import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { createHash, timingSafeEqual } from 'node:crypto';
import { FileJournal, type Intent } from './journal.js';

export async function serveJournal(env = process.env) {
  const signing = readFileSync(env.JOURNAL_SIGNING_KEY_FILE!, 'utf8').trim();
  if (!/^[a-f0-9]{64}$/i.test(signing)) throw new Error('Invalid journal key');
  const key = Buffer.from(signing, 'hex');
  const token = readFileSync(env.JOURNAL_TOKEN_FILE!, 'utf8').trim();
  if (key.length !== 32 || !/^[a-f0-9]{64}$/i.test(token) || key.toString('hex') === token)
    throw new Error('Independent journal keys required');
  const journal = new FileJournal(env.JOURNAL_DIR!, key);
  // Initialization is a separate, explicit command; missing storage never resets history.
  await journal.read();
  const hash = (s: string) => createHash('sha256').update(s).digest();
  const server = createServer(
    {
      cert: readFileSync(env.JOURNAL_TLS_CERT_FILE!),
      key: readFileSync(env.JOURNAL_TLS_KEY_FILE!),
    },
    async (req, res) => {
      res.setHeader('cache-control', 'no-store');
      res.setHeader('content-type', 'application/json');
      try {
        if (!timingSafeEqual(hash(req.headers.authorization ?? ''), hash(`Bearer ${token}`))) {
          res.writeHead(401).end('{}');
          return;
        }
        if (req.method === 'GET' && req.url === '/entries') {
          res.end(JSON.stringify(await journal.read()));
          return;
        }
        if (req.method !== 'POST' || !['/intents', '/completions'].includes(req.url ?? '')) {
          res.writeHead(404).end('{}');
          return;
        }
        let body = '';
        for await (const chunk of req) {
          body += String(chunk);
          if (Buffer.byteLength(body) > 32768) throw new Error('body_limit');
        }
        const value = JSON.parse(body);
        const result =
          req.url === '/intents'
            ? await journal.persist(value as Intent)
            : await journal.complete(value.taskId, value.result);
        res.end(JSON.stringify(result));
      } catch {
        res.writeHead(503).end('{"error":"journal_unavailable"}');
      }
    },
  );
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(env.JOURNAL_PORT ?? 8443), '0.0.0.0', resolve);
  });
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () => {
      server.close();
      server.closeAllConnections();
    });
}
