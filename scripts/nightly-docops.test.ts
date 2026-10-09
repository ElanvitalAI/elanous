import { setDefaultTimeout, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDocRotStage, buildStalenessStage, recordDocRotStage, formatNightlyDocOpsCompletion, recordSemanticProposal, stalenessEventName, type SemanticQueueDeps } from './nightly-docops.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const key = 'stable-semantic-key';
const proposal = { idempotencyKey: key } as ReturnType<typeof import('../src/autopilot/discovery/semantic-supersede.js').buildSemanticSupersedeProposal>;

function queue(files: Record<string, string>, logs: string[] = []): SemanticQueueDeps {
  return {
    readDir: () => Object.keys(files),
    readFile: (path) => {
      const content = files[path.split('/').pop() ?? ''];
      if (content === undefined) throw new Error('missing file');
      return content;
    },
    exists: (path) => files[path.split('/').pop() ?? ''] !== undefined,
    writeExclusive: (path, content) => {
      const filename = path.split('/').pop() ?? '';
      if (files[filename] !== undefined) {
        throw Object.assign(new Error('already exists'), { code: 'EEXIST' });
      }
      files[filename] = content;
    },
    log: (message) => logs.push(message),
  };
}

describe('nightly-docops module import', () => {
  it('does not create the checkpoint directory outside the CLI main path', async () => {
    const home = mkdtempSync(join(tmpdir(), 'nightly-docops-import-'));
    const checkpointDir = join(home, '.elanous', 'doc-curation', 'checkpoints');
    const previousHome = process.env.HOME;
    try {
      const child = Bun.spawn({
        cmd: [process.execPath, '-e', "import('./scripts/nightly-docops.js')"],
        cwd: join(import.meta.dir, '..'),
        env: { ...process.env, HOME: home },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(await child.exited).toBe(0);
      expect(existsSync(checkpointDir)).toBe(false);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('formatNightlyDocOpsCompletion', () => {
  const base = { processed: 2, candidates: 3, proposals: 4, suppressed: 5, errors: 0, retries: 0, durationMs: 6 };

  it('실제 entry 산출에 검사 수와 네 staleness 축 및 목록 절단을 함께 낸다', () => {
    const line = formatNightlyDocOpsCompletion({
      ...base,
      staleness: {
        status: 'measured', checked: 3169,
        byAxis: { removedIdentifiers: 46, brokenLinks: 628, supersededMarked: 41, staleScoreOverThreshold: 107 },
        removedIdentifierDocuments: ['docs/A.md'], removedIdentifierDocumentsTruncated: true,
      },
    });
    expect(line).toContain('늙음 검사 3169');
    expect(line).toContain('사라진 식별자 46');
    expect(line).toContain('깨진 링크 628');
    expect(line).toContain('superseded 41');
    expect(line).toContain('staleScore 107');
    expect(line).toContain('문서목록 1+');
  });

  it('실패를 0으로 위장하지 않고 사람이 읽는 entry 산출에 남긴다', () => {
    const line = formatNightlyDocOpsCompletion({ ...base, staleness: { status: 'failed', error: 'shallow clone' } });
    expect(line).toContain('늙음 측정 실패(shallow clone)');
    expect(line).not.toContain('늙음 검사 0');
  });
});

describe('nightly doc-rot stage', () => {
  const base = { processed: 2, candidates: 3, proposals: 4, suppressed: 5, errors: 0, retries: 0, durationMs: 6 };

  it('주입 스캔을 호출하고 낡은 파일과 못 잰 명령을 따로 남긴다', () => {
    const calls: unknown[] = [];
    const stage = buildDocRotStage('/repo', {
      files: () => ['/repo/docs/manual/a.md', '/repo/docs/manual/b.md'],
      scan: ((input: unknown) => {
        calls.push(input);
        return {
          totals: { files: 2, staleFiles: 1, missingPaths: 1, badCommands: 1, unmeasured: 2, passthrough: 0, globalFlag: 0, intentional: 0 },
          files: [
            { file: 'docs/manual/a.md', missingPaths: [{ line: 1, path: 'src/gone.ts' }], commands: [
              { kind: 'unknown-command', detail: 'elanous gone', ref: { file: 'docs/manual/a.md', line: 2, cmd: 'gone', subcommands: [], flags: [] } },
              { kind: 'unmeasured', detail: 'help failed', ref: { file: 'docs/manual/a.md', line: 3, cmd: 'help', subcommands: [], flags: [] } },
            ] },
            { file: 'docs/manual/b.md', missingPaths: [], commands: [
              { kind: 'unmeasured', detail: 'help failed', ref: { file: 'docs/manual/b.md', line: 1, cmd: 'help', subcommands: [], flags: [] } },
            ] },
          ],
        };
      }) as never,
    });
    const result = stage();
    expect(calls).toEqual([{ repoRoot: '/repo', files: ['/repo/docs/manual/a.md', '/repo/docs/manual/b.md'] }]);
    expect(result.status).toBe('measured');
    if (result.status !== 'measured') throw new Error('expected measured');
    expect(result.staleFiles).toHaveLength(1);
    expect(result.staleFiles[0]?.file).toBe('docs/manual/a.md');
    expect(result.staleFiles[0]?.badCommands.map(({ kind }) => kind)).toEqual(['unknown-command']);
    const line = formatNightlyDocOpsCompletion(base, result);
    expect(line).toContain('doc-rot 낡은 파일 1');
    expect(line).toContain('없는 경로 1·깨진 명령 1·못 잰 명령 2');
  });

  it('기본 파일 열거와 실물 스캔을 같은 repoRoot 에서 실행한다', () => {
    const root = mkdtempSync(join(tmpdir(), 'nightly-doc-rot-'));
    try {
      mkdirSync(join(root, 'docs', 'manual'), { recursive: true });
      writeFileSync(join(root, 'docs', 'manual', 'a.md'), 'See `src/not-present.ts`.');
      const result = buildDocRotStage(root)();
      expect(result.status).toBe('measured');
      if (result.status !== 'measured') throw new Error('expected measured');
      expect(result.totals.files).toBe(1);
      expect(result.staleFiles).toEqual([{
        file: 'docs/manual/a.md', missingPaths: [{ line: 1, path: 'src/not-present.ts' }], badCommands: [],
      }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('scan 또는 파일 열거가 던져도 실패 결과로 접고 완료 줄에 남긴다', () => {
    const stage = buildDocRotStage('/repo', {
      files: () => ['docs/manual/a.md'],
      scan: (() => { throw new Error('scanner unavailable'); }) as never,
    });
    const result = stage();
    expect(result).toEqual({ status: 'failed', error: 'scanner unavailable' });
    expect(formatNightlyDocOpsCompletion(base, result)).toContain('doc-rot 측정 실패(scanner unavailable)');
    expect(buildDocRotStage('/repo', { files: () => { throw new Error('manual directory unavailable'); } })())
      .toEqual({ status: 'failed', error: 'manual directory unavailable' });
  });
  it('결과를 날짜별 보고서와 docs.rot 관측으로 남기고 쓰기 실패도 던지지 않는다', () => {
    const measured = { status: 'measured' as const, totals: { files: 2, staleFiles: 1, missingPaths: 1, badCommands: 0, unmeasured: 2, passthrough: 0, globalFlag: 0, intentional: 0 }, staleFiles: [] };
    const writes: Array<[string, string]> = [];
    const logs: Array<[string, string, Record<string, unknown>]> = [];
    const ok = recordDocRotStage(measured, {
      outDir: '/out', nowDate: '2026-10-08', mkdir: () => {},
      write: (path, body) => { writes.push([path, body]); },
      log: (c, e, d) => { logs.push([c, e, d]); },
    });
    expect(ok).toEqual({ reportPath: '/out/doc-rot-2026-10-08.json', writeError: null });
    expect(writes[0]?.[0]).toBe('/out/doc-rot-2026-10-08.json');
    expect(JSON.parse(writes[0]?.[1] ?? '{}').status).toBe('measured');
    expect(logs[0]?.[0]).toBe('docs.rot');
    expect(logs[0]?.[1]).toBe('nightly-scanned');
    expect(logs[0]?.[2]).toMatchObject({ staleFiles: 1, unmeasured: 2, error: null, writeError: null });

    logs.length = 0;
    const failed = recordDocRotStage({ status: 'failed', error: 'scanner unavailable' }, {
      outDir: '/out', nowDate: '2026-10-08', mkdir: () => {},
      write: () => { throw new Error('disk full'); },
      log: (c, e, d) => { logs.push([c, e, d]); },
    });
    expect(failed).toEqual({ reportPath: null, writeError: 'disk full' });
    expect(logs[0]?.[1]).toBe('nightly-failed');
    expect(logs[0]?.[2]).toMatchObject({ error: 'scanner unavailable', writeError: 'disk full', reportPath: null });
    expect(() => recordDocRotStage(measured, { outDir: '/out', nowDate: 'd', mkdir: () => {}, write: () => {}, log: () => { throw new Error('log down'); } })).not.toThrow();
  });
});

describe('nightly-docops — 실물 배선', () => {
  // ⛔⭐⭐⭐ **소스 «문자열»을 보지 않는다**(리뷰 must-fix · Goodhart 제거).
  //   초판은 진입점 텍스트에 `assessDocsStaleness` 가 «있나»만 봤다 — ***주석에 있어도, 안 불려도 통과***한다.
  //   ⇒ 배선을 `buildStalenessStage` 로 뽑아 «실행»으로 문다.
  // ⚠️ 그리고 사이클 «전체»를 spawn 하지 않는다 — 그 시도가 420초·180초 두 번 다 타임아웃했다.
  //   같은 진입점을 셸에서 격리해 돌리면 «9.4초»다(실측: 늙음 검사 3190·사라진 식별자 48·…·9394ms).
  //   ⇒ 「기능이 느리다」가 아니라 「bun test 안의 자식이 걸린다」이고, 그 축은 이 PR 의 계약이 아니다.

  it('단계가 assessDocsStaleness 를 defaultStalenessRevisions 의 결과로 «실제로» 부른다', () => {
    const seen: { root?: string; revs?: unknown } = {};
    const stage = buildStalenessStage('/repo', {
      revisions: ((root: string) => { seen.root = root; return { recent: 'R30', old: 'R90' }; }) as never,
      assess: ((root: string, revs: unknown) => {
        seen.revs = revs;
        return {
          checked: 7,
          withAnySignal: 2,
          byAxis: { removedIdentifiers: 1, brokenLinks: 1, supersededMarked: 0, staleScoreOverThreshold: 0 },
          branches: {},
          documents: [
            { path: 'docs/a.md', removedIdentifiers: ['gone'], brokenLinkCount: 0, superseded: false, staleScore: 0, supersededBy: null, hasAnySignal: true },
            { path: 'docs/b.md', removedIdentifiers: [], brokenLinkCount: 3, superseded: false, staleScore: 0, supersededBy: null, hasAnySignal: true },
          ],
        };
      }) as never,
    });
    const out = stage();
    expect(seen.root).toBe('/repo');                       // revisions 가 «그 루트»로 불렸다
    expect(seen.revs).toEqual({ recent: 'R30', old: 'R90' }); // 그 결과가 assess 로 «흘러갔다»
    expect(out.checked).toBe(7);
    // ⭐ 고유 축 문서만 목록에 남는다 — 깨진 링크만 있는 b.md 는 «안» 들어간다
    expect(out.removedIdentifierDocuments).toEqual(['docs/a.md']);
  });

  it('⛔ 단계가 목록을 «미리 자르지 않는다» — 자르면 runner 가 절단을 «알릴 수» 없다', () => {
    // 📏 실측 회귀(2026-08-12): 여기서 slice(0,20) 을 하자 runner 의 절단 비교가 항상 거짓이 되어
    //   목록 20개 · 실제 48편인데 `truncated: false` 가 나왔다. 「잘린 것을 안 잘린 것처럼」의 실물.
    const many = Array.from({ length: 5 }, (_, i) => ({
      path: `docs/${i}.md`, removedIdentifiers: ['x'], brokenLinkCount: 0, superseded: false, staleScore: 0, supersededBy: null, hasAnySignal: true,
    }));
    const stage = buildStalenessStage('/repo', {
      revisions: (() => ({ recent: 'a', old: 'b' })) as never,
      assess: (() => ({ checked: 5, withAnySignal: 5, byAxis: { removedIdentifiers: 5, brokenLinks: 0, supersededMarked: 0, staleScoreOverThreshold: 0 }, branches: {}, documents: many })) as never,
    });
    expect(stage().removedIdentifierDocuments).toHaveLength(5);   // ⭐ 전량이 넘어간다
  });

  it('⭐ 「단계를 안 넘김」을 「측정됨」으로 접지 않는다 — 셋을 가른다', () => {
    expect(stalenessEventName(undefined)).toBe('staleness-skipped');
    expect(stalenessEventName({ status: 'failed' })).toBe('staleness-failed');
    expect(stalenessEventName({ status: 'measured' })).toBe('staleness-measured');
  });
});

describe('recordSemanticProposal', () => {
  it('다른 날짜의 동일 키를 억제하고 키와 기존 파일명을 로그에 남긴다', () => {
    const files: Record<string, string> = { 'PROPOSAL-semantic-2026-08-11-stable-s.json': JSON.stringify(proposal) };
    const logs: string[] = [];
    const result = recordSemanticProposal(proposal, '/queue/PROPOSAL-semantic-2026-08-12-stable-s.json', '/queue', queue(files, logs));
    expect(result).toEqual({ suppressed: true, existingFile: 'PROPOSAL-semantic-2026-08-11-stable-s.json', queueReadFailed: false });
    expect(files['PROPOSAL-semantic-2026-08-12-stable-s.json']).toBeUndefined();
    expect(logs[0]).toContain(`key=${key}`);
    expect(logs[0]).toContain('existing=PROPOSAL-semantic-2026-08-11-stable-s.json');
  });

  it('같은 날 두 번째 실행도 기존 파일로 억제한다', () => {
    const files: Record<string, string> = {};
    const deps = queue(files);
    const path = '/queue/PROPOSAL-semantic-2026-08-12-stable-s.json';
    expect(recordSemanticProposal(proposal, path, '/queue', deps).suppressed).toBe(false);
    expect(recordSemanticProposal(proposal, path, '/queue', deps).suppressed).toBe(true);
    expect(Object.keys(files)).toEqual(['PROPOSAL-semantic-2026-08-12-stable-s.json']);
  });

  it('다른 키의 기존 제안은 새 날짜 형식을 보존해 정상 기록한다', () => {
    const files: Record<string, string> = { 'PROPOSAL-semantic-2026-08-11-other-ke.json': JSON.stringify({ idempotencyKey: 'other-key' }) };
    const logs: string[] = [];
    const result = recordSemanticProposal(proposal, '/queue/PROPOSAL-semantic-2026-08-12-stable-s.json', '/queue', queue(files, logs));
    expect(result).toEqual({ suppressed: false, queueReadFailed: false });
    expect(files['PROPOSAL-semantic-2026-08-12-stable-s.json']).toContain(key);
    expect(logs[0]).toContain(`큐 기록 key=${key}`);
  });

  it('큐를 읽지 못해도 대상이 없으면 fail-soft로 배타 기록하고 실패 로그를 남긴다', () => {
    const files: Record<string, string> = {};
    const logs: string[] = [];
    const deps = queue(files, logs);
    deps.readDir = () => { throw new Error('permission denied'); };
    const result = recordSemanticProposal(proposal, '/queue/PROPOSAL-semantic-2026-08-12-stable-s.json', '/queue', deps);
    expect(result).toEqual({ suppressed: false, queueReadFailed: true });
    expect(files['PROPOSAL-semantic-2026-08-12-stable-s.json']).toContain(key);
    expect(logs[0]).toContain(`큐 읽기 실패 key=${key}`);
    expect(logs[1]).toContain(`큐 기록 key=${key}`);
  });

  it('큐 열거 실패에서도 기존 당일 대상은 변경하지 않고 억제한다', () => {
    const filename = 'PROPOSAL-semantic-2026-08-12-stable-s.json';
    const files: Record<string, string> = { [filename]: 'preserve-this-content' };
    const logs: string[] = [];
    const deps = queue(files, logs);
    deps.readDir = () => { throw new Error('permission denied'); };
    const result = recordSemanticProposal(proposal, `/queue/${filename}`, '/queue', deps);
    expect(result).toEqual({ suppressed: true, existingFile: filename, queueReadFailed: true });
    expect(files[filename]).toBe('preserve-this-content');
    expect(logs.join('\n')).toContain(`기존 대상 억제 key=${key} existing=${filename}`);
  });

  it('손상된 후보만 있으면 미지로 세고 기록한다', () => {
    const target = 'PROPOSAL-semantic-2026-08-12-stable-s.json';
    const malformed = 'PROPOSAL-semantic-2026-08-11-unreadable.json';
    const files: Record<string, string> = { [malformed]: '{bad json' };
    const logs: string[] = [];
    const result = recordSemanticProposal(proposal, `/queue/${target}`, '/queue', queue(files, logs));
    expect(result).toEqual({ suppressed: false, queueReadFailed: true });
    expect(files[target]).toContain(key);
    expect(logs.join('\n')).toContain(`큐 후보 1개 읽기 실패에도 기록 key=${key}`);
  });

  it('읽을 수 없는 후보 뒤의 실제 일치를 찾아 억제한다', () => {
    const unreadable = 'PROPOSAL-semantic-2026-08-11-unreadable.json';
    const matching = 'PROPOSAL-semantic-2026-08-11-matching.json';
    const files: Record<string, string> = { [unreadable]: 'unavailable', [matching]: JSON.stringify(proposal) };
    const logs: string[] = [];
    const deps = queue(files, logs);
    deps.readFile = (path) => {
      const filename = path.split('/').pop() ?? '';
      if (filename === unreadable) throw new Error('permission denied');
      return files[filename] ?? '';
    };
    const result = recordSemanticProposal(proposal, '/queue/PROPOSAL-semantic-2026-08-12-stable-s.json', '/queue', deps);
    expect(result).toEqual({ suppressed: true, existingFile: matching, queueReadFailed: true });
    expect(files['PROPOSAL-semantic-2026-08-12-stable-s.json']).toBeUndefined();
    expect(logs.join('\n')).toContain(`큐 후보 읽기 실패 key=${key} candidate=${unreadable}`);
    expect(logs.join('\n')).toContain(`멱등 억제 key=${key} existing=${matching}`);
  });

  it('배타적 생성 충돌은 기존 파일을 덮어쓰지 않고 억제한다', () => {
    const target = 'PROPOSAL-semantic-2026-08-12-stable-s.json';
    const files: Record<string, string> = {};
    const logs: string[] = [];
    const deps = queue(files, logs);
    deps.writeExclusive = () => {
      files[target] = 'racing-writer-content';
      throw Object.assign(new Error('already exists'), { code: 'EEXIST' });
    };
    const result = recordSemanticProposal(proposal, `/queue/${target}`, '/queue', deps);
    expect(result).toEqual({ suppressed: true, existingFile: target, queueReadFailed: false });
    expect(files[target]).toBe('racing-writer-content');
    expect(logs[0]).toContain(`배타 기록 충돌·기존 대상 억제 key=${key} existing=${target}`);
  });
});
