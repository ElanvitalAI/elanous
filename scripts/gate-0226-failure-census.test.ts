import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTsv, repairCardFor } from './gate-0226-failure-census';

const ROOT = join(import.meta.dir, '..');
const ENTRY = join(ROOT, 'scripts/gate-0226-failure-census.ts');
const TSV_REL = 'docs/reports/gate-0226-failure-census.tsv';
const REPORT_REL = 'docs/reports/REPORT-gate-0226-failure-census.md';
const INTAKE = 'provider-intake';

const scratch = mkdtempSync(join(tmpdir(), 'gate-0226-census-'));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

type Ran = { rc: number; stdout: string; stderr: string };

function runEntry(args: string[]): Ran {
  const proc = Bun.spawnSync(['bun', 'run', ENTRY, ...args], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
  return { rc: proc.exitCode ?? -1, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

type AuditJson = {
  ok: boolean;
  problems: string[];
  counts: {
    rows: number;
    intake: number;
    remaining: number;
    status: Record<string, number>;
    group: Record<string, number>;
    repair: Record<string, number>;
  };
  intakeIds: string[];
  remainingIds: string[];
  acpLogEvents: number;
  ledger: { path: string; status: string; ids: number };
};

function auditJson(args: string[] = []): { ran: Ran; audit: AuditJson } {
  const ran = runEntry(['--json', '--accepted', 'none', ...args]);
  return { ran, audit: JSON.parse(ran.stdout) as AuditJson };
}

type Stage = { dir: string; tsv: string; report: string };

function stage(name: string): Stage {
  const dir = mkdtempSync(join(scratch, `${name}-`));
  const tsv = join(dir, 'census.tsv');
  const report = join(dir, 'census.md');
  writeFileSync(tsv, readFileSync(join(ROOT, TSV_REL), 'utf8'));
  writeFileSync(report, readFileSync(join(ROOT, REPORT_REL), 'utf8'));
  return { dir, tsv, report };
}

function runStaged(staged: Stage, extra: string[] = []): Ran {
  return runEntry(['--tsv', staged.tsv, '--report', staged.report, '--accepted', 'none', ...extra]);
}

function rewrite(path: string, edit: (text: string) => string): void {
  writeFileSync(path, edit(readFileSync(path, 'utf8')));
}

describe('gate-0226 실패 ID 전수표 검증 진입점', () => {
  test('생산 진입점이 커밋된 전수표·보고서에서 rc 0 · PASS 를 낸다', () => {
    const { rc, stdout } = runEntry([]);
    expect(stdout).toContain('rows: 96 (provider-intake 6 excluded → 90)');
    expect(stdout).toContain('no-acp: 0');
    expect(stdout.trimEnd().endsWith('census: PASS')).toBe(true);
    expect(rc).toBe(0);
  });

  test('accepted 실패 ID 96건과 intake 6건을 뺀 90건이 중복 없이 보존된다', () => {
    const { ran, audit } = auditJson();
    expect(ran.rc).toBe(0);
    expect(audit.counts).toMatchObject({ rows: 96, intake: 6, remaining: 90 });
    expect(audit.intakeIds).toHaveLength(6);
    expect(audit.remainingIds).toHaveLength(90);
    const all = [...audit.intakeIds, ...audit.remainingIds];
    expect(new Set(all).size).toBe(96);
    expect(audit.remainingIds.some((id) => audit.intakeIds.includes(id))).toBe(false);
    expect(audit.counts.group[INTAKE]).toBe(6);
    expect(audit.counts.status).toMatchObject({ 'hypothesis-unverified': 68, 'untriaged': 21, 'paired-reproduced-root-cause-candidate': 7 });
  });

  test('`Error: no ACP` 로그 사건은 실패 ID로 세지 않는다', () => {
    const { audit } = auditJson();
    expect(audit.acpLogEvents).toBe(0);
    const tsv = readFileSync(join(ROOT, TSV_REL), 'utf8');
    expect(tsv.includes('Error: no ACP')).toBe(false);
    expect(readFileSync(join(ROOT, REPORT_REL), 'utf8')).toContain('겹침은 0건');
  });

  test('행을 하나 빼면 90건 보존 판정이 깨진다', () => {
    const staged = stage('drop-row');
    rewrite(staged.tsv, (text) => text.split('\n').filter((line) => !line.startsWith('44\t')).join('\n'));
    const { rc, stdout } = runStaged(staged);
    expect(stdout).toContain('FAIL row-count: 기대 96행 / 실측 95행');
    expect(stdout).toContain('FAIL intake-split: 제외 후 나머지 기대 90건 / 실측 89건');
    expect(rc).toBe(1);
  });

  test('`Error: no ACP` 사건을 실패 ID로 더하면 실패한다', () => {
    const staged = stage('acp-row');
    const extra = [
      '97',
      'test/acp-boot.test.ts > noop > noop',
      'test/acp-boot.test.ts',
      'remaining-review',
      '후보: 로그 사건',
      '가설: 사건',
      '후보: 재현',
      'Error: no ACP (shard log 12:03)',
      '후보: 없음',
      'GATE-0226-REMAINING-TC',
      'TC',
      '시험 삭제 제안 없음',
      'untriaged',
    ].join('\t');
    rewrite(staged.tsv, (text) => `${text.trimEnd()}\n${extra}\n`);
    const { rc, stdout } = runStaged(staged);
    expect(stdout).toContain('FAIL no-acp-exclusion:');
    expect(rc).toBe(1);
  });

  test('근거 칸이 비면 실패한다', () => {
    const staged = stage('blank-cell');
    rewrite(staged.tsv, (text) => text.replace('\t후보: 환경: Android SDK를 Pod에 설치/ANDROID_HOME 설정\t', '\t\t'));
    const { rc, stdout } = runStaged(staged);
    expect(stdout).toContain('FAIL evidence-completeness: 빈 칸 1개 (1.prescription)');
    expect(rc).toBe(1);
  });

  test('보고서 색인과 TSV가 어긋나면 실패한다', () => {
    const staged = stage('index-drift');
    rewrite(staged.report, (text) => text.split('\n').filter((line) => !line.startsWith('| 96 | `test/plugin-missions-runtime.test.ts > [error]` |')).join('\n'));
    const { rc, stdout } = runStaged(staged);
    expect(stdout).toContain('FAIL report-index-parity: 보고서 색인 95행 / TSV 96행');
    expect(rc).toBe(1);
  });

  test('보고서 선언 카운트가 실측과 다르면 실패한다', () => {
    const staged = stage('count-drift');
    rewrite(staged.report, (text) => text.replace('+ 나머지 90건', '+ 나머지 89건'));
    const { rc, stdout } = runStaged(staged);
    expect(stdout).toContain('FAIL report-counts: 보고서 선언 96/6/89 / 실측 96/6/90');
    expect(rc).toBe(1);
  });

  test('수리 칸 열이 묶음·주인에서 유도되고 intake 칸 6 + 나머지 90으로 갈린다', () => {
    const { ran, audit } = auditJson();
    expect(ran.rc).toBe(0);
    expect(audit.counts.repair['GATE-0226-PROVIDER-INTAKE6']).toBe(6);
    const rest = Object.entries(audit.counts.repair).filter(([card]) => card !== 'GATE-0226-PROVIDER-INTAKE6');
    expect(rest.reduce((sum, [, count]) => sum + count, 0)).toBe(90);

    const rows = parseTsv(readFileSync(join(ROOT, TSV_REL), 'utf8'));
    const header = rows[0]!;
    const cardAt = header.indexOf('repair_card');
    const groupAt = header.indexOf('group');
    const ownerAt = header.indexOf('owner');
    expect(cardAt).toBeGreaterThan(0);
    const body = rows.slice(1);
    expect(body).toHaveLength(96);
    for (const row of body) {
      const card = row[cardAt]!;
      expect(card).toMatch(/^GATE-0226-[A-Z0-9]+(-[A-Z0-9]+)*$/);
      expect(card).toBe(repairCardFor(row[groupAt]!, row[ownerAt]!));
    }
  });

  test('어긋난 수리 칸은 판정을 깨고 `--write-repair-card` 가 되계산한다', () => {
    const staged = stage('repair-card-write');
    rewrite(staged.tsv, (text) => text.replace(/\tGATE-0226-REMAINING-TC$/m, '\tGATE-0226-WRONG'));
    const broken = runStaged(staged);
    expect(broken.stdout).toContain('FAIL repair-card:');
    expect(broken.stdout).toContain('FAIL report-repair-parity:');
    expect(broken.rc).toBe(1);

    const fixed = runStaged(staged, ['--write-repair-card']);
    expect(fixed.stdout).toContain('repair-card: 96행 재계산');
    expect(fixed.rc).toBe(0);

    const after = readFileSync(staged.tsv, 'utf8');
    runStaged(staged, ['--write-repair-card']);
    expect(readFileSync(staged.tsv, 'utf8')).toBe(after);
  });

  test('accepted 원장을 주면 ID 집합 일치까지 잰다', () => {
    const { audit } = auditJson();
    const ids = [...audit.intakeIds, ...audit.remainingIds];
    const ledger = join(scratch, 'accepted-0226.json');
    writeFileSync(ledger, JSON.stringify(ids.map((id, at) => ({ id, status: 'accepted', rank: at + 1 }))));

    const compared = runEntry(['--accepted', ledger]);
    expect(compared.stdout).toContain('accepted-ledger: compared');
    expect(compared.rc).toBe(0);

    writeFileSync(ledger, JSON.stringify(ids.slice(1).map((id) => ({ id }))));
    const drifted = runEntry(['--accepted', ledger]);
    expect(drifted.stdout).toContain('FAIL accepted-ledger: 원장 95건 / TSV 96건');
    expect(drifted.rc).toBe(1);
  });
});
