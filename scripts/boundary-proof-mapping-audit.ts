import { parseGreenCloseEvidenceCommand } from '../src/task-agent/green-close-recipe.js';
import { readFileSync } from 'node:fs';

type ChecklistItem = { id: string; owner?: string; status: string; title: string };
type ChecklistStatus = { version: string; items: ChecklistItem[] };

function validStatus(value: unknown, version: string): value is ChecklistStatus {
  if (!value || typeof value !== 'object') return false;
  const status = value as Record<string, unknown>;
  return status.version === version && Array.isArray(status.items) && status.items.length > 0
    && status.items.every((item: unknown) => {
      if (!item || typeof item !== 'object') return false;
      const row = item as Record<string, unknown>;
      return typeof row.id === 'string' && typeof row.status === 'string'
        && typeof row.title === 'string'
        && (row.owner === undefined || typeof row.owner === 'string');
    });
}

export type AuditRow = {
  id: string;
  owner: string;
  state: 'mapped-unverified' | 'test-run-review-required' | 'manual-verifier-required' | 'invalid-boundary';
  liveBoundary: string | null;
  evidenceCommand: string | null;
  reason: string;
};

function lines(title: string, label: string): string[] {
  return title.split('\n').map((line) => line.trim())
    .filter((line) => line.startsWith(label) || line.startsWith(`- ${label}`))
    .map((line) => line.replace(/^-\s*/, '').slice(label.length).trim());
}

/** Read-only inventory. A command that can run still needs a human check that it proves the live clause. */
export function auditBoundaryMappings(status: ChecklistStatus): AuditRow[] {
  return status.items.filter((item) => item.status === 'yellow' && item.title.includes('완료 경계 실물:'))
    .map((item): AuditRow => {
      const live = lines(item.title, '완료 경계 실물:');
      const commands = lines(item.title, '완료 경계 증거 명령:');
      const mappings = lines(item.title, '완료 경계 실물 검증:');
      const base = { id: item.id, owner: item.owner ?? 'unknown',
        liveBoundary: live.length === 1 ? live[0]! : null,
        evidenceCommand: commands.length === 1 ? commands[0]! : null };
      if (live.length !== 1 || !live[0] || commands.length > 1 || mappings.length > 1)
        return { ...base, state: 'invalid-boundary', reason: 'ambiguous-or-empty-boundary-line' };
      if (mappings.length === 1)
        return { ...base, state: 'mapped-unverified', reason: 'typed-mapping-needs-production-replay' };
      if (commands.length === 1 && parseGreenCloseEvidenceCommand(commands[0]!).ok)
        return { ...base, state: 'test-run-review-required', reason: 'test-command-syntax-only-live-assertion-unproven' };
      return { ...base, state: 'manual-verifier-required', reason: 'no-supported-direct-verifier-mapping' };
    });
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const version = args[0] === '--version' ? args[1] : undefined;
  const snapshot = args[2] === '--snapshot' ? args[3] : undefined;
  const validShape = args.length === 3 && args[2] === '--json'
    || args.length === 5 && args[2] === '--snapshot' && !!snapshot && args[4] === '--json';
  if (!version || !/^\d+\.\d+\.\d+$/.test(version) || !validShape) {
    process.stderr.write('usage: bun scripts/boundary-proof-mapping-audit.ts --version X.Y.Z [--snapshot status.json] --json\n');
    process.exit(2);
  }
  try {
    let raw: string;
    if (snapshot) {
      raw = readFileSync(snapshot, 'utf8');
    } else {
      const child = Bun.spawnSync(['eln', 'release', 'checklist', 'status', '--version', version, '--json'],
        { stdout: 'pipe', stderr: 'pipe', timeout: 30_000 });
      if (child.exitCode !== 0) throw new Error(`checklist status failed rc=${child.exitCode}: ${new TextDecoder().decode(child.stderr).trim()}`);
      raw = new TextDecoder().decode(child.stdout);
    }
    const status = JSON.parse(raw) as unknown;
    if (!validStatus(status, version)) throw new Error('checklist snapshot version mismatch or invalid inventory');
    const rows = auditBoundaryMappings(status);
    const byState = Object.fromEntries(['mapped-unverified', 'test-run-review-required',
      'manual-verifier-required', 'invalid-boundary'].map((state) =>
      [state, rows.filter((row) => row.state === state).length]));
    const yellowTotal = status.items.filter((item) => item.status === 'yellow').length;
    process.stdout.write(`${JSON.stringify({ version, yellowTotal,
      yellowLive: rows.length, yellowWithoutLive: yellowTotal - rows.length, byState, rows })}\n`);
  } catch (error) {
    process.stderr.write(`boundary proof mapping audit: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
