// U4b — mission CLI 글루 seam 실행 검증(주입·무실행). 성공경로·모든 옵션 전달·runDevPipeline 호출·
//   exit-code·에러경로를 process.exit/console 없이 커버(source-grep Goodhart 대체).

import { describe, it, expect } from 'bun:test';
import { runAgentMissionCliCommand, type MissionCliOpts, type MissionCliDeps } from './mission-cli.js';
import type { AgentBackend, AgentMissionResult } from './driver.js';
import { planDevPipeline, toAgentMissionSpec, type DevPipelineSpec, type DevPipelineDeps, type ResolvedDevPlan } from '../self-dev/dev-pipeline.js';

const BACKEND: AgentBackend = { name: 'codex', cmd: 'codex', args: ['--yolo'] };
const RESULT: AgentMissionResult = { ok: true, worktree: '/wt', branch: 'b', rounds: 2, evidencePath: '/e', committed: true, usedOmniCrawl: false, detail: 'ok' };

/** runDevPipeline 을 가로채 전달된 spec/deps 캡처. */
function captureRun(result: AgentMissionResult = RESULT): { fn: typeof import('../self-dev/dev-pipeline.js').runDevPipeline; last: () => { spec?: DevPipelineSpec; deps?: DevPipelineDeps } } {
  let spec: DevPipelineSpec | undefined, deps: DevPipelineDeps | undefined;
  const fn = (async (s: DevPipelineSpec, d?: DevPipelineDeps) => {
    spec = s; deps = d;
    return { plan: {} as ResolvedDevPlan, kind: 'agent-mission' as const, result };
  }) as typeof import('../self-dev/dev-pipeline.js').runDevPipeline;
  return { fn, last: () => ({ spec, deps }) };
}

const baseOpts = (over: Partial<MissionCliOpts> = {}): MissionCliOpts => ({ branch: 'wt/a', maxRounds: '16', ...over });

describe('runAgentMissionCliCommand — 성공경로(주입·무실행)', () => {
  it('미지정 선택 입력은 seam spec에 키를 만들지 않고, Commander 기본은 그대로 전달', async () => {
    const cap = captureRun();
    const deps: MissionCliDeps = { resolveBackend: () => BACKEND, runDevPipeline: cap.fn };
    const out = await runAgentMissionCliCommand(['기능', 'A'], baseOpts(), deps);
    expect(out.ok).toBe(true);
    if (out.ok) { expect(out.result).toBe(RESULT); expect(out.exitCode).toBe(0); }
    const { spec, deps: passed } = cap.last();
    expect(spec!.input).toEqual({ text: '기능 A' });
    expect(spec!.executor).toEqual({ kind: 'external', backend: 'codex' });
    expect(spec!.branch).toBe('wt/a');
    expect(Object.hasOwn(spec!, 'base')).toBe(false);
    expect(Object.hasOwn(spec!, 'enhance')).toBe(false);
    expect(Object.hasOwn(spec!.mission!, 'deliverableHint')).toBe(false);
    expect(Object.hasOwn(spec!.mission!, 'screensDir')).toBe(false);
    expect(spec!.mission).toMatchObject({ evidence: { kind: 'tsc' }, maxRounds: 16, commit: true, entry: 'elanous-apparatus', resources: 'on' });
    expect(Object.hasOwn(spec!.mission!, 'backendExplicit')).toBe(false);
    expect(toAgentMissionSpec('기능 A', planDevPipeline(spec!), () => BACKEND).resources).toBe('on');
    expect(passed!.resolveBackend!()).toBe(BACKEND); // 검증된 backend 주입(재resolve 없음)
  });

  it('docDir/docGlob 미지정은 pre-reroute Commander 기본값을 seam evidence에 명시한다', async () => {
    const cap = captureRun();
    await runAgentMissionCliCommand(['M'], baseOpts({ evidence: 'doc' }), { resolveBackend: () => BACKEND, runDevPipeline: cap.fn });
    const evidence = cap.last().spec!.mission!.evidence as { kind: string; dirRel: string; glob: RegExp };
    expect(Object.hasOwn(evidence, 'dirRel')).toBe(true);
    expect(Object.hasOwn(evidence, 'glob')).toBe(true);
    expect(evidence).toMatchObject({ kind: 'doc', dirRel: 'docs/plans' });
    expect(evidence.glob.source).toBe('^PLAN-.*\\.md$');
  });

  it('명시 docDir은 seam evidence에 값 그대로 전달한다', async () => {
    const cap = captureRun();
    await runAgentMissionCliCommand(['M'], baseOpts({ evidence: 'doc', docDir: 'docs/custom' }), { resolveBackend: () => BACKEND, runDevPipeline: cap.fn });
    const evidence = cap.last().spec!.mission!.evidence as { dirRel: string };
    expect(Object.hasOwn(evidence, 'dirRel')).toBe(true);
    expect(evidence.dirRel).toBe('docs/custom');
  });

  it('모든 옵션(doc evidence·base·no-enhance·deliverable·screens·no-commit) 전달', async () => {
    const cap = captureRun();
    const out = await runAgentMissionCliCommand(['M'], baseOpts({
      backend: 'claude', base: 'main', enhance: false, commit: false,
      evidence: 'doc', docDir: 'docs/x', docGlob: '^RFC-.*', deliverable: 'PPT', screens: '/s', maxRounds: '9',
    }), { resolveBackend: () => ({ name: 'claude', cmd: 'claude', args: ['--dangerously-skip-permissions'] }), runDevPipeline: cap.fn });
    expect(out.ok).toBe(true);
    const { spec } = cap.last();
    expect(spec!.executor).toEqual({ kind: 'external', backend: 'claude' });
    expect(spec!.base).toBe('main');
    expect(spec!.enhance).toBe(false);
    expect(spec!.mission).toMatchObject({ maxRounds: 9, commit: false, deliverableHint: 'PPT', screensDir: '/s', entry: 'elanous-apparatus' });
    expect((spec!.mission!.evidence as { kind: string; dirRel: string }).kind).toBe('doc');
    expect((spec!.mission!.evidence as { dirRel: string }).dirRel).toBe('docs/x');
  });

  it('--resources off 와 명시 --backend/--plugin 은 pipeline 을 지나 driver spec 까지 보존한다', async () => {
    const cap = captureRun();
    const out = await runAgentMissionCliCommand(['M'], baseOpts({ resources: 'off', backend: 'codex', plugin: 'manual@other' }), {
      resolveBackend: () => BACKEND, runDevPipeline: cap.fn,
    });
    expect(out.ok).toBe(true);
    const s = toAgentMissionSpec('M', planDevPipeline(cap.last().spec!), () => BACKEND);
    expect(s).toMatchObject({ resources: 'off', backendExplicit: 'codex', plugin: { plugin: 'manual', marketplace: 'other' } });
    expect(s.agent).toBe(BACKEND);
  });

  it('잘못된 --resources 는 실행 전에 거부한다', async () => {
    const cap = captureRun();
    const out = await runAgentMissionCliCommand(['M'], baseOpts({ resources: 'invalid' as 'on' }), {
      resolveBackend: () => BACKEND, runDevPipeline: cap.fn,
    });
    expect(out).toEqual({ ok: false, message: '--resources 는 on|off 여야 합니다', exitCode: 1 });
    expect(cap.last().spec).toBeUndefined();
  });

  it('doc evidence — docGlob 의 source/flags 무손실', async () => {
    const cap = captureRun();
    await runAgentMissionCliCommand(['M'], baseOpts({ evidence: 'doc', docDir: 'docs/x', docGlob: '^RFC-\\d+' }), { resolveBackend: () => BACKEND, runDevPipeline: cap.fn });
    const ev = cap.last().spec!.mission!.evidence as { kind: string; dirRel: string; glob: RegExp };
    expect(ev.kind).toBe('doc');
    expect(ev.glob.source).toBe('^RFC-\\d+'); // 정규식 원문 보존
    expect(ev.glob.flags).toBe('i');          // 대소문자 무시 플래그(기존 계약)
  });

  it('test evidence — testPath·file(fileRel) 무손실 전달', async () => {
    const cap = captureRun();
    await runAgentMissionCliCommand(['M'], baseOpts({ evidence: 'test', testPath: 'src/x.test.ts', file: 'src/x.ts' }), { resolveBackend: () => BACKEND, runDevPipeline: cap.fn });
    expect(cap.last().spec!.mission!.evidence).toEqual({ kind: 'test', testPath: 'src/x.test.ts', fileRel: 'src/x.ts' });
  });

  it('--mission-file → 주입 readFile 로 verbatim 본문', async () => {
    const cap = captureRun();
    const out = await runAgentMissionCliCommand([], baseOpts({ missionFile: '/m.md' }), {
      resolveBackend: () => BACKEND, runDevPipeline: cap.fn,
      readFile: (p) => { expect(p).toBe('/m.md'); return '파일\n미션'; },
    });
    expect(out.ok).toBe(true);
    expect(cap.last().spec!.input).toEqual({ text: '파일\n미션' });
  });

  it('result.ok=false → exit 2', async () => {
    const cap = captureRun({ ...RESULT, ok: false });
    const out = await runAgentMissionCliCommand(['M'], baseOpts(), { resolveBackend: () => BACKEND, runDevPipeline: cap.fn });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.exitCode).toBe(2);
  });

  it('--max-rounds 양의 정수는 숫자로 reroute spec에 전달', async () => {
    const cap = captureRun();
    const out = await runAgentMissionCliCommand(['M'], baseOpts({ maxRounds: '8' }), {
      resolveBackend: () => BACKEND,
      runDevPipeline: cap.fn,
    });
    expect(out.ok).toBe(true);
    expect(cap.last().spec!.mission!.maxRounds).toBe(8);
  });
});

describe('explicit mission chain', () => {
  it('passes the sequence into the same driver spec after reroute', async () => {
    const cap = captureRun();
    const out = await runAgentMissionCliCommand(['Build then review'], baseOpts({ chain: 'codex,claude,elanous' }), {
      resolveBackend: () => BACKEND, runDevPipeline: cap.fn,
    });
    expect(out.ok).toBe(true);
    expect(cap.last().spec!.mission!.chain).toEqual(['codex', 'claude', 'elanous']);
    const plan = planDevPipeline(cap.last().spec!);
    expect(toAgentMissionSpec('Build then review', plan, () => BACKEND).chain).toEqual(['codex', 'claude', 'elanous']);
  });
  it('accepts the optional codex repair return and rejects a mismatched explicit backend', async () => {
    const cap = captureRun();
    expect((await runAgentMissionCliCommand(['M'], baseOpts({ chain: 'codex,claude,codex,elanous' }), { resolveBackend: () => BACKEND, runDevPipeline: cap.fn })).ok).toBe(true);
    expect(cap.last().spec!.mission!.chain).toEqual(['codex', 'claude', 'codex', 'elanous']);
    expect((await runAgentMissionCliCommand(['M'], baseOpts({ chain: 'codex,claude,elanous', backend: 'claude' }), { resolveBackend: () => BACKEND })).ok).toBe(false);
  });
  it('rejects --no-commit with a PR chain', async () => {
    const cap = captureRun();
    const out = await runAgentMissionCliCommand(['M'], baseOpts({ chain: 'codex,claude,elanous', commit: false }), { resolveBackend: () => BACKEND, runDevPipeline: cap.fn });
    expect(out.ok).toBe(false);
    expect(cap.last().spec).toBeUndefined();
  });
  it.each(['codex', 'claude,elanous', 'codex,elanous', 'codex,claude,claude,elanous', 'codex,elanous,claude', 'codex,gemini', 'elanous,codex', 'codex,,claude'])('rejects invalid chain %s', async (chain) => {
    const cap = captureRun();
    const out = await runAgentMissionCliCommand(['M'], baseOpts({ chain }), { resolveBackend: () => BACKEND, runDevPipeline: cap.fn });
    expect(out.ok).toBe(false);
    expect(cap.last().spec).toBeUndefined();
  });
});

describe('runAgentMissionCliCommand — 에러경로', () => {
  it.each(['codex', 'gemini', 'grok', 'aside'])('--headless rejects %s before pipeline execution', async (name) => {
    const cap = captureRun();
    const out = await runAgentMissionCliCommand(['M'], baseOpts({ backend: name, headless: true }), {
      resolveBackend: () => ({ ...BACKEND, name: name as AgentBackend['name'] }), runDevPipeline: cap.fn,
    });
    expect(out).toEqual({ ok: false, message: '--headless 는 --backend claude 전용입니다', exitCode: 1 });
    expect(cap.last().spec).toBeUndefined();
  });

  it('--headless with Claude reaches the mission execution spec', async () => {
    const cap = captureRun();
    const out = await runAgentMissionCliCommand(['M'], baseOpts({ backend: 'claude', headless: true }), {
      resolveBackend: () => ({ ...BACKEND, name: 'claude' }), runDevPipeline: cap.fn,
    });
    expect(out.ok).toBe(true);
    expect(cap.last().spec!.mission!.headless).toBe(true);
    expect(cap.last().spec!.executor).toEqual({ kind: 'external', backend: 'claude' });
    const plan = planDevPipeline(cap.last().spec!);
    expect(toAgentMissionSpec('M', plan, () => ({ ...BACKEND, name: 'claude' })).headless).toBe(true);
  });

  it.each(['codex', 'gemini', 'grok', 'aside'])('pipeline also rejects --headless on %s', (name) => {
    expect(() => planDevPipeline({ input: { text: 'M' }, executor: { kind: 'external', backend: name as AgentBackend['name'] },
      branch: 'b', mission: { headless: true },
    })).toThrow('--headless');
  });

  it('bad backend → exit 1(재라우팅 전)', async () => {
    const out = await runAgentMissionCliCommand(['M'], baseOpts({ backend: 'bogus' }), {
      resolveBackend: () => { throw new Error("알 수 없는 agent backend 'bogus'"); },
    });
    expect(out.ok).toBe(false);
    if (!out.ok) { expect(out.exitCode).toBe(1); expect(out.message).toContain('bogus'); }
  });

  it('빈 미션 → exit 1', async () => {
    const out = await runAgentMissionCliCommand(['   '], baseOpts(), { resolveBackend: () => BACKEND });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toContain('비었다');
  });

  it('test 모드 + testPath 없음 → exit 1', async () => {
    const out = await runAgentMissionCliCommand(['M'], baseOpts({ evidence: 'test' }), { resolveBackend: () => BACKEND });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toContain('test-path');
  });

  it('--mission-file 읽기 실패 → exit 1', async () => {
    const out = await runAgentMissionCliCommand([], baseOpts({ missionFile: '/nope' }), {
      resolveBackend: () => BACKEND, readFile: () => { throw new Error('ENOENT'); },
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toContain('읽기 실패');
  });

  for (const maxRounds of ['abc', '-1', '0']) {
    it(`잘못된 --max-rounds ${maxRounds} → exit 1`, async () => {
      const cap = captureRun();
      const out = await runAgentMissionCliCommand(['M'], baseOpts({ maxRounds }), {
        resolveBackend: () => BACKEND,
        runDevPipeline: cap.fn,
      });
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.exitCode).toBe(1);
        expect(out.message).toContain('--max-rounds');
      }
      expect(cap.last().spec).toBeUndefined();
    });
  }

  it('reroute 실행 예외는 --max-rounds 검증 오류로 변환하지 않고 전파한다', async () => {
    const rerouteFailure = new Error('reroute failed');
    const runDevPipeline = (async () => { throw rerouteFailure; }) as typeof import('../self-dev/dev-pipeline.js').runDevPipeline;
    await expect(runAgentMissionCliCommand(['M'], baseOpts({ maxRounds: '8' }), {
      resolveBackend: () => BACKEND,
      runDevPipeline,
    })).rejects.toBe(rerouteFailure);
  });
});
