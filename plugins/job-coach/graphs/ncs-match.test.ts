import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { judgeGaps, MAX_GAP_PROMPT_CHARS, type GapUnit } from './gap-judge.js';

const unit: GapUnit = {
  code: '123456789012', name: '직무 수행', definition: '직무를 수행한다', level: '4',
  elements: [{ name: '기획', criteria: '요구사항에 맞게 기획한다' }],
};
const apiResult = (body: unknown) => ({ response: { header: { resultCode: '00' }, body } });

async function installedReport(missingCode = false, withValid = false) {
  const root = mkdtempSync(join(tmpdir(), 'job-coach-ncs-'));
  const state = join(root, 'state.json');
  const contexts = `${state}.contexts`;
  mkdirSync(contexts);
  const context = join(contexts, 'ncs-match.json');
  const interview = join(root, 'interview.md');
  writeFileSync(interview, '## 경험\n- 프로젝트를 기획했다.\n');
  writeFileSync(context, JSON.stringify({ input: { interview }, outputs: { profile: { jobs: ['직무'] } } }));
  const fakeFetch = `globalThis.fetch = async (request) => {
    const url = new URL(request);
    if (url.pathname.endsWith('/NCS007')) return Response.json(${JSON.stringify(apiResult({ items: { item: [{ NCS_CL_CD: '12345678', ...(missingCode ? {} : { NCS_COMPE_UNIT_CD: unit.code }), COMPE_UNIT_NAME: missingCode && withValid ? '코드 없는 단위' : unit.name, COMPE_UNIT_DEF: unit.definition }, ...(withValid ? [{ NCS_CL_CD: '12345678', NCS_COMPE_UNIT_CD: unit.code, COMPE_UNIT_NAME: unit.name, COMPE_UNIT_DEF: unit.definition }] : [])] } }))});
    if (url.pathname.endsWith('/NCS005')) {
      if (url.searchParams.get('NCS_COMPE_UNIT_CD') !== '${unit.code}' || url.searchParams.get('NCS_CL_CD') !== '12345678') return new Response('wrong unit code', { status: 422 });
      return Response.json(${JSON.stringify(apiResult({ items: { item: [{ COMPE_UNIT_LVL: unit.level, COMPE_UNIT_ELEM: { items: { item: [{ COMPE_UNIT_ELEM_NAME: unit.elements[0]!.name, PERF_CRIT: unit.elements[0]!.criteria }] } } }] } }))});
    }
    return new Response('unexpected NCS operation', { status: 404 });
  };
  process.argv[2] = 'ncs-match';
  await import(${JSON.stringify(new URL('./run-step.ts', import.meta.url).href)});`;
  try {
    const child = Bun.spawn([process.execPath, '-e', fakeFetch], {
      env: { ...process.env, ELANOUS_GRAPH_CONTEXT: context, NCS_SERVICE_KEY: 'fake-key' },
      stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, exitCode };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function bulkReport(criteria = '요구사항에 맞게 기획한다') {
  const root = mkdtempSync(join(tmpdir(), 'job-coach-bulk-'));
  const state = join(root, 'state.json');
  const contexts = `${state}.contexts`;
  mkdirSync(contexts);
  const interview = join(root, 'interview.md');
  writeFileSync(interview, '## 경험\n- 프로젝트를 기획했다.\n');
  const context = join(contexts, 'ncs-match.json');
  writeFileSync(context, JSON.stringify({ input: { interview }, outputs: { profile: { jobs: ['직무 A', '직무 B', '직무 C'] } } }));
  const fakeFetch = `
    const codes = [];
    let active = 0, peak = 0;
    globalThis.fetch = async request => {
      const url = new URL(request);
      if (url.pathname.endsWith('/NCS007')) return Response.json(${JSON.stringify(apiResult({ items: { item: Array.from({ length: 20 }, (_, i) => ({ NCS_COMPE_UNIT_CD: String(123456780000 + i), COMPE_UNIT_NAME: `단위 ${i}`, COMPE_UNIT_DEF: '정의' })) } }))});
      if (url.pathname.endsWith('/NCS005')) {
        codes.push(url.searchParams.get('NCS_COMPE_UNIT_CD'));
        active++; peak = Math.max(peak, active);
        await new Promise(resolve => setTimeout(resolve, 5));
        active--;
        return Response.json(${JSON.stringify(apiResult({ items: { item: [{ COMPE_UNIT_LVL: '4', COMPE_UNIT_ELEM: { items: { item: [{ COMPE_UNIT_ELEM_NAME: '기획', PERF_CRIT: criteria }] } } }] } }))});
      }
      throw new Error('unexpected operation');
    };
    const print = console.log;
    console.log = output => print(JSON.stringify({ output: JSON.parse(output), codes, peak }));
    process.argv[2] = 'ncs-match';
    await import(${JSON.stringify(new URL('./run-step.ts', import.meta.url).href)});
  `;
  try {
    const child = Bun.spawn([process.execPath, '-e', fakeFetch], { env: { ...process.env, ELANOUS_GRAPH_CONTEXT: context, NCS_SERVICE_KEY: 'fake-key' }, stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, exitCode };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('personal NCS match and interview gap', () => {
  test('installedReport requests the exact NCS005 competency unit code and preserves level, elements and criteria', async () => {
    const { exitCode, stdout, stderr } = await installedReport();
    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toEqual({ units: [{ job: '직무', ...unit, source: 'https://www.data.go.kr/data/15128213/openapi.do#NCS005' }] });
  });

  test('a named search result without a competency unit code cannot use its classification code', async () => {
    const { exitCode, stderr } = await installedReport(true);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('without NCS_COMPE_UNIT_CD');
  });

  test('a hit without a competency unit code is skipped while a coded hit in the same search still reports', async () => {
    const { exitCode, stdout, stderr } = await installedReport(true, true);
    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toEqual({ units: [{ job: '직무', ...unit, source: 'https://www.data.go.kr/data/15128213/openapi.do#NCS005' }] });
  });

  test('many search hits have bounded detail calls and concurrency; selected detail fits a single decision prompt', async () => {
    const { exitCode, stdout, stderr } = await bulkReport();
    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    const { output, codes, peak } = JSON.parse(stdout);
    expect(codes).toEqual(Array.from({ length: 6 }, (_, i) => String(123456780000 + i)));
    expect(peak).toBeLessThanOrEqual(2);
    expect(output.units).toHaveLength(6);
    expect(output.units.every((u: GapUnit) => u.level === '4' && u.elements[0]?.criteria === '요구사항에 맞게 기획한다')).toBe(true);
    let calls = 0;
    const verdicts = await judgeGaps(output.units, '## 경험\n- 프로젝트를 기획했다.\n', async prompt => {
      calls++;
      expect(prompt.length).toBeLessThanOrEqual(MAX_GAP_PROMPT_CHARS);
      return JSON.stringify({ gaps: output.units.map((u: GapUnit) => ({ code: u.code, status: '보유', quote: '프로젝트를 기획했다.' })) });
    });
    expect(calls).toBe(1);
    expect(verdicts).toHaveLength(6);
  });

  test('large NCS criteria cannot create an oversized gap prompt', async () => {
    const { exitCode, stdout, stderr } = await bulkReport('수행'.repeat(3000));
    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    const { output, codes } = JSON.parse(stdout);
    expect(codes).toHaveLength(6);
    expect(output.units).toHaveLength(1);
    let calls = 0;
    await judgeGaps(output.units, '## 경험\n- 프로젝트를 기획했다.\n', async prompt => {
      calls++;
      expect(prompt.length).toBeLessThanOrEqual(MAX_GAP_PROMPT_CHARS);
      return JSON.stringify({ gaps: [] });
    });
    expect(calls).toBe(1);
  });

  test('one LLM decision retains a complete original sentence for 보유 and 부분, but downgrades fragments and invented quotes', async () => {
    const interview = '## 경험\n- 프로젝트를 기획했다.\n- 실무에 일부 참여했다.\n- 해본 적 없다.\n';
    const units = [unit, { ...unit, code: '2' }, { ...unit, code: '3' }, { ...unit, code: '4' }, { ...unit, code: '5' }];
    let calls = 0;
    const verdicts = await judgeGaps(units, interview, async prompt => {
      calls++;
      expect(prompt).toContain('요구사항에 맞게 기획한다');
      expect(prompt).toContain('"level":"4"');
      return JSON.stringify({ gaps: [
        { code: unit.code, status: '보유', quote: '프로젝트를 기획했다.' },
        { code: '2', status: '부분', quote: '실무에 일부 참여했다.' },
        { code: '3', status: '보유', quote: '없다.' },
        { code: '4', status: '보유', quote: '수행했다.' },
        { code: '5', status: '보유', quote: '기획했다.' },
      ] });
    });
    expect(calls).toBe(1);
    expect(verdicts.map(v => [v.status, v.quote])).toEqual([
      ['보유', '프로젝트를 기획했다.'], ['부분', '실무에 일부 참여했다.'], ['갭', ''], ['갭', ''], ['갭', ''],
    ]);
  });
  test('a rerun judges the current NCS units and interview instead of returning a previous gap output', async () => {
    const root = mkdtempSync(join(tmpdir(), 'job-coach-gap-'));
    try {
      const bin = join(root, 'bin');
      mkdirSync(bin);
      const reply = JSON.stringify({ gaps: [{ code: unit.code, status: '보유', quote: '프로젝트를 기획했다.' }] });
      writeFileSync(join(bin, 'elanous'), `#!/bin/sh\nprintf '%s' ${JSON.stringify(JSON.stringify({ reply }))}\n`, { mode: 0o755 });
      const contexts = join(root, 'state.json.contexts');
      mkdirSync(contexts);
      const interview = join(root, 'interview.md');
      writeFileSync(interview, '## 경험\n- 프로젝트를 기획했다.\n');
      const context = join(contexts, 'gap.json');
      writeFileSync(context, JSON.stringify({ input: { interview }, outputs: {
        'ncs-match': { units: [{ job: '직무', ...unit }] },
        gap: { gaps: [{ code: 'stale-previous-run', status: '갭', quote: '' }] },
      } }));
      const child = Bun.spawn([process.execPath, new URL('./run-step.ts', import.meta.url).pathname, 'gap'], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ELANOUS_GRAPH_CONTEXT: context }, stdout: 'pipe', stderr: 'pipe',
      });
      const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(stderr).toBe('');
      expect(exitCode).toBe(0);
      const codes = (JSON.parse(stdout) as { gaps: { code: string }[] }).gaps.map(gap => gap.code);
      expect(codes).toEqual([unit.code]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
