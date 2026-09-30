import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGraph, lastJsonObject } from '../../../src/graph-runner/runner.js';

const headings = ['기업 개요 및 교육 대상', '교육 니즈', '직무·과제 및 NCS', 'AI 적합성', '역량 진단', '교육 로드맵', '교육 명세·운영 경로'];
async function step(root: string, name: string, input: object, outputs: Record<string, unknown>, path: string[] = []) {
  const state = join(root, 'state.json');
  const contexts = `${state}.contexts`;
  mkdirSync(contexts, { recursive: true });
  writeFileSync(state, JSON.stringify({ path }));
  const context = join(contexts, `${name}.json`);
  writeFileSync(context, JSON.stringify({ input, outputs }));
  const fakeNcs = `globalThis.fetch = async request => {
    const url = new URL(request);
    if (url.pathname.endsWith('/NCS007')) return Response.json({ response: { header: { resultCode: '00' }, body: { items: { item: [{ NCS_COMPE_UNIT_CD: '123456789012', COMPE_UNIT_NAME: '문서 기획', COMPE_UNIT_DEF: '문서를 기획한다' }] } } } });
    if (url.pathname.endsWith('/NCS005')) return Response.json({ response: { header: { resultCode: '00' }, body: { items: { item: [{ COMPE_UNIT_LVL: '4', COMPE_UNIT_ELEM: { items: { item: [{ COMPE_UNIT_ELEM_NAME: '기획', PERF_CRIT: '요구사항에 맞게 기획한다' }] } } }] } } } });
    throw new Error('unexpected NCS operation');
  };
  process.argv[2] = ${JSON.stringify(name)};
  await import(${JSON.stringify(new URL('./run-step.ts', import.meta.url).href)});`;
  const child = Bun.spawn([process.execPath, '-e', fakeNcs], {
    env: { ...process.env, NCS_SERVICE_KEY: 'fake-key', ELANOUS_GRAPH_CONTEXT: context }, stdout: 'pipe', stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(stderr).toBe('');
  expect(code).toBe(0);
  return JSON.parse(stdout) as Record<string, unknown>;
}

test('real enterprise graph takes a fictional interview through NCS, report and judge retry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'job-coach-graph-'));
  try {
    const interview = join(root, 'enterprise.md');
    writeFileSync(interview, ['## 기업 개요', '가상 회사', '## 교육 대상', '기획 담당자', '## 현업 과제', '문서 기획',
      '## 교육 목표', '요구사항에 맞게 문서를 기획한다', '## 현재 역량', '문서 작성 경험 (자기보고)',
      '## 교육 제약', '예산 미확인'].join('\n'));
    const preload = join(root, 'fake-ncs.ts');
    writeFileSync(preload, `globalThis.fetch = async (request) => {
      const url = new URL(request);
      if (url.pathname.endsWith('/NCS007')) return Response.json({ response: { header: { resultCode: '00' }, body: { items: { item: [{ NCS_COMPE_UNIT_CD: '123456789012', COMPE_UNIT_NAME: '문서 기획', COMPE_UNIT_DEF: '문서를 기획한다' }] } } } });
      if (url.pathname.endsWith('/NCS005')) return Response.json({ response: { header: { resultCode: '00' }, body: { items: { item: [{ COMPE_UNIT_LVL: '4', COMPE_UNIT_ELEM: { items: { item: [{ COMPE_UNIT_ELEM_NAME: '기획', PERF_CRIT: '요구사항에 맞게 기획한다' }] } } }] } } } });
      throw new Error('unexpected NCS operation');
    };`);
    let sabotaged = false;
    const state = await runGraph(join(import.meta.dir, 'report-enterprise.yaml'), {
      input: { interview }, deps: { root, log: () => {}, runBash: async (command, opts) => {
        expect(command).toMatch(/^bun "\$ELANOUS_GRAPH_DIR\/run-step\.ts" /);
        if (command.endsWith(' judge-enterprise') && !sabotaged) {
          const stateFile = opts.env?.ELANOUS_GRAPH_CONTEXT?.replace(/\.contexts\/\d+\.json$/, '');
          expect(stateFile).toBeDefined();
          const report = join(stateFile!.slice(0, -'.json'.length), 'report.md');
          const content = readFileSync(report, 'utf8');
          expect(content).toContain('- 비AI 대안: 업무 절차 정리 및 담당자 검토');
          writeFileSync(report, content.replace('- 비AI 대안: 업무 절차 정리 및 담당자 검토', '- 비AI 대안: 미확인'));
          sabotaged = true;
        }
        const child = Bun.spawn(['/bin/bash', '-c', command.replace(/^bun /, `bun --preload "${preload}" `)], {
          cwd: opts.cwd, env: { ...opts.env, NCS_SERVICE_KEY: 'fake-key' }, stdout: 'pipe', stderr: 'pipe',
        });
        const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        return { stdout, stderr, exitCode };
      } },
    });
    expect(sabotaged).toBe(true);
    expect(state.status).toBe('done');
    expect(state.path).toEqual(['intake', 'needs', 'task', 'ncs-match', 'ai-fit', 'competency', 'roadmap', 'spec', 'routing', 'judge',
      'ai-fit', 'competency', 'roadmap', 'spec', 'routing', 'judge', 'done']);
    expect(state.nodes.filter(node => node.nodeId === 'judge').map(node => lastJsonObject(node.output)?.outcome)).toEqual(['retry', 'ok']);
    const ncs = state.nodes.find(node => node.nodeId === 'ncs-match');
    expect(lastJsonObject(ncs?.output)?.units).toMatchObject([{ code: '123456789012', name: '문서 기획', level: '4' }]);
    const report = (lastJsonObject([...state.nodes].reverse().find(node => node.nodeId === 'routing')?.output)?.report) as string;
    const content = readFileSync(report, 'utf8');
    expect(content.match(/^## /gm)).toHaveLength(7);
    const sections = headings.map((heading, index) => {
      const start = content.indexOf(`## ${heading}\n`);
      const end = index + 1 < headings.length ? content.indexOf(`## ${headings[index + 1]}\n`) : content.length;
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      return content.slice(start, end);
    });
    expect(sections[0]).toContain('- 교육 대상 (인터뷰 자기보고): 기획 담당자');
    expect(sections[1]).toContain('- 근거: 인터뷰 자기보고');
    expect(sections[2]).toContain('- NCS 123456789012 — 문서 기획 · 수준 4');
    expect(sections[3]).toContain('- 비AI 대안: 업무 절차 정리 및 담당자 검토');
    expect(sections[4]).toContain('- 요구 역량: NCS 123456789012 — 문서 기획 · 수준 4');
    expect(sections[5]).toContain('- 2. 업무 기반 실습');
    expect(sections[6]).toContain('- 추천 과정·URL: 미확인');
    expect(content).not.toContain('## 추천 코스');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('enterprise dispatcher reuses NCS matching, writes seven evidence-bearing sections and judges retry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'job-coach-enterprise-'));
  try {
    const interview = join(root, 'interview.md');
    writeFileSync(interview, ['## 기업 개요', '가상 회사', '## 교육 대상', '기획 담당자', '## 현업 과제', '문서 기획',
      '## 교육 목표', '요구사항에 맞게 문서를 기획한다', '## 현재 역량', '문서 작성 경험 (자기보고)',
      '## 교육 제약', '예산 미확인'].join('\n'));
    const input = { interview };
    const outputs: Record<string, unknown> = {};
    for (const name of ['intake', 'needs', 'task', 'ncs-match', 'ai-fit', 'competency', 'roadmap', 'spec', 'routing']) {
      outputs[name] = await step(root, name, input, outputs);
    }
    const units = (outputs['ncs-match'] as { units: { code: string; name: string; level: string }[] }).units;
    expect(units).toMatchObject([{ code: '123456789012', name: '문서 기획', level: '4' }]);
    const report = (outputs.routing as { report: string }).report;
    const content = readFileSync(report, 'utf8');
    expect(headings.map(heading => content.includes(`## ${heading}\n`))).toEqual(headings.map(() => true));
    expect(content).toContain('NCS 123456789012');
    expect(content).toContain('교육 대상: 기획 담당자');
    expect(content).toContain('근거: 인터뷰 자기보고');
    expect(content).toContain('과제 출처: 현업 과제·교육 목표 (인터뷰 자기보고)');
    expect(content).toContain('적용 검토 과제: 문서 기획');
    expect(content).toContain('관련 NCS 코드: 123456789012');
    expect(content).toContain('요구 역량: NCS 123456789012 — 문서 기획 · 수준 4');
    expect(content).toContain('비AI 대안: 업무 절차 정리 및 담당자 검토');
    expect(content).toContain('추천 과정·URL: 미확인');
    expect(content).not.toContain('## 추천 코스');
    expect((await step(root, 'judge-enterprise', input, outputs, ['judge'])).outcome).toBe('ok');
    for (const missing of ['- 비AI 대안: 업무 절차 정리 및 담당자 검토', '- 2. 업무 기반 실습', '- 평가: 실제 업무 산출물의 수행 기준에 따른 관찰 평가']) {
      expect(content).toContain(missing);
      writeFileSync(report, content.replace(missing, '- 미확인'));
      expect((await step(root, 'judge-enterprise', input, outputs, ['judge'])).outcome).toBe('retry');
    }
    writeFileSync(report, content);
    for (const field of ['교육 대상', '교육 목표']) {
      const tampered = { ...outputs, intake: { ...(outputs.intake as object), sections: {
        ...((outputs.intake as { sections: object }).sections), [field]: '미확인',
      } } };
      expect((await step(root, 'judge-enterprise', input, tampered, ['judge'])).outcome).toBe('retry');
    }
    const withoutNeeds = { ...outputs, needs: { ...(outputs.needs as object), requestedOutcome: '미확인' } };
    expect((await step(root, 'judge-enterprise', input, withoutNeeds, ['judge'])).outcome).toBe('retry');
    const withoutAlternative = { ...outputs, 'ai-fit': { ...(outputs['ai-fit'] as object), alternative: '미확인' } };
    expect((await step(root, 'judge-enterprise', input, withoutAlternative, ['judge'])).outcome).toBe('retry');
    const withoutTask = { ...outputs, 'ai-fit': { ...(outputs['ai-fit'] as object), task: '다른 과제' } };
    expect((await step(root, 'judge-enterprise', input, withoutTask, ['judge'])).outcome).toBe('retry');
    const wrongRequirement = { ...outputs, competency: { ...(outputs.competency as object), requirements: [{ code: '123456789012', name: '다른 역량', level: '4' }] } };
    expect((await step(root, 'judge-enterprise', input, wrongRequirement, ['judge'])).outcome).toBe('retry');
    const withoutRoadmap = { ...outputs, roadmap: { ...(outputs.roadmap as object), phases: ['미확인'] } };
    expect((await step(root, 'judge-enterprise', input, withoutRoadmap, ['judge'])).outcome).toBe('retry');
    writeFileSync(report, content.replace('- NCS 123456789012', '- NCS 미확인'));
    expect((await step(root, 'judge-enterprise', input, outputs, ['judge'])).outcome).toBe('retry');
    // A missing section must trigger a retry.
    writeFileSync(report, content.replace(`## ${headings[3]}\n`, '### 적용 검토\n'));
    expect((await step(root, 'judge-enterprise', input, outputs, ['judge'])).outcome).toBe('retry');
    expect((await step(root, 'judge-enterprise', input, outputs, ['judge', 'judge'])).outcome).toBe('fail');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('enterprise intake rejects blank or unknown required audience and goal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'job-coach-required-'));
  try {
    const interview = join(root, 'interview.md');
    for (const field of ['교육 대상', '교육 목표']) {
      for (const missing of ['', '미확인']) {
        writeFileSync(interview, ['## 기업 개요', '가상 회사', '## 교육 대상', field === '교육 대상' ? missing : '기획 담당자',
          '## 현업 과제', '문서 기획', '## 교육 목표', field === '교육 목표' ? missing : '문서를 기획한다',
          '## 현재 역량', '미확인', '## 교육 제약', '미확인'].join('\n'));
        await expect(step(root, 'intake', { interview }, {})).rejects.toThrow(`missing enterprise ${field}`);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('personal dispatcher profile and NCS match preserve personal output contract', async () => {
  const root = mkdtempSync(join(tmpdir(), 'job-coach-personal-'));
  try {
    const interview = join(root, 'interview.md');
    writeFileSync(interview, '## 희망 직무\n문서 기획\n## 경험\n- 문서를 작성했다.\n## 보유 역량\n문서 작성\n');
    const input = { interview };
    const profile = await step(root, 'profile', input, {});
    expect(profile).toEqual({ jobs: ['문서 기획'], skills: ['문서 작성'], experienceCount: 1 });
    const ncs = await step(root, 'ncs-match', input, { profile });
    expect((ncs.units as object[])[0]).toMatchObject({ job: '문서 기획', code: '123456789012', level: '4' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
