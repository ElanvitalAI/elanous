// ⭐⭐ 실제 파일계 fixture 로 «수집 → 분류 → 산출 → 종료 코드»를 통째로 무는 회귀(리뷰 지적 3).
//
// ⛔ 주입 분류기 테스트(`src/self-implement/run-ledger-gaps.test.ts`)는 «판정 규칙»만 답한다.
//   그 테스트는 「없다/못 읽는다」를 «내가 손으로 적어 넣은» 값으로 받으므로, ***실제 fs 가 그 값을 그렇게
//   돌려주는지***는 원리상 못 답한다(이 저장소가 반복해 밟은 「배선은 안 재고 로직만 쟀다」).
//   ⇒ 여기서는 진짜 디렉터리·진짜 sqlite manifest·진짜 권한 오류·진짜 자식 프로세스로 잰다.
import { Database } from 'bun:sqlite';
import { setDefaultTimeout, afterAll, describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PTY_LEDGER_SCOPE_PROBE_MARKER } from '../__fixtures__/pty-ledger-scope-scan-probe.js';
import { UNPRIVILEGED_DROP_HINT, resolveUnprivilegedLauncher } from '../lib/unprivileged-child.js';
import { migratePtyManifestSchema } from '../../src/pty-shell/pty-manifest.js';
import { measureRunLedgerGaps, type RunLedgerGapMeasurement, type RunLedgerGapRoot } from '../../src/self-implement/run-ledger.js';
import { ledgerIdsAt, resolvePtyLedgerScopeTargets, runPtyLedgerScope, scanPtyLedgerScope, type LedgerEvidenceSummary, type PtyLedgerScopeLegacySummary } from './pty-ledger-scope.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const repoRoot = join(import.meta.dir, '..', '..');
const temporaryRoots: string[] = [];
const lockedPaths: string[] = [];
const runningAsRoot = (process.getuid?.() ?? 1) === 0;
/**
 * ⛔⭐ 특권 러너에서는 `tmpdir()` 의 조상이 root 전용(macOS `/var/folders/**` = 0700)일 수 있어
 *   비특권 자식이 fixture 까지 «걸어 들어오지 못한다» — 그러면 EACCES 검사가 「의도한 그 자리」가 아니라
 *   조상 디렉터리에서 걸려 무엇을 쟀는지 알 수 없게 된다. ⇒ 그 경우엔 세계 통행 가능한 `/tmp` 로 못 박는다.
 */
const fixtureBase = runningAsRoot ? '/tmp' : tmpdir();

afterAll(() => {
  for (const path of lockedPaths) { try { chmodSync(path, 0o755); } catch { /* 이미 지워졌을 수 있다 */ } }
  for (const root of temporaryRoots) { try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } }
});

function makeStateRoot(name: string): string {
  const root = mkdtempSync(join(fixtureBase, `pty-ledger-scope-${name}-`));
  temporaryRoots.push(root);
  return root;
}

interface FixtureRow { id: string; kind: string; runId: string; alive?: boolean }

/** `<root>/pty/manifest.db` 를 «실물 스키마»로 만든다(마이그레이션은 생산 코드 것을 그대로 쓴다). */
function writeManifest(root: string, rows: readonly FixtureRow[]): string {
  const dbPath = join(root, 'pty', 'manifest.db');
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.run(`CREATE TABLE IF NOT EXISTS pty_manifest (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, nickname TEXT, cmd TEXT NOT NULL, workdir TEXT,
    owner_pid INTEGER NOT NULL, instance TEXT NOT NULL, started_at INTEGER NOT NULL,
    alive INTEGER NOT NULL DEFAULT 1, exit_code INTEGER, snapshot TEXT NOT NULL DEFAULT '',
    snapshot_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)`);
  migratePtyManifestSchema(db);
  rows.forEach((row, index) => {
    // ⭐ 살아 있는 행은 «이 테스트 프로세스»를 가리킨다 — `isProcessAlive` 가 실제로 참이어야 하기 때문이다.
    db.run(
      `INSERT INTO pty_manifest (id, kind, cmd, owner_pid, pty_pid, instance, run_id, started_at, alive, updated_at)
       VALUES (?, ?, 'bun', ?, ?, 'fixture', ?, ?, ?, 1)`,
      [row.id, row.kind, process.pid, process.pid, row.runId, index + 1, row.alive === false ? 0 : 1],
    );
  });
  db.close();
  return dbPath;
}

function ledgerDir(root: string): string {
  const dir = join(root, 'run-ledger');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeLedgerFile(root: string, fileName: string, body: string): void {
  writeFileSync(join(ledgerDir(root), fileName), body, 'utf8');
}

function validLedger(runId: string): string {
  return `${JSON.stringify({ timestamp: '2026-08-12T00:00:00.000Z', runId, event: 'start', data: { branch: 'fixture' } })}\n`;
}

function scopeOf(dbPath: string): { targets: { name: string; dbPath: string }[] } {
  return { targets: [{ name: 'fixture', dbPath }] };
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// 권한 오류를 «특권 러너에서도» 재는 장치 (2026-08-12 리뷰 지적 반영)
//
// ⛔⭐ 종전 판은 `it.skipIf(!canObserveEacces)` 로 root 러너에서 이 둘을 «통째로 뺐다» — root 는 DAC 를
//   우회해 `chmod 000` 을 그냥 읽기 때문이다. 그런데 컨테이너 CI 는 대개 root 로 돈다 ⇒ ***「있는데 못
//   읽는다」를 「없다」로 접지 않는다는 이 도구의 핵심 계약이, 실제로 도는 환경에서만 무검증***이었다.
//   ⇒ 이제 스킵하지 않고, 검사 자체를 «비특권 자식 프로세스»에서 돌린다.
// ⛔ 낮췄다는 «주장»을 믿지 않는다 — 자식이 자기 uid 를 산출에 실어 보내고, 부모가 0 이 아님을 확인한다.
// ────────────────────────────────────────────────────────────────────────────────────────────────

/** 자식이 낸 한 줄 JSON — `RunLedgerGapRoot` 의 `Set` 만 배열로 바뀐 형태다. */
interface ProbeRoot extends Omit<RunLedgerGapRoot, 'ledgerRunIds'> { ledgerRunIds?: string[] }
interface ProbeResult {
  uid: number;
  roots: ProbeRoot[];
  legacy: PtyLedgerScopeLegacySummary;
  ledgerEvidence: LedgerEvidenceSummary;
  measurement: RunLedgerGapMeasurement;
}

const probePath = join(repoRoot, 'scripts', '__fixtures__', 'pty-ledger-scope-scan-probe.ts');

/** ⭐ mkdtemp 는 0700 이라 root 가 만든 뿌리는 «남이 지나가지 못한다» — 자식이 걸어 들어올 길만 연다. */
function openPathForChild(root: string): void {
  for (const path of [root, join(root, 'pty')]) {
    if (existsSync(path)) chmodSync(path, 0o755);
  }
}

/**
 * 실제 파일계 fixture 를 «비특권 프로세스»에서 훑는다.
 *
 * ⛔ 낮출 방법이 아예 없는 특권 러너에서는 조용히 넘어가지 않고 «크게» 실패한다 — 이 회귀가 없어도 되는
 *   환경은 없기 때문이다(그 판단이 바로 종전 skip 의 오류였다). 대신 무엇을 깔면 되는지를 같이 말한다.
 */
function scanInUnprivilegedChild(dbPath: string): ProbeResult {
  // ⭐ 「낮췄나」만 묻지 않는다 — 그 사용자가 «런타임을 실행하고 이 체크아웃을 읽을 수 있나»까지 같이 묻는다
  //   (실측: `nobody` 로 낮추는 데는 성공해도 0700 홈의 bun 은 실행조차 못 했다).
  //   ⭐ `probePath` 읽기 하나가 조상 디렉터리 «전부»의 통행권을 함께 증명한다(따로 물을 필요가 없다).
  const launcher = resolveUnprivilegedLauncher({ requires: { executable: [process.execPath], readable: [probePath] } });
  if (!launcher) throw new Error(`pty-ledger-scope permission regression cannot run: ${UNPRIVILEGED_DROP_HINT}`);
  const argv = launcher.wrap([process.execPath, probePath, JSON.stringify(scopeOf(dbPath).targets)]);
  // ⛔ env 를 넘기지 않는다 — sudo/su 가 어차피 리셋하므로, 입력은 argv 하나로만 흐르게 «맞춰» 둔다.
  const child = Bun.spawnSync(argv, { cwd: repoRoot, stdout: 'pipe', stderr: 'pipe' });
  const stdout = new TextDecoder().decode(child.stdout);
  const line = stdout.split('\n').find((row) => row.startsWith(PTY_LEDGER_SCOPE_PROBE_MARKER));
  if (!line) {
    throw new Error(`unprivileged scan produced no probe line (via=${launcher.via} exit=${child.exitCode})\n`
      + `stdout: ${stdout.slice(0, 400)}\nstderr: ${new TextDecoder().decode(child.stderr).slice(0, 400)}`);
  }
  const parsed = JSON.parse(line.slice(PTY_LEDGER_SCOPE_PROBE_MARKER.length)) as ProbeResult;
  // ⛔⭐ 여기가 이 장치의 관문이다 — root 가 쟀다면 EACCES 는 «원리상» 안 나므로 그 결과는 무효다.
  expect(parsed.uid).not.toBe(0);
  return parsed;
}

describe('pty-ledger-scope filesystem collection', () => {
  it('collects live PTY rows and record-evidenced ledger IDs from a real state root', () => {
    const root = makeStateRoot('collect');
    const dbPath = writeManifest(root, [
      { id: 'p1', kind: 'self-implement', runId: 'run-covered' },
      { id: 'p2', kind: 'self-implement', runId: 'run-empty' },
      { id: 'p3', kind: 'agent', runId: '' },
      { id: 'p4', kind: 'agent', runId: 'run-closed', alive: false },
    ]);
    writeLedgerFile(root, 'run-covered.jsonl', validLedger('run-covered'));
    writeLedgerFile(root, 'run-empty.jsonl', '');                       // 이름만 있는 껍데기
    writeLedgerFile(root, 'run-broken.jsonl', '{ not json\n');          // 손상
    writeLedgerFile(root, 'notes.txt', 'ignored');                      // .jsonl 아님
    writeLedgerFile(root, '..jsonl', 'ignored');                        // runId 규약 밖 이름

    const scan = scanPtyLedgerScope(scopeOf(dbPath).targets);
    expect(scan.roots).toHaveLength(1);
    expect(scan.roots[0]!.manifestStatus).toBe('read');
    expect(scan.roots[0]!.ledgerStatus).toBe('read');
    // ⛔ 종료된 행(p4)은 live 가 아니다 — 수집 단계에서 이미 빠진다.
    expect(scan.roots[0]!.livePtys).toEqual([
      { kind: 'self-implement', runId: 'run-covered' },
      { kind: 'self-implement', runId: 'run-empty' },
      { kind: 'agent', runId: null },
    ]);
    // ⭐ 커버리지는 «레코드»로만 생긴다 — 빈 파일·손상 파일은 covered 가 아니다(리뷰 지적 4).
    expect([...scan.roots[0]!.ledgerRunIds ?? []]).toEqual(['run-covered']);
    expect(scan.ledgerEvidence).toEqual({ filesSeen: 3, runIdsEvidenced: 1, emptyFiles: 1, malformedFiles: 1, nonRunIdFiles: 1 } satisfies LedgerEvidenceSummary);

    const measurement = measureRunLedgerGaps(scan.roots);
    expect(measurement.livePtyCount).toBe(3);
    expect(measurement.complete).toBe(true);
    expect(measurement.gaps).toEqual([
      { kind: 'live-pty-ledger-missing', root, ptyKind: 'self-implement', runId: 'run-empty' },
      { kind: 'live-pty-run-id-missing', root, ptyKind: 'agent' },
    ]);
  });

  it('reports an absent ledger directory as missing rather than unreadable', () => {
    const root = makeStateRoot('missing');
    const dbPath = writeManifest(root, [{ id: 'p1', kind: 'self-implement', runId: 'run-orphan' }]);

    const scan = scanPtyLedgerScope(scopeOf(dbPath).targets);
    expect(scan.roots[0]!.ledgerStatus).toBe('missing');
    expect(scan.legacy.rootsWithoutLedgerDir).toBe(1);
    const measurement = measureRunLedgerGaps(scan.roots);
    // 부재는 «관측된 결과»다 — 측정은 완전하고 결손만 하나다.
    expect(measurement.complete).toBe(true);
    expect(measurement.gaps).toEqual([{ kind: 'live-pty-ledger-missing', root, ptyKind: 'self-implement', runId: 'run-orphan' }]);
  });

  it('keeps a permission-denied ledger directory unreadable and still reports missing producer IDs', () => {
    const root = makeStateRoot('eacces');
    const dbPath = writeManifest(root, [
      { id: 'p1', kind: 'agent', runId: '' },
      { id: 'p2', kind: 'agent', runId: 'run-unknown-coverage' },
    ]);
    const dir = ledgerDir(root);
    writeFileSync(join(dir, 'run-unknown-coverage.jsonl'), validLedger('run-unknown-coverage'), 'utf8');
    openPathForChild(root);        // ⭐ manifest 까지는 «읽을 수 있어야» 원장만 못 읽는 상태가 성립한다
    chmodSync(dir, 0o000);
    lockedPaths.push(dir);

    const probe = scanInUnprivilegedChild(dbPath);
    // ⛔⭐ 선행 `existsSync` 를 지운 이유가 이것이다 — 「있는데 못 읽는다」가 「없다」로 접히면 안 된다.
    expect(probe.roots[0]!.ledgerStatus).toBe('unreadable');
    expect(probe.legacy.rootsWithoutLedgerDir).toBe(0);
    expect(probe.legacy.unreadableLedgerRoots).toEqual(['fixture']);
    // ⭐ manifest 는 여전히 읽혔다 — 두 축이 «따로» 흐른다는 계약(리뷰 지적 2)을 여기서도 못 박는다.
    expect(probe.roots[0]!.manifestStatus).toBe('read');

    expect(probe.measurement.complete).toBe(false);
    expect(probe.measurement.counts['live-pty-run-id-missing']).toBe(1);
    expect(probe.measurement.counts['live-pty-ledger-missing']).toBe(0);
    expect(probe.measurement.counts['ledger-root-unreadable']).toBe(1);
  }, 60_000);

  it('marks a permission-denied manifest root unreadable instead of reading it as zero rows', () => {
    const root = makeStateRoot('manifest-eacces');
    const dbPath = writeManifest(root, [{ id: 'p1', kind: 'agent', runId: 'run-hidden' }]);
    openPathForChild(root);
    chmodSync(dbPath, 0o000);
    lockedPaths.push(dbPath);

    const probe = scanInUnprivilegedChild(dbPath);
    expect(probe.roots[0]!.manifestStatus).toBe('unreadable');
    expect(probe.legacy.unreadableManifestRoots).toEqual(['fixture']);
    expect(probe.measurement.complete).toBe(false);
    // ⛔ 「0 행」으로 접히지 않았다 — 못 읽은 뿌리는 live PTY 를 «안 본 것»이라 분모에서 빠진다.
    expect(probe.measurement.livePtyCount).toBe(0);
    expect(probe.measurement.counts['pty-manifest-root-unreadable']).toBe(1);
  }, 60_000);

  // ⛔⭐ 위 둘은 「비특권으로 낮출 수 있는가」에 의존한다 — 아래 둘은 ***uid 와 무관하게*** 같은 계약
  //   (「못 읽음 ≠ 없음」)을 실제 파일계로 문다. root 가 우회할 수 없는 실패(ENOTDIR)를 쓰기 때문에,
  //   권한 낮추기 도구가 없는 러너에서도 이 축의 커버리지가 «0 이 되지 않는다».
  it('marks a ledger path that is not a directory unreadable on any runner, root included', () => {
    const root = makeStateRoot('ledger-enotdir');
    const dbPath = writeManifest(root, [
      { id: 'p1', kind: 'agent', runId: '' },
      { id: 'p2', kind: 'agent', runId: 'run-unknown-coverage' },
    ]);
    writeFileSync(join(root, 'run-ledger'), 'not a directory', 'utf8'); // readdirSync ⇒ ENOTDIR

    const scan = scanPtyLedgerScope(scopeOf(dbPath).targets);
    expect(scan.roots[0]!.ledgerStatus).toBe('unreadable');
    expect(scan.legacy.rootsWithoutLedgerDir).toBe(0);
    expect(scan.legacy.unreadableLedgerRoots).toEqual(['fixture']);
    const measurement = measureRunLedgerGaps(scan.roots);
    expect(measurement.complete).toBe(false);
    expect(measurement.counts['ledger-root-unreadable']).toBe(1);
    expect(measurement.counts['live-pty-run-id-missing']).toBe(1);
    expect(measurement.counts['live-pty-ledger-missing']).toBe(0);
  });

  it('marks a manifest whose parent is not a directory unreadable on any runner, root included', () => {
    const root = makeStateRoot('manifest-enotdir');
    writeFileSync(join(root, 'pty'), 'not a directory', 'utf8');
    const dbPath = join(root, 'pty', 'manifest.db');                    // accessSync ⇒ ENOTDIR

    const scan = scanPtyLedgerScope(scopeOf(dbPath).targets);
    expect(scan.roots[0]!.manifestStatus).toBe('unreadable');
    expect(scan.legacy.unreadableManifestRoots).toEqual(['fixture']);
    const measurement = measureRunLedgerGaps(scan.roots);
    expect(measurement.complete).toBe(false);
    expect(measurement.livePtyCount).toBe(0);
    expect(measurement.counts['pty-manifest-root-unreadable']).toBe(1);
  });

  it('separates ENOENT from other I/O failures without touching the filesystem', () => {
    const enoent = ledgerIdsAt('/nowhere', { list: () => { throw Object.assign(new Error('no such dir'), { code: 'ENOENT' }); } });
    expect(enoent.status).toBe('missing');
    const denied = ledgerIdsAt('/nowhere', { list: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } });
    expect(denied.status).toBe('unreadable');
    const codeless = ledgerIdsAt('/nowhere', { list: () => { throw new Error('unknown failure'); } });
    expect(codeless.status).toBe('unreadable');
    // 개별 파일의 권한 실패도 뿌리 전체를 unreadable 로 «보존»한다(0 으로 접지 않는다).
    const fileDenied = ledgerIdsAt('/nowhere', {
      list: () => ['run-a.jsonl'],
      read: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); },
    });
    expect(fileDenied.status).toBe('unreadable');
    expect([...fileDenied.ids]).toEqual([]);
  });

  it('rejects a ledger record whose runId does not match its file name', () => {
    const root = makeStateRoot('mismatch');
    writeLedgerFile(root, 'run-a.jsonl', validLedger('run-b'));
    const evidence = ledgerIdsAt(join(root, 'run-ledger'));
    expect([...evidence.ids]).toEqual([]);
    expect(evidence.malformedFiles).toBe(1);
  });
});

describe('pty-ledger-scope output contract', () => {
  it('preserves the pre-existing text items and appends the gap summary', () => {
    const root = makeStateRoot('text');
    const dbPath = writeManifest(root, [{ id: 'p1', kind: 'self-implement', runId: 'run-covered' }, { id: 'p2', kind: 'agent', runId: '' }]);
    writeLedgerFile(root, 'run-covered.jsonl', validLedger('run-covered'));

    const result = runPtyLedgerScope([], scopeOf(dbPath).targets);
    const lines = result.stdout.split('\n');
    // ⛔ 2026-08-07 판의 항목·형식(리뷰 지적 6) — 사람이 읽던 표를 «빼지 않는다».
    expect(lines[0]).toBe('뿌리별 원장 파일 합계: 1 · 원장 디렉터리가 «없는» 뿌리: 0');
    expect(lines).toContain('kind\t전체\trunId\t원장');
    expect(lines).toContain('self-implement\t1\t1\t1');
    expect(lines).toContain('agent\t1\t0\t0');
    expect(lines).toContain('⛔ 「원장 없음」은 파일 부재이지 계약이 아니다. 계약은 «생산자»로 확인한다:');
    expect(result.stdout).toContain("rg -uu -n 'appendRunLedgerEntry' src/");
    // 이번 판이 «더한» 결손 블록.
    expect(lines).toContain('roots=1 livePtys=2 complete=true');
    expect(lines).toContain('live-pty-run-id-missing=1');
    expect(lines).toContain(`gap kind=live-pty-run-id-missing root=${root} ptyKind=agent`);
    expect(result.stdout).toContain('ledgerEvidence files=1 runIds=1 empty=0 malformed=0 nonRunIdNamed=0');
    expect(result.exitCode).toBe(1);
  });

  // ⛔⭐ 종전(2026-08-07) 계약과 «의도적으로 달라진» 두 자리를 회귀로 못 박는다(리뷰 지적 6).
  //   그 판은 `.jsonl` 이면 이름을 안 보고 셌고, 결손이 있어도 exit 0 이었다. 둘 다 바꿨으므로
  //   ***「보존했다」가 아니라 「여기를 바꿨다」***를 테스트가 말하게 한다.
  it('counts only runId-named ledger files in the legacy aggregate line', () => {
    const root = makeStateRoot('aggregate-delta');
    const dbPath = writeManifest(root, [{ id: 'p1', kind: 'self-implement', runId: 'run-covered' }]);
    writeLedgerFile(root, 'run-covered.jsonl', validLedger('run-covered'));
    writeLedgerFile(root, '..jsonl', 'ignored');          // runId 규약 밖 — 종전 판은 이것도 «셌다»
    writeLedgerFile(root, 'notes.txt', 'ignored');

    const result = runPtyLedgerScope([], scopeOf(dbPath).targets);
    // 종전 판이었다면 `합계: 2` 였다 — 대조 상대가 없는 이름을 분모에서 뺀 것이 이번 판의 결정이다.
    expect(result.stdout.split('\n')[0]).toBe('뿌리별 원장 파일 합계: 1 · 원장 디렉터리가 «없는» 뿌리: 0');
    expect(result.scan.ledgerEvidence.nonRunIdFiles).toBe(1);
    expect(result.exitCode).toBe(0);
  });

  it('exits 1 for a complete measurement that still found gaps (2026-08-07 판은 exit 0 이었다)', () => {
    const root = makeStateRoot('exit-delta');
    const dbPath = writeManifest(root, [{ id: 'p1', kind: 'self-implement', runId: 'run-orphan' }]);
    ledgerDir(root);

    const result = runPtyLedgerScope([], scopeOf(dbPath).targets);
    // ⭐ 종전 판의 exit 조건은 «불완전»뿐이었다 — 결손은 사람이 표를 읽어야 보였다.
    expect(result.measurement.complete).toBe(true);
    expect(result.measurement.gaps).toHaveLength(1);
    expect(result.exitCode).toBe(1);
  });

  it('rejects a malformed target override instead of silently measuring the whole fleet', () => {
    expect(() => resolvePtyLedgerScopeTargets({ ELANOUS_PTY_LEDGER_SCOPE_TARGETS: '{' })).toThrow(/not valid JSON/);
    expect(() => resolvePtyLedgerScopeTargets({ ELANOUS_PTY_LEDGER_SCOPE_TARGETS: '[{"name":"x"}]' })).toThrow(/array of/);
    expect(resolvePtyLedgerScopeTargets({ ELANOUS_PTY_LEDGER_SCOPE_TARGETS: '[{"name":"x","dbPath":"/tmp/x.db"}]' })).toEqual([{ name: 'x', dbPath: '/tmp/x.db' }]);
  });
});

describe('pty-ledger-scope entrypoint', () => {
  // ⛔⭐⭐ 진입점은 «실물로» 한 번 돈다 — in-process import 로는 「이 코드가 실행 경로에 있는가」를 못 답한다.
  /** ⛔⭐ `NODE_ENV=test` 를 «물려주지 않는다** — 그 값이 있으면 자식의 로그 sink 가 기록을 삼켜
   *   「관측 도착」 축을 원리상 못 잰다(실측: 이 한 줄이 없어 아래 도착 검사가 0건이었다 · `cli-doc-coverage` 선례). */
  function childEnv(root: string, extra: Record<string, string>): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (key !== 'NODE_ENV' && value !== undefined) env[key] = value;
    env.ELANOUS_STATE_DIR = root;                                                   // 관측 기록도 격리 우주로
    return { ...env, ...extra };
  }

  function runEntrypoint(root: string, dbPath: string): { stdout: string; exitCode: number | null } {
    const env = childEnv(root, { ELANOUS_PTY_LEDGER_SCOPE_TARGETS: JSON.stringify([{ name: 'fixture', dbPath }]) });
    const child = Bun.spawnSync(['bun', 'scripts/observability/pty-ledger-scope.ts', '--json'], { cwd: repoRoot, stdout: 'pipe', stderr: 'pipe', env });
    return { stdout: new TextDecoder().decode(child.stdout).trim(), exitCode: child.exitCode };
  }

  it('serializes the measurement as one JSON line and exits 1 when gaps exist', () => {
    const root = makeStateRoot('entry-gap');
    const dbPath = writeManifest(root, [{ id: 'p1', kind: 'self-implement', runId: 'run-orphan' }]);
    ledgerDir(root);

    const { stdout, exitCode } = runEntrypoint(root, dbPath);
    expect(exitCode).toBe(1);
    expect(stdout.split('\n')).toHaveLength(1);
    const parsed = JSON.parse(stdout) as RunLedgerGapMeasurement & { ledgerEvidence: LedgerEvidenceSummary };
    expect(parsed.scope).toBe('self-implement-run-ledger-gaps');
    expect(parsed.complete).toBe(true);
    expect(parsed.rootsMeasured).toBe(1);
    expect(parsed.livePtyCount).toBe(1);
    expect(parsed.counts['live-pty-ledger-missing']).toBe(1);
    expect(parsed.gaps).toEqual([{ kind: 'live-pty-ledger-missing', root, ptyKind: 'self-implement', runId: 'run-orphan' }]);
    expect(parsed.ledgerEvidence.runIdsEvidenced).toBe(0);
    expect(parsed.note).toContain('checkpoint');
  });

  it('exits 0 only when the measurement is complete and every live PTY has an evidenced ledger', () => {
    const root = makeStateRoot('entry-clean');
    const dbPath = writeManifest(root, [{ id: 'p1', kind: 'self-implement', runId: 'run-covered' }]);
    writeLedgerFile(root, 'run-covered.jsonl', validLedger('run-covered'));

    const { stdout, exitCode } = runEntrypoint(root, dbPath);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout) as RunLedgerGapMeasurement;
    expect(parsed.complete).toBe(true);
    expect(parsed.gaps).toEqual([]);
    expect(parsed.counts).toEqual({ 'live-pty-run-id-missing': 0, 'live-pty-ledger-missing': 0, 'ledger-root-unreadable': 0, 'pty-manifest-root-unreadable': 0 });
  });

  // ⛔⭐ 「관측을 남겼다」와 「관측이 도착했다」는 다른 축이다 — sink 를 안 걸면 `debug.log` 는 logs.db 에 «안 닿는다»
  //   (2026-08-12 실측: sink 배선 전 `elanous logs --category self-implement.run-ledger-gaps` 가 0건).
  it('records the measurement in the log store of the universe it ran in', () => {
    const root = makeStateRoot('entry-observed');
    const dbPath = writeManifest(root, [{ id: 'p1', kind: 'self-implement', runId: 'run-covered' }]);
    writeLedgerFile(root, 'run-covered.jsonl', validLedger('run-covered'));
    expect(runEntrypoint(root, dbPath).exitCode).toBe(0);

    // ⛔ logs.db 를 직접 열지 않는다(저장소 규율) — 1급 CLI 로만 읽는다. 도착은 «즉시»가 아니라 폴링한다.
    type LogRow = { event?: string; data?: { roots?: number; complete?: boolean } };
    const measured = (): LogRow | undefined => {
      const logs = Bun.spawnSync(
        ['bun', 'bin/elanous.mjs', 'logs', '--category', 'self-implement.run-ledger-gaps', '--limit', '20', '--json', '--json-data'],
        { cwd: repoRoot, stdout: 'pipe', stderr: 'pipe', env: childEnv(root, {}) },
      );
      if (logs.exitCode !== 0) return undefined;
      return new TextDecoder().decode(logs.stdout).trim().split('\n')
        .map((line) => { try { return JSON.parse(line) as LogRow; } catch { return undefined; } })
        .find((row) => row?.event === 'measured');
    };
    let row: LogRow | undefined;
    for (let attempt = 0; attempt < 6 && !row; attempt++) {
      row = measured();
      if (!row) Bun.sleepSync(1000);
    }
    expect(row?.data?.roots).toBe(1);
    expect(row?.data?.complete).toBe(true);
  }, 60_000);
});
