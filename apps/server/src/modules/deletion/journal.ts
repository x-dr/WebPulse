import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { mkdir, readFile, open, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Envelope } from './encryption.js';

export type Intent = { taskId: string; keyId: string; envelope: Envelope; schemaVersion: 1 };
export type JournalRecord = {
  sequence: string;
  kind: 'intent' | 'complete';
  taskId: string;
  intent?: Intent;
  result?: unknown;
  previous: string;
  mac: string;
};
export type JournalHead = { sequence: string; mac: string };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function validIntent(value: Intent) {
  if (
    !value ||
    !uuid.test(value.taskId) ||
    value.schemaVersion !== 1 ||
    !/^[\w-]{1,64}$/.test(value.keyId) ||
    !value.envelope ||
    !['nonce', 'ciphertext', 'tag'].every(
      (k) => typeof value.envelope[k as keyof Envelope] === 'string',
    )
  )
    throw new Error('journal_invalid');
  if (JSON.stringify(value).length > 32768) throw new Error('journal_invalid');
}
export function verifyLedger(records: JournalRecord[], key: Buffer, expected?: JournalHead) {
  let previous = '0'.repeat(64);
  const tasks = new Set<string>();
  const completed = new Set<string>();
  for (const [index, record] of records.entries()) {
    const { mac, ...payload } = record;
    const calculated = createHmac('sha256', key).update(JSON.stringify(payload)).digest('hex');
    if (
      record.sequence !== String(index + 1) ||
      record.previous !== previous ||
      !/^[a-f0-9]{64}$/.test(mac) ||
      !timingSafeEqual(Buffer.from(mac), Buffer.from(calculated)) ||
      !uuid.test(record.taskId)
    )
      throw new Error('journal_incomplete');
    if (record.kind === 'intent') {
      validIntent(record.intent!);
      if (record.intent!.taskId !== record.taskId || tasks.has(record.taskId))
        throw new Error('journal_incomplete');
      tasks.add(record.taskId);
    } else if (record.kind === 'complete') {
      if (!tasks.has(record.taskId) || completed.has(record.taskId))
        throw new Error('journal_incomplete');
      completed.add(record.taskId);
    } else throw new Error('journal_incomplete');
    previous = mac;
  }
  const head = { sequence: String(records.length), mac: previous };
  if (expected && (expected.sequence !== head.sequence || expected.mac !== head.mac))
    throw new Error('journal_incomplete');
  return head;
}

/** Single-writer service. Atomic replacement plus file AND directory fsync precede acknowledgement. */
export class FileJournal {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private directory: string,
    private key: Buffer,
  ) {}
  async read() {
    const path = join(this.directory, 'ledger.json');
    const size = await stat(path).catch((error) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!size) throw new Error('journal_uninitialized');
    if (size.size > 4 * 1024 * 1024) throw new Error('journal_capacity');
    const ledger = JSON.parse(await readFile(path, 'utf8')) as {
      records: JournalRecord[];
      head: JournalHead;
    };
    verifyLedger(ledger.records, this.key, ledger.head);
    return ledger;
  }
  async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, 'ledger.json');
    const file = await open(path, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify({ records: [], head: verifyLedger([], this.key) }));
      await file.sync();
    } finally {
      await file.close();
    }
    await this.syncDirectory();
  }
  private async syncDirectory() {
    const dir = await open(this.directory, 'r');
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  }
  private append(
    kind: 'intent' | 'complete',
    taskId: string,
    data: { intent?: Intent; result?: unknown },
  ) {
    const work = this.queue.then(async () => {
      const ledger = await this.read();
      const existing = ledger.records.find((r) => r.taskId === taskId && r.kind === kind);
      if (existing) {
        if (
          JSON.stringify(existing.intent ?? existing.result) !==
          JSON.stringify(data.intent ?? data.result)
        )
          throw new Error('journal_conflict');
        return { sequence: existing.sequence };
      }
      if (
        kind === 'complete' &&
        !ledger.records.some((r) => r.taskId === taskId && r.kind === 'intent')
      )
        throw new Error('journal_missing_intent');
      const payload = {
        sequence: String(ledger.records.length + 1),
        kind,
        taskId,
        ...data,
        previous: ledger.head.mac,
      };
      const record = {
        ...payload,
        mac: createHmac('sha256', this.key).update(JSON.stringify(payload)).digest('hex'),
      };
      const records = [...ledger.records, record];
      const head = verifyLedger(records, this.key);
      const bytes = JSON.stringify({ records, head });
      if (Buffer.byteLength(bytes) > 4 * 1024 * 1024) throw new Error('journal_capacity');
      const temporary = join(this.directory, `.ledger-${randomUUID()}`);
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, join(this.directory, 'ledger.json'));
      await this.syncDirectory();
      return { sequence: record.sequence };
    });
    this.queue = work.catch(() => {});
    return work;
  }
  persist(intent: Intent) {
    validIntent(intent);
    return this.append('intent', intent.taskId, { intent });
  }
  complete(taskId: string, result: unknown) {
    if (!uuid.test(taskId)) throw new Error('journal_invalid');
    return this.append('complete', taskId, { result });
  }
}
