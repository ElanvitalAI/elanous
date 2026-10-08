import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findAskPathCandidates, stripAskWrapper } from './ask-path-candidates.js';

test('identifier and backtick words find ranked code candidates with literal rg arguments', () => {
  const calls: string[][] = [];
  const result = findAskPathCandidates('Repair `scopeBoundaryCandidates` and ask-launch-flow retry.', {
    cwd: '/repo',
    run: (_command, args) => {
      calls.push([...args]);
      if (args[5] === 'scopeBoundaryCandidates') return 'src/self-implement/goal-author.ts\nsrc/self-dev/ask-launch-flow.ts\n';
      if (args[5] === 'ask-launch-flow') return 'src/self-dev/ask-launch-flow.ts\n';
      return '';
    },
  });
  expect(result.paths).toEqual(['src/self-dev/ask-launch-flow.ts', 'src/self-implement/goal-author.ts']);
  expect(result.tokens).toContain('scopeBoundaryCandidates');
  expect(calls).toContainEqual(['-l', '-F', '--glob', '!*.test.ts', '--', 'scopeBoundaryCandidates', 'src', 'scripts']);
});

test('candidate search retains five ranked paths for observation before the launch flow selects one', () => {
  const result = findAskPathCandidates('prioritySignal', {
    cwd: '/repo',
    run: () => ['src/z.ts', 'src/e.ts', 'src/d.ts', 'src/c.ts', 'src/b.ts', 'src/a.ts'].join('\n'),
  });
  expect(result.paths).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts']);
});

test('common words yield zero candidates without searching', () => {
  let calls = 0;
  expect(findAskPathCandidates('the and test src', { cwd: '/repo', run: () => { calls++; return ''; } }))
    .toEqual({ tokens: [], paths: [] });
  expect(calls).toBe(0);
});

test('rg failure is an error, not a measured zero', () => {
  const result = findAskPathCandidates('scopeBoundaryCandidates', {
    cwd: '/repo', run: () => { throw Object.assign(new Error('rg unavailable'), { status: 2 }); },
  });
  expect(result).toEqual({ tokens: ['scopeBoundaryCandidates'], paths: [], error: 'rg unavailable' });
});

test('existing file fragments are candidates and ties sort by path, capped at five', () => {
  const root = mkdtempSync(join(tmpdir(), 'ask-path-candidate-'));
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'actual.ts'), 'export {};');
    const result = findAskPathCandidates('`src/actual.ts`', { cwd: root, run: () => '' });
    expect(result.paths).toEqual(['src/actual.ts']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// AUTO-TARGET (10-08): shapes of the four path-less dispatcher asks whose Pod runs were grounded on
// harness files. Tokens measured from `ask-auto-target-candidates` (Pod origin, 10-07 15:00–15:26 UTC).
const POD_SHARD_FOOTER = '\n\n## Shard identity\n{"orchestrationId":"e541d958-3e23-4fa4-9e5b-8d29e3f44bcf","shardId":"task-a69724828b82","totalShards":1,"position":1,"summary":"shard summary","siblings":[]}'
  + '\n\n## Working-memory handoff\nA downstream shard depends on this work. Before your final response, emit the following marker and one JSON object so it can reuse your findings.\n[WORKING-MEMORY]\n{"reusables":[],"decisions":[],"summary":"What this shard established for downstream work."}';

function dispatcherAsk(id: string, title: string, evidence: string): string {
  return `보존 계약: 다른 명령·화면의 기본 동작과 원장 형식은 지금과 같다 · 칸 범위 밖은 건드리지 않는다.
[UX · 0.2.20 칸 ${id} · TASK-AGENT(OP 디스패처)] ${title}
칸 근거 끝(남은 것): ${evidence}
판정: 칸 문면의 판정선을 시험(필요하면 실물 1회)으로 증명 · 기존 시험 통과 · 한 런에 안 끝나면 첫 조각만 하고 «남은 것»을 PR 본문에.${POD_SHARD_FOOTER}`;
}

const REAL_PATHLESS_ASKS = {
  'V1-PCH-DEVICES': dispatcherAsk('V1-PCH-DEVICES', 'PCH 실기 장면표 — 폴드8 ⊕ 듀오에서 PCH 칸 장면을 손으로 밟아 표 한 장(사람 칸 · V1-PCH 회귀 묶음에서 뗌)', ''),
  'STEWARD-FLOW': dispatcherAsk('STEWARD-FLOW', '스튜어드 흐름 재설계 · 지금: 직렬 · 운영 mode=shadow · 판정: 처리/이월이 로그에 · shadow→live 는 실 틱 3개 뒤 OP 판정', ''),
  'REPORT-DELIVERY': dispatcherAsk('REPORT-DELIVERY', '판 발행 보고가 텔레그램에 안 간다(10-06 12:10 0.2.16 발행 직후 실패)', 'PR #24607 a6d8ac8db — UX 손 수확'),
  'AUTO-TARGET': dispatcherAsk('AUTO-TARGET', '대상 경로를 사람이 안 적어도 되게 · 실측 48h ask-preflight 42건 중 첫 줄 힌트 3건뿐', 'PR #24543 31a6eddbd — 하니스 런 needs-human/실패 → UX 손 착지'),
};

function withHarnessDecoys(body: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'ask-path-wrapper-'));
  try {
    const decoy = 'TASK-AGENT Pod PR UX OP Shard identity orchestrationId shardId task totalShards position summary siblings Working-memory handoff WORKING-MEMORY reusables decisions 0.2.20 a6d8ac8db 31a6eddbd';
    for (const rel of ['src/self-dev/orchestrate.ts', 'src/self-implement/orchestrator.ts', 'src/task-orchestrator/surfaces/self-implement-pod.ts', 'src/index.ts']) {
      mkdirSync(join(root, rel, '..'), { recursive: true });
      writeFileSync(join(root, rel), `// ${decoy}\n`);
    }
    mkdirSync(join(root, 'scripts'));
    body(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('AUTO-TARGET: the four real path-less dispatcher asks no longer ground on harness files via wrapper words', () => {
  withHarnessDecoys((root) => {
    for (const [id, ask] of Object.entries(REAL_PATHLESS_ASKS)) {
      const result = findAskPathCandidates(ask, { cwd: root });
      expect({ id, paths: result.paths }).toEqual({ id, paths: [] });
      expect(result.error).toBeUndefined();
      for (const wrapperWord of ['TASK-AGENT', 'Shard', 'shardId', 'totalShards', 'siblings', 'orchestrationId', id, 'a6d8ac8db', '31a6eddbd']) {
        expect(result.tokens).not.toContain(wrapperWord);
      }
    }
  });
});

test('AUTO-TARGET: wrapper stripping keeps the request body and evidence text', () => {
  const stripped = stripAskWrapper(dispatcherAsk('X-1', 'fix `relayOutbound` in report', 'see src/foo.ts'));
  expect(stripped).toBe('fix `relayOutbound` in report\nsee src/foo.ts\n');
});

test('AUTO-TARGET: generic seat/surface/version tokens are not evidence', () => {
  let calls = 0;
  const result = findAskPathCandidates('TASK-AGENT OP MK TC UX PR Pod TUI PWA CLI P0 P1 P2 v0.2.20 0.2.20 HITL', {
    cwd: '/repo', run: () => { calls++; return 'src/self-dev/orchestrate.ts\n'; },
  });
  expect(result).toEqual({ tokens: [], paths: [] });
  expect(calls).toBe(0);
});

test('AUTO-TARGET: a wrapped ask that names a real file still finds it', () => {
  withHarnessDecoys((root) => {
    mkdirSync(join(root, 'apps/pwa/src/components/ops'), { recursive: true });
    writeFileSync(join(root, 'apps/pwa/src/components/ops/ReleaseFlow.tsx'), 'export {};');
    const ask = dispatcherAsk('RELEASE-LIVE3', '발행 흐름 화면 apps/pwa/src/components/ops/ReleaseFlow.tsx 의 막힘 문구를 고친다', '');
    expect(findAskPathCandidates(ask, { cwd: root }).paths).toEqual(['apps/pwa/src/components/ops/ReleaseFlow.tsx']);
  });
});
