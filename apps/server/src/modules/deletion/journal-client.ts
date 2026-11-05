import { readFileSync } from 'node:fs';
import type { Intent, JournalRecord, JournalHead } from './journal.js';

export class JournalClient {
  constructor(
    private url: string,
    private token: string,
  ) {
    const parsed = new URL(url);
    if (
      parsed.protocol !== 'https:' ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    )
      throw new Error('HTTPS journal required');
  }
  private async call<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(new URL(path, this.url), {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(5000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error('journal_unavailable');
    return (await response.json()) as T;
  }
  persist(intent: Intent) {
    return this.call<{ sequence: string }>('/intents', intent);
  }
  complete(taskId: string, result: unknown) {
    return this.call<{ sequence: string }>('/completions', { taskId, result });
  }
  read() {
    return this.call<{ records: JournalRecord[]; head: JournalHead }>('/entries');
  }
}
export function readJournalClient(env = process.env) {
  if (!env.DELETION_JOURNAL_URL) return undefined;
  const token = readFileSync(env.JOURNAL_TOKEN_FILE!, 'utf8').trim();
  if (!/^[a-f0-9]{64}$/i.test(token)) throw new Error('Invalid journal token');
  return new JournalClient(env.DELETION_JOURNAL_URL, token);
}
