import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runAgentMission, resolveBackend, type AgentBackend, type AgentMissionResult, type AgentMissionSpec, type EvidenceMode } from './driver.js';

export interface DuoOptions {
  left: string;
  right: string;
  branch: string;
  base?: string;
  missionFile?: string;
  evidence?: string;
  docDir?: string;
  docGlob?: string;
  testPath?: string;
  file?: string;
  maxRounds?: string;
  commit?: boolean;
}

export interface DuoSide {
  side: 'left' | 'right';
  backend: string;
  branch: string;
  finished: number;
  result?: AgentMissionResult;
  error?: string;
}

export interface DuoResult {
  missionId: string;
  sides: [DuoSide, DuoSide];
  lines: [string, string];
  exitCode: number;
}

export interface DuoDeps {
  resolveBackend?: typeof resolveBackend;
  runMission?: typeof runAgentMission;
  readFile?: (path: string) => string;
  id?: () => string;
}

function evidenceFor(opts: DuoOptions): EvidenceMode {
  if (opts.evidence === 'doc') return { kind: 'doc', dirRel: opts.docDir ?? 'docs/plans', glob: new RegExp(opts.docGlob ?? '^PLAN-.*[.]md$', 'i') };
  if (opts.evidence === 'test') {
    if (!opts.testPath) throw new Error('test 모드엔 --test-path 필요');
    return { kind: 'test', testPath: opts.testPath, ...(opts.file ? { fileRel: opts.file } : {}) };
  }
  if (opts.evidence === undefined || opts.evidence === 'tsc') return { kind: 'tsc' };
  throw new Error('--evidence 는 doc|tsc|test 여야 합니다');
}

function render(side: DuoSide, first: DuoSide | undefined): string {
  const evidence = side.result?.evidenceSatisfied === true
    ? side.result.evidencePath ? `충족(${side.result.evidencePath})` : '충족'
    : side.result?.evidenceSatisfied === false ? '미충족' : '미측정';
  const drive = side.result?.driveVerdict ?? '미측정';
  const detail = side.error ?? (!side.result?.ok ? side.result?.detail : undefined);
  return `${side.side} ${side.backend} · branch=${side.branch} · terminalId=${side.result?.ptyId ?? '없음'} · ${first === side ? '먼저' : '나중'} · 증거 ${evidence} · DRIVE-OK ${drive} · ${side.result?.ok ? '완료' : '실패'}${detail ? ` (${detail})` : ''}`;
}

/** Run two independent existing agent missions; neither branch waits for or cancels its peer. */
export async function runAgentMissionDuo(textParts: string[], opts: DuoOptions, deps: DuoDeps = {}): Promise<DuoResult> {
  if (!opts.branch?.trim()) throw new Error('--branch 필요');
  if (opts.left !== 'codex' && opts.left !== 'claude') throw new Error('--left 는 codex|claude 여야 합니다');
  if (opts.right !== 'codex' && opts.right !== 'claude') throw new Error('--right 는 codex|claude 여야 합니다');
  if (opts.left === opts.right) throw new Error('duo 에는 서로 다른 backend 둘이 필요합니다');
  const mission = opts.missionFile ? (deps.readFile ?? ((path) => readFileSync(path, 'utf8')))(opts.missionFile) : textParts.join(' ');
  if (!mission.trim()) throw new Error('미션 텍스트가 비었다 — <text...> 또는 --mission-file 필요');
  const evidence = evidenceFor(opts);
  const rounds = opts.maxRounds === undefined ? 16 : Number(opts.maxRounds);
  if (!Number.isSafeInteger(rounds) || rounds <= 0) throw new Error('--max-rounds 는 양의 정수여야 합니다');
  const resolve = deps.resolveBackend ?? resolveBackend;
  const backends: [AgentBackend, AgentBackend] = [resolve(opts.left), resolve(opts.right)];
  if (backends[0].name !== opts.left || backends[1].name !== opts.right) throw new Error('backend 선택이 요청과 다릅니다');
  const id = `duo-${(deps.id ?? randomUUID)()}`;
  const run = deps.runMission ?? runAgentMission;
  let completed = 0;
  const branches = [`${opts.branch}-${opts.left}`, `${opts.branch}-${opts.right}`] as const;
  const tasks = backends.map(async (backend, index): Promise<DuoSide> => {
    const side = index === 0 ? 'left' : 'right';
    const branch = branches[index]!;
    const spec: AgentMissionSpec = {
      mission, branch, agent: backend, decisionMissionId: id, evidence, maxRounds: rounds,
      ...(opts.base ? { base: opts.base } : {}), commit: opts.commit !== false,
      enhance: false, memory: false, resources: 'off', entry: 'external-verbatim',
    };
    try { return { side, backend: backend.name, branch, result: await run(spec), finished: ++completed }; }
    catch (error) { return { side, backend: backend.name, branch, error: error instanceof Error ? error.message : String(error), finished: ++completed }; }
  });
  const sides = await Promise.all(tasks) as [DuoSide, DuoSide];
  const first = sides[0].finished <= sides[1].finished ? sides[0] : sides[1];
  return { missionId: id, sides, lines: [render(sides[0], first), render(sides[1], first)], exitCode: sides.every((s) => s.result?.ok) ? 0 : 2 };
}
