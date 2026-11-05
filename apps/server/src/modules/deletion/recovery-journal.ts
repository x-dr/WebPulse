import { verifyLedger, type JournalHead, type JournalRecord } from './journal.js';
import type { DeletionJournal } from './worker.js';

type Ledger = { records: JournalRecord[]; head: JournalHead };
export type RecoveryJournal = DeletionJournal & {
  read(): Promise<Ledger>;
  complete(taskId: string, result: unknown): Promise<{ sequence: string }>;
};

/** Reuse immutable original completions; recovery-only outcomes live in recovery_replays. */
export async function finishRecoveryJournal(
  journal: RecoveryJournal,
  baseline: Ledger,
  signingKey: Buffer,
  results: { taskId: string; result: unknown }[],
) {
  const known = new Set(results.map((r) => r.taskId));
  const check = (ledger: Ledger) => {
    verifyLedger(ledger.records, signingKey, ledger.head);
    const prefix = baseline.records.length
      ? ledger.records[baseline.records.length - 1]?.mac
      : '0'.repeat(64);
    if (
      prefix !== baseline.head.mac ||
      ledger.records
        .slice(baseline.records.length)
        .some((r) => r.kind !== 'complete' || !known.has(r.taskId))
    )
      throw new Error('journal_changed_during_recovery');
    return ledger;
  };
  const current = check(await journal.read());
  for (const entry of results) {
    if (!current.records.some((r) => r.kind === 'complete' && r.taskId === entry.taskId))
      await journal.complete(entry.taskId, { recovered: true, result: entry.result });
  }
  const latest = check(await journal.read());
  const completions = results.map((entry) => {
    const complete = latest.records.find((r) => r.kind === 'complete' && r.taskId === entry.taskId);
    if (!complete) throw new Error('journal_incomplete');
    return { taskId: entry.taskId, sequence: complete.sequence };
  });
  return { head: latest.head, completions };
}
