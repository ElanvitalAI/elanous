import { expect, test } from 'bun:test';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { runGraph } from '../../../src/graph-runner/runner.js';

const root = resolve(import.meta.dir, '..');
const stepFile = join(import.meta.dir, 'run-step.ts');
const bun = Bun.which('bun')!;
type Data = Record<string, unknown>;

function step(name: string, input: Data, outputs: Data, env: Record<string, string>) {
  const temp = mkdtempSync(join(tmpdir(), 'card-step-'));
  const context = join(temp, 'run.json.contexts', '1.json');
  mkdirSync(join(temp, 'run.json.contexts'));
  writeFileSync(context, JSON.stringify({ input, outputs }));
  const result = spawnSync(bun, [stepFile, name], { encoding: 'utf8', env: { ...process.env, ...env, ELANOUS_GRAPH_CONTEXT: context } });
  expect(result.status, result.stderr).toBe(0);
  return { temp, output: JSON.parse(result.stdout) as Data };
}

function executable(path: string, body: string) {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}


// A fake `elanous` whose `ask` answers drafts from a list (one per call, last repeats) and whose
// verifier flags any sentence containing «세계» — standing in for the model's judgment.
function fakeElanous(path: string, drafts: Data[], research = '', counter?: string) {
  executable(path, `#!/usr/bin/env node
const fs=require('node:fs');
const [, , , cmd, , payload]=process.argv;
fs.appendFileSync(${JSON.stringify(path + '.calls')}, process.argv.slice(2).join(' ')+'\\n');
if (cmd==='research') { process.stdout.write(JSON.stringify({output:${JSON.stringify(research)}})+'\\n'); process.exit(0); }
if (cmd!=='ask') process.exit(17);
const p=JSON.parse(payload);
if (p.task==='verify') { process.stdout.write(JSON.stringify({reply:JSON.stringify({unsupported:p.sentences.filter(s=>s.text.includes('세계')).map(s=>s.i)})})+'\\n'); process.exit(0); }
const counter=${JSON.stringify(counter ?? path + '.count')};
fs.appendFileSync(counter,'x');
const drafts=${JSON.stringify(drafts)};
const n=fs.readFileSync(counter,'utf8').length;
process.stdout.write(JSON.stringify({reply:JSON.stringify(drafts[Math.min(n,drafts.length)-1])})+'\\n');
`);
}

test('counterexamples reject bad input and preserve only sourced facts', () => {
  const temp = mkdtempSync(join(tmpdir(), 'card-counter-'));
  const image = join(temp, 'card.png');
  writeFileSync(image, 'fake image');
  const codex = join(temp, 'codex');
  executable(codex, `#!/bin/sh\nprintf '%s\\n' '설명 {"name":"가상 인물","title":"가상 직함","company":"가상 회사","email":null,"phone":null,"url":null,"linkedin":"https://linkedin.example/in/fictional","language":"ko"} 설명'\n`);
  const badCodex = join(temp, 'bad-codex');
  executable(badCodex, `#!/bin/sh\nprintf '%s\\n' 'JSON 없는 설명 문장입니다. 이 원문 앞부분이 실패 이유로 남아야 합니다.'\n`);
  const emptyResearch = join(temp, 'empty-research');
  executable(emptyResearch, `#!/bin/sh\nprintf '%s\\n' '{"output":""}'\n`);
  const longAsk = join(temp, 'long-ask');
  const contextLine = '가상 행사에서 가상 제품 데모를 짧게 이야기했습니다.';
  const validBody = contextLine + ' 후속 대화를 제안드리며 편하신 시간에 짧게 이어가면 좋겠습니다. 오늘 나눈 내용을 바탕으로 다음 질문을 준비했습니다. ' + '다음 만남에서 이야기를 더 이어가고 싶습니다. '.repeat(3);
  expect(validBody.length).toBeGreaterThanOrEqual(120);
  expect(validBody.length).toBeLessThanOrEqual(200);
  fakeElanous(longAsk, [{ subject: '제목', body: validBody, linkedin: '가'.repeat(301), question: '질문' }, { subject: '제목', body: validBody, linkedin: '짧은 초대', question: '질문' }], '', join(temp, 'ask.count'));
  const env = { CARD_FOLLOWUP_CODEX_BIN: codex, CARD_FOLLOWUP_ELANOUS_BIN: emptyResearch };
  const card = step('read-card', { image }, {}, env);
  expect(card.output.card).toMatchObject({ email: null, company: '가상 회사', phone: null });
  const relative = step('read-card', { image: 'cards/relative.png' }, {}, env);
  expect(relative.output).toMatchObject({ outcome: 'fail' });
  expect(relative.output.reason).toContain('절대 경로');
  const homeImage = join(homedir(), `.card-followup-test-${process.pid}.png`);
  writeFileSync(homeImage, 'fake image');
  const home = step('read-card', { image: `~/${homeImage.slice(homedir().length + 1)}` }, {}, env);
  expect(home.output.image).toBe(homeImage);
  rmSync(homeImage);
  const missing = step('read-card', { image: join(temp, 'missing.png') }, {}, env);
  expect(missing.output.outcome).toBe('fail');
  const noJson = step('read-card', { image }, {}, { ...env, CARD_FOLLOWUP_CODEX_BIN: badCodex });
  expect(noJson.output.outcome).toBe('fail');
  expect(noJson.output.reason).toContain('JSON 없는 설명 문장입니다.');
  const research = step('research', {}, { 'read-card': card.output }, env);
  expect(research.output).toMatchObject({ summary: null, news: [], sources: [] });
  const draft = step('draft', { context: contextLine }, { 'read-card': card.output, research: research.output }, { ...env, CARD_FOLLOWUP_ELANOUS_BIN: longAsk });
  expect(draft.output.destination).toEqual(['LinkedIn']);
  expect(draft.output.linkedin).toBe('짧은 초대');
  expect(readFileSync(join(temp, 'ask.count'), 'utf8')).toBe('xx');
  for (const item of [card, relative, home, missing, noJson, research, draft]) rmSync(item.temp, { recursive: true, force: true });
  rmSync(temp, { recursive: true, force: true });
});

test('unsupported claims fail, identity-only drafts pass with no research', () => {
  const temp = mkdtempSync(join(tmpdir(), 'card-invalid-draft-'));
  const contextLine = '행사에서 인사했습니다.';
  const filler = ' 후속 대화를 제안드립니다.'.repeat(7);
  const card = { card: { name: '가상 인물', company: '가상 회사', email: null, language: 'ko' } };
  const sourced = { sources: [{ title: '가상 회사 소개', url: 'https://example.test/company', snippet: '' }] };
  const cases: [string, string, Data, 'ok' | 'fail', string][] = [
    ['cited but unsupported', `${contextLine} 가상 회사 소개에 따르면 매출이 세계 1위입니다 [S1].${filler}`, sourced, 'fail', '출처 없는 회사 사실'],
    ['no company name', `${contextLine} 귀사는 세계 최대 기업입니다.${filler}`, { sources: [] }, 'fail', '출처 없는 회사 사실'],
    ['unknown source number', `${contextLine} 가상 회사 소개를 읽었습니다 [S9].${filler}`, sourced, 'fail', '없는 출처 번호'],
    ['short body', contextLine, { sources: [] }, 'fail', '120~200자'],
    ['identity only, research 0', `가상 회사 담당자님께. ${contextLine}${filler}`, { sources: [] }, 'ok', ''],
  ];
  for (const [kind, body, research, outcome, reason] of cases) {
    const fake = join(temp, `elanous-${cases.findIndex(c => c[0] === kind)}`);
    fakeElanous(fake, [{ subject: '팔로업', body, linkedin: '다시 만나 뵙고 싶습니다.', question: '어떤 주제가 좋으신가요?' }]);
    const result = step('draft', { context: contextLine }, { 'read-card': card, research }, { CARD_FOLLOWUP_ELANOUS_BIN: fake });
    expect(result.output.outcome, kind).toBe(outcome);
    if (outcome === 'fail') expect(result.output.reason, kind).toContain(reason);
    else expect(result.output.companyFacts, kind).toEqual([]);
    if (outcome === 'fail') expect(readFileSync(`${fake}.count`, 'utf8'), `${kind} retried`).toBe('xxx');
    rmSync(result.temp, { recursive: true, force: true });
  }
  // A rejected draft is retried with feedback; the corrected draft passes.
  const fix = join(temp, 'elanous-fix');
  fakeElanous(fix, [
    { subject: '팔로업', body: `${contextLine} 귀사는 세계 최대 기업입니다.${filler}`, linkedin: '초대', question: '질문' },
    { subject: '팔로업', body: `${contextLine}${filler} 다음 주에 뵙겠습니다.`, linkedin: '초대', question: '질문' },
  ]);
  const fixed = step('draft', { context: contextLine }, { 'read-card': card, research: { sources: [] } }, { CARD_FOLLOWUP_ELANOUS_BIN: fix });
  expect(fixed.output.outcome).toBe('ok');
  expect(fixed.output.body).not.toContain('세계');
  rmSync(fixed.temp, { recursive: true, force: true });
  rmSync(temp, { recursive: true, force: true });
});

test('installed graph completes and writes all three drafts with sources', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'card-graph-'));
  const installed = join(temp, 'installed'), elsewhere = join(temp, 'elsewhere'), bin = join(temp, 'bin');
  cpSync(root, installed, { recursive: true });
  mkdirSync(elsewhere); mkdirSync(bin);
  const image = join(temp, 'card.jpg');
  writeFileSync(image, 'fake image');
  const calls = join(temp, 'calls.log');
  executable(join(bin, 'codex'), `#!/bin/sh\necho "$*" >> '${calls}'\nprintf '%s\\n' '{"name":"가상 인물","title":"가상 직함","company":"가상 회사","email":"person@example.test","phone":null,"url":null,"linkedin":"https://linkedin.example/in/fictional","language":"ko"}'\n`);
  const contextLine = '가상 행사에서 가상 제품 데모를 짧게 이야기했습니다.';
  const body = contextLine + ' 가상 회사 소개를 바탕으로 후속 대화를 제안합니다 [S1]. 편하신 시간에 짧게 이어가면 좋겠습니다. ' + '다음 자리에서 이야기를 더 듣고 싶습니다. '.repeat(3);
  expect(body.length).toBeGreaterThanOrEqual(120);
  expect(body.length).toBeLessThanOrEqual(200);
  fakeElanous(join(bin, 'elanous'), [{ subject: '가상 팔로업', body, linkedin: '가상 행사 후속 대화를 제안드립니다.', question: '가상 제품 데모 중 가장 궁금했던 점은 무엇인가요?' }], '- [가상 회사 소개](https://example.test/company)\n- [가상 최근 소식](https://example.test/news)');
  const commands: string[] = [];
  const state = await runGraph(join(installed, 'graphs/card-followup.yaml'), {
    input: { image, context: contextLine, sender: '가상 발신자' },
    deps: { root: join(temp, 'state'), runBash: async (body, opts) => {
      commands.push(body);
      const result = spawnSync('/bin/bash', ['-c', body], { cwd: elsewhere, encoding: 'utf8', env: { ...opts.env, PATH: `${bin}:${process.env.PATH}`, CARD_FOLLOWUP_CODEX_BIN: join(bin, 'codex'), CARD_FOLLOWUP_ELANOUS_BIN: join(bin, 'elanous') } });
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.status ?? 1 };
    } },
  });
  expect(state.status).toBe('done');
  const recipes = parseYaml(readFileSync(join(installed, 'graphs/recipes.yaml'), 'utf8')) as Record<string, { command: string }>;
  expect(commands).toEqual(['read-card', 'research', 'draft', 'report'].map(id => recipes[id]!.command));
  const report = readFileSync(join(state.statePath.slice(0, -5), 'followup.md'), 'utf8');
  for (const heading of ['팔로업 메일', 'LinkedIn 초대 문구', '대화 이어 갈 질문']) expect(report).toContain(`## ${heading}`);
  expect(report).toContain('https://example.test/company');
  expect(report).toContain('가상 행사에서 가상 제품 데모를 짧게 이야기했습니다.');
  const output = JSON.parse(readFileSync(join(state.statePath.slice(0, -5), 'followup.json'), 'utf8')) as Data;
  const finalDraft = output.draft as Data;
  const finalResearch = output.research as Data;
  expect(output.sent).toBe(false);
  expect((finalDraft.body as string).length).toBeGreaterThanOrEqual(120);
  expect((finalDraft.body as string).length).toBeLessThanOrEqual(200);
  expect(finalDraft.body).toContain(contextLine);
  expect(finalDraft.body).toContain('가상 회사 소개');
  expect(finalDraft.body).not.toContain('[S1]');
  expect(finalDraft.companyFacts).toEqual([{ text: '가상 회사 소개를 바탕으로 후속 대화를 제안합니다.', url: 'https://example.test/company' }]);
  for (const fact of finalDraft.companyFacts as { text: string; url: string }[]) {
    expect((finalResearch.sources as { url: string }[]).some(source => source.url === fact.url)).toBe(true);
    expect([finalDraft.subject, finalDraft.body, finalDraft.linkedin, finalDraft.question].join(' ')).toContain(fact.text);
    expect(report).toContain(`${fact.text} — ${fact.url}`);
  }
  expect(readFileSync(join(bin, 'elanous.calls'), 'utf8')).toContain('--limit 5 가상 회사');
  expect(readFileSync(join(bin, 'elanous.calls'), 'utf8')).toContain('--limit 5 가상 인물 가상 회사');
  rmSync(join(bin, 'elanous.count'), { force: true });
  fakeElanous(join(bin, 'elanous'), [{ subject: '팔로업', body: '가상 회사는 세계 최대 기업입니다.', linkedin: '초대', question: '질문' }]);
  const rejected = await runGraph(join(installed, 'graphs/card-followup.yaml'), {
    input: { image, context: contextLine },
    deps: { root: join(temp, 'invalid-state'), runBash: async (command, opts) => {
      const response = spawnSync('/bin/bash', ['-c', command], { cwd: elsewhere, encoding: 'utf8', env: { ...opts.env, PATH: `${bin}:${process.env.PATH}`, CARD_FOLLOWUP_CODEX_BIN: join(bin, 'codex'), CARD_FOLLOWUP_ELANOUS_BIN: join(bin, 'elanous') } });
      return { stdout: response.stdout, stderr: response.stderr, exitCode: response.status ?? 1 };
    } },
  });
  expect(rejected.status).not.toBe('done');
  rmSync(temp, { recursive: true, force: true });
});
