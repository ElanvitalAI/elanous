import { expect, spyOn, test } from 'bun:test';
import { askWithRetry } from './run-step.js';
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
// An installed plugin runs outside any git tree, where the real CLI refuses \`--test\` (no isolation root).
if (process.argv.includes('--test')) { process.stderr.write('[--test] 격리 루트를 정할 수 없습니다\\n'); process.exit(1); }
const [, , cmd, , payload]=process.argv;
fs.appendFileSync(${JSON.stringify(path + '.calls')}, process.argv.slice(2).join(' ')+'\\n');
if (cmd==='research') { process.stdout.write(JSON.stringify({output:${JSON.stringify(research)}})+'\\n'); process.exit(0); }
if (cmd!=='ask') process.exit(17);
const p=JSON.parse(payload);
if (p.task==='strategy') { process.stdout.write(JSON.stringify({reply:JSON.stringify({fit:{score:85,label:'high',reasons:[{text:'제안 적합',basis:'offer'},{text:'회사 조사',basis:'S1'},{text:'직함',basis:'card'}]},approach:{who:p.card.name,problem:'후속 대화',proposal:'가상 제품 데모',channel:'email',timing:'다음 주'},nextAction:{what:'후속 연락',due:'다음 주'},approachBasis:{who:['card'],problem:['context'],proposal:[p.offer?'offer':'assumption'],channel:['assumption'],timing:['assumption']},nextActionBasis:{what:['assumption'],due:['assumption']}})})+'\\n'); process.exit(0); }
if (p.task==='strategy-verify') { process.stdout.write(JSON.stringify({reply:JSON.stringify({unsupportedReasons:p.claims.filter(s=>s.text.includes('세계')).map(s=>s.i),unsupportedApproach:p.approach.filter(s=>s.text.includes('세계')).map(s=>s.field),unsupportedAction:p.nextAction.filter(s=>s.text.includes('세계')).map(s=>s.field)})})+'\\n'); process.exit(0); }
if (p.task==='verify') { process.stdout.write(JSON.stringify({reply:JSON.stringify({unsupported:p.sentences.filter(s=>s.text.includes('세계')).map(s=>s.i)})})+'\\n'); process.exit(0); }
const counter=${JSON.stringify(counter ?? path + '.count')};
fs.appendFileSync(counter,'x');
const drafts=${JSON.stringify(drafts)};
const n=fs.readFileSync(counter,'utf8').length;
process.stdout.write(JSON.stringify({reply:JSON.stringify(drafts[Math.min(n,drafts.length)-1])})+'\\n');
`);
}

test('ask retries one socket failure, waits 3 seconds and returns the second answer without logging the card', async () => {
  const calls: string[][] = [];
  const waits: number[] = [];
  const log = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const payload = { task: 'draft', card: { name: 'private card name' } };
    const answer = await askWithRetry(payload, async (_bin, args) => {
      calls.push(args);
      if (calls.length === 1) throw new Error('ask 실패: The socket connection was closed unexpectedly');
      return JSON.stringify({ reply: '{"subject":"ok"}' });
    }, async ms => { waits.push(ms); });
    expect(answer).toEqual({ subject: 'ok' });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(['ask', '--json', JSON.stringify(payload)]);
    expect(calls[1]).toEqual(calls[0]);
    expect(waits).toEqual([3000]);
    expect(log).toHaveBeenCalledWith('card-followup: ask retry (socket)');
    expect(log.mock.calls.flat().join(' ')).not.toContain('private card name');
  } finally { log.mockRestore(); }
});

test('ask fails after exactly one retry even when the second socket failure persists', async () => {
  let calls = 0;
  const waits: number[] = [];
  const log = spyOn(console, 'error').mockImplementation(() => {});
  try {
    await expect(askWithRetry({}, async () => {
      calls++;
      throw new Error('ask 실패: socket connection was closed unexpectedly');
    }, async ms => { waits.push(ms); })).rejects.toThrow('한 번 다시 했지만 실패');
    expect(calls).toBe(2);
    expect(waits).toEqual([3000]);
    expect(log).toHaveBeenCalledTimes(1);
  } finally { log.mockRestore(); }
});

test('ask does not retry non-transient execution failures or JSON parsing failures', async () => {
  for (const response of [new Error('invalid JSON'), '{invalid JSON']) {
    let calls = 0;
    let waits = 0;
    await expect(askWithRetry({}, async () => {
      calls++;
      if (response instanceof Error) throw response;
      return response;
    }, async () => { waits++; })).rejects.toThrow();
    expect(calls).toBe(1);
    expect(waits).toBe(0);
  }
});

test('ask inspects the complete CLI stderr after a truncated exit message', async () => {
  let calls = 0;
  const log = spyOn(console, 'error').mockImplementation(() => {});
  try {
    expect(await askWithRetry({}, async () => {
      calls++;
      if (calls === 1) throw new Error(`ask 실패: ${'x'.repeat(200)}`, { cause: 'stderr: HTTP 503 Service Unavailable' });
      return JSON.stringify({ reply: '{}' });
    }, async () => {})).toEqual({});
    expect(calls).toBe(2);
    expect(log).toHaveBeenCalledWith('card-followup: ask retry (HTTP503)');
  } finally { log.mockRestore(); }
});

test('ask reports a second malformed answer after the one transport retry', async () => {
  let calls = 0;
  const log = spyOn(console, 'error').mockImplementation(() => {});
  try {
    await expect(askWithRetry({}, async () => {
      calls++;
      if (calls === 1) throw new Error('ECONNRESET');
      return '{invalid JSON';
    }, async () => {})).rejects.toThrow('한 번 다시 했지만 실패');
    expect(calls).toBe(2);
  } finally { log.mockRestore(); }
});

test('ask succeeds on the first call without waiting', async () => {
  let calls = 0;
  let waits = 0;
  expect(await askWithRetry({}, async () => {
    calls++;
    return JSON.stringify({ reply: '{"subject":"ok"}' });
  }, async () => { waits++; })).toEqual({ subject: 'ok' });
  expect(calls).toBe(1);
  expect(waits).toBe(0);
});

test('only documented transport and HTTP statuses trigger one retry', async () => {
  for (const message of ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'fetch failed', 'HTTP 502', 'HTTP 503', 'HTTP 504', 'HTTP 429']) {
    let calls = 0;
    let waits = 0;
    const log = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await askWithRetry({}, async () => {
        calls++;
        if (calls === 1) throw new Error(`ask 실패: ${message}`);
        return JSON.stringify({ reply: '{}' });
      }, async () => { waits++; });
      expect(calls, message).toBe(2);
      expect(waits, message).toBe(1);
      expect(log).toHaveBeenCalledTimes(1);
    } finally { log.mockRestore(); }
  }
});

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
  const draft = step('draft', { context: contextLine }, { 'read-card': card.output, research: research.output, strategy: { approach: { problem: '대화', proposal: '후속', channel: 'LinkedIn' } } }, { ...env, CARD_FOLLOWUP_ELANOUS_BIN: longAsk });
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
}, 30_000);

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
  const recipes = parseYaml(readFileSync(join(installed, 'graphs/recipes.yaml'), 'utf8')) as Record<string, { command: string; timeout_ms: number }>;
  expect(commands).toEqual(['read-card', 'research', 'strategy', 'draft', 'report'].map(id => recipes[id]!.command));
  // Up to four LLM calls (write ⊕ verify, one retry) — 120 s was hit live on 10-01.
  expect(recipes.strategy!.timeout_ms).toBe(300000);
  expect(recipes.draft!.timeout_ms).toBe(300000);
  const report = readFileSync(join(state.statePath.slice(0, -5), 'followup.md'), 'utf8');
  // The report is shown on screens: the CRM line names the file, never the home path.
  expect(report).toContain('파일: crm.csv');
  expect(report).not.toContain(homedir());
  const headings = ['① 사람·회사 분석', '② CRM 한 줄', '③ 타겟 판정', '④ 접근 전략', '⑤ 메일·LinkedIn 초안'];
  expect([...report.matchAll(/^## (.+)$/gm)].slice(0, 5).map(match => match[1])).toEqual(headings);
  for (const heading of ['팔로업 메일', 'LinkedIn 초대 문구', '대화 이어 갈 질문']) expect(report).toContain(`### ${heading}`);
  expect(report).toContain('https://example.test/company');
  expect(report).toContain('가상 행사에서 가상 제품 데모를 짧게 이야기했습니다.');
  const output = JSON.parse(readFileSync(join(state.statePath.slice(0, -5), 'followup.json'), 'utf8')) as Data;
  const finalDraft = output.draft as Data;
  const finalResearch = output.research as Data;
  expect(output.sent).toBe(false);
  expect(output.fit).toMatchObject({ score: null, label: 'unknown' });
  expect(output.approach).toMatchObject({ who: '가상 인물', channel: 'email' });
  expect(output.nextAction).toMatchObject({ what: '후속 연락' });
  expect(report).toContain('- 어떤 문제: 후속 대화');
  expect(report).toContain('- 어떤 제안: 가상 제품 데모');
  expect(report).toContain('- 다음 행동: 후속 연락 · 기한: 다음 주');
  expect(output.crm).toBe(join(state.statePath.slice(0, -5), 'crm.csv'));
  expect(readFileSync(output.crm as string, 'utf8')).toContain('person@example.test');
  expect(report).toContain('offer 입력이 없어 맞음을 판정하지 않았다');
  expect(readFileSync(join(bin, 'elanous.calls'), 'utf8')).not.toContain('--test');
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
  // Real codex reads every argument after `-i` as an image, so the prompt must come first and `-i <image>` last.
  const codexCall = readFileSync(calls, 'utf8').trim().split('\n')[0]!;
  expect(codexCall.startsWith('exec --skip-git-repo-check ')).toBe(true);
  expect(codexCall.endsWith(`-i ${image}`)).toBe(true);
  expect(readFileSync(join(bin, 'elanous.calls'), 'utf8')).toContain('--limit 5 가상 회사');
  expect(readFileSync(join(bin, 'elanous.calls'), 'utf8')).toContain('--limit 5 가상 인물 가상 회사');
  const crm = output.crm as string;
  const withOffer = await runGraph(join(installed, 'graphs/card-followup.yaml'), {
    input: { image, context: contextLine, sender: '가상 발신자', offer: '가상 회사 대상 제품 데모', crm },
    deps: { root: join(temp, 'offer-state'), runBash: async (command, opts) => {
      const response = spawnSync('/bin/bash', ['-c', command], { cwd: elsewhere, encoding: 'utf8', env: { ...opts.env, PATH: `${bin}:${process.env.PATH}`, CARD_FOLLOWUP_CODEX_BIN: join(bin, 'codex'), CARD_FOLLOWUP_ELANOUS_BIN: join(bin, 'elanous') } });
      return { stdout: response.stdout, stderr: response.stderr, exitCode: response.status ?? 1 };
    } },
  });
  expect(withOffer.status).toBe('done');
  const offered = JSON.parse(readFileSync(join(withOffer.statePath.slice(0, -5), 'followup.json'), 'utf8')) as Data;
  expect(offered.fit).toMatchObject({ score: 85, label: 'high' });
  expect(offered.crm).toBe(crm);
  expect(offered.sent).toBe(false);
  const rows = readFileSync(crm, 'utf8').trim().split('\n');
  expect(rows).toHaveLength(2);
  expect(rows[1]).toContain(',85,high,');
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

test('strategy uses offer and a custom local CRM path; drafts receive the chosen approach', () => {
  const temp = mkdtempSync(join(tmpdir(), 'card-offer-'));
  try {
    const fake = join(temp, 'elanous');
    const crm = join(temp, 'contacts.csv');
    const contextLine = '가상 행사에서 만났습니다.';
    const body = `${contextLine} ${'후속 대화를 이어가고 가상 제품 데모를 함께 검토하고 싶습니다. '.repeat(4)}`;
    fakeElanous(fake, [{ subject: '데모 제안', body, linkedin: '데모를 논의하고 싶습니다.', question: '언제 이야기를 나눌까요?' }]);
    const card = { card: { name: '가상 인물', company: '가상 회사', email: 'person@example.test', language: 'ko' } };
    const research = { sources: [{ title: '가상 회사 소개', url: 'https://example.test/company', snippet: '소개' }] };
    const env = { CARD_FOLLOWUP_ELANOUS_BIN: fake };
    const strategy = step('strategy', { context: contextLine, offer: '가상 제품은 고객을 위한 서비스', crm }, { 'read-card': card, research }, env);
    expect(strategy.output.outcome).toBe('ok');
    expect(strategy.output.fit).toMatchObject({ score: 85, label: 'high', reasons: [{ basis: 'offer' }, { basis: 'S1' }, { basis: 'card' }] });
    expect(strategy.output.crm).toBe(crm);
    expect(strategy.output.crmRow).toMatchObject({ fit_score: '85', fit_label: 'high', interest: '후속 대화', next_action: '후속 연락' });
    expect(readFileSync(crm, 'utf8')).toContain('person@example.test');
    const relativeCrm = step('strategy', { context: contextLine, crm: 'contacts.csv' }, { 'read-card': card, research }, env);
    expect(relativeCrm.output).toMatchObject({ outcome: 'fail', reason: 'crm: 절대 경로 필요' });
    const draft = step('draft', { context: contextLine }, { 'read-card': card, research, strategy: strategy.output }, env);
    expect(draft.output.outcome).toBe('ok');
    const calls = readFileSync(`${fake}.calls`, 'utf8');
    expect(calls).toContain('"problem":"후속 대화"');
    expect(calls).toContain('"proposal":"가상 제품 데모"');
    expect(calls).toContain('"channel":"email"');
    expect(calls).not.toContain('--test');
    // The approach is guidance, not an exemption from the sentence-level source verifier.
    const unsupported = join(temp, 'unsupported-approach');
    fakeElanous(unsupported, [{ subject: '데모 제안', body: `${contextLine} 귀사는 세계 최대 기업입니다. ${'후속 대화를 제안드립니다. '.repeat(6)}`, linkedin: '초대', question: '질문' }]);
    const rejected = step('draft', { context: contextLine }, { 'read-card': card, research, strategy: strategy.output }, { CARD_FOLLOWUP_ELANOUS_BIN: unsupported });
    expect(rejected.output).toMatchObject({ outcome: 'fail' });
    expect(rejected.output.reason).toContain('출처 없는 회사 사실');
    expect(readFileSync(`${unsupported}.count`, 'utf8')).toBe('xxx');
    rmSync(rejected.temp, { recursive: true, force: true });
    rmSync(strategy.temp, { recursive: true, force: true });
    rmSync(relativeCrm.temp, { recursive: true, force: true });
    rmSync(draft.temp, { recursive: true, force: true });
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('report refuses missing strategy fields instead of writing an incomplete plan', () => {
  const temp = mkdtempSync(join(tmpdir(), 'card-missing-strategy-'));
  try {
    const input = { outDir: temp };
    const outputs = { 'read-card': { card: { name: '가상 인물' } }, research: { sources: [] },
      strategy: { fit: { score: null, label: 'unknown', reasons: [] }, crm: join(temp, 'crm.csv'), crmRow: { fit_label: 'unknown' },
        approach: { who: '가상 인물', problem: '후속 대화', proposal: '데모', channel: 'email' }, nextAction: { what: '메일 작성', due: '내일' } },
      draft: { subject: '제목', linkedin: '초대', question: '질문' } };
    const result = step('report', input, outputs, {});
    expect(result.output).toMatchObject({ outcome: 'fail', reason: '전략 없음' });
    expect(() => readFileSync(join(temp, 'followup.md'), 'utf8')).toThrow();
    rmSync(result.temp, { recursive: true, force: true });
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('a card language read as «English» drafts in en instead of failing', () => {
  const temp = mkdtempSync(join(tmpdir(), 'card-language-'));
  const contextLine = 'We met at the event.';
  const fake = join(temp, 'elanous');
  fakeElanous(fake, [{ subject: 'Follow-up', body: `${contextLine} ${'I enjoyed our talk and would like to continue it soon. '.repeat(3)}`.slice(0, 190), linkedin: 'Nice to meet you.', question: 'What should we explore next?' }]);
  const card = { card: { name: 'Fictional Person', company: 'Fictional Co', email: null, language: 'English' } };
  const result = step('draft', { context: contextLine }, { 'read-card': card, research: { sources: [] } }, { CARD_FOLLOWUP_ELANOUS_BIN: fake });
  expect(result.output.outcome).toBe('ok');
  expect(result.output.language).toBe('en');
  rmSync(result.temp, { recursive: true, force: true });
  rmSync(temp, { recursive: true, force: true });
});

test('research summary comes only from results that name the card company or its site', () => {
  const temp = mkdtempSync(join(tmpdir(), 'card-research-'));
  const fake = join(temp, 'elanous');
  fakeElanous(fake, [], '- [Vital AI](https://www.vital.ai/)\n- [Elanvital AI home](https://elanvital.ai/)\n- [Other news](https://example.test/news)');
  const card = { card: { name: 'Jiwoo Han', company: 'Elanvital AI', url: 'elanous.ai', language: 'en' } };
  const hit = step('research', {}, { 'read-card': card }, { CARD_FOLLOWUP_ELANOUS_BIN: fake });
  expect(hit.output.summary).toBe('Elanvital AI home');
  expect((hit.output.sources as { url: string }[])[0]!.url).toBe('https://elanvital.ai/');
  fakeElanous(fake, [], '- [Vital AI](https://www.vital.ai/)\n- [Other news](https://example.test/news)');
  const miss = step('research', {}, { 'read-card': card }, { CARD_FOLLOWUP_ELANOUS_BIN: fake });
  expect(miss.output.summary).toBeNull();
  for (const r of [hit, miss]) rmSync(r.temp, { recursive: true, force: true });
  rmSync(temp, { recursive: true, force: true });
});

test('sources keep only the card company or site — no same-name strangers, no logo rows', () => {
  const temp = mkdtempSync(join(tmpdir(), 'card-sources-'));
  const fake = join(temp, 'elanous');
  fakeElanous(fake, [], [
    '- [Acme Cloud home](https://acme.example/)',
    '-   [![](https://img.example/acme-logo.svg)](https://img.example/acme-logo.svg)',
    '- [Acme logo](https://cdn.example/acme.png)',
    '- [Jordan Park — Portfolio](https://jordan-park-portfolio.example/)',
    '- [Jordan Park - IMDb](https://imdb.example/name/nm1)',
    '- [Acme Cloud pricing](https://acme.example/pricing)',
    '- [Home — Jordan Park](https://jordan.acme-hosting.example/)',
    '- [Jordan Park — Acme Cloud engineer](https://social.example/in/jordan-park)',
    '- [Portfolio](https://someone.acme.example.app/)',
    '- https://acmecloud-fan.hosting.example/',
  ].join('\n'));
  const card = { card: { name: 'Jordan Park', company: 'Acme Cloud', url: 'acme.example', language: 'en' } };
  const result = step('research', {}, { 'read-card': card }, { CARD_FOLLOWUP_ELANOUS_BIN: fake });
  expect((result.output.sources as { url: string }[]).map(s => s.url)).toEqual(['https://acme.example/', 'https://acme.example/pricing']);
  expect(result.output.news).toEqual(['Acme Cloud pricing']);
  expect(result.output.dropped).toBe(6);
  rmSync(result.temp, { recursive: true, force: true });
  rmSync(temp, { recursive: true, force: true });
});

test('research also searches the card site — the company name alone ranks other companies above it', () => {
  const temp = mkdtempSync(join(tmpdir(), 'card-site-query-'));
  const fake = join(temp, 'elanous');
  fakeElanous(fake, [], '- [Elanvital AI](https://elanvital.ai/)');
  const withSite = step('research', {}, { 'read-card': { card: { name: 'Joosung Jin', company: 'Elanvital AI', url: 'https://www.elanvital.ai/', language: 'en' } } }, { CARD_FOLLOWUP_ELANOUS_BIN: fake });
  const calls = readFileSync(`${fake}.calls`, 'utf8').trim().split('\n').filter(l => l.startsWith('research'));
  // queries run in parallel, so the call order is not fixed
  expect(calls.sort()).toEqual(['research --json --limit 5 Elanvital AI', 'research --json --limit 5 Joosung Jin Elanvital AI', 'research --json --limit 5 elanvital.ai'].sort());
  rmSync(`${fake}.calls`, { force: true });
  const noSite = step('research', {}, { 'read-card': { card: { name: 'Joosung Jin', company: 'Elanvital AI', language: 'en' } } }, { CARD_FOLLOWUP_ELANOUS_BIN: fake });
  expect(readFileSync(`${fake}.calls`, 'utf8').trim().split('\n').filter(l => l.startsWith('research')).sort()).toEqual(['research --json --limit 5 Elanvital AI', 'research --json --limit 5 Joosung Jin Elanvital AI']);
  for (const r of [withSite, noSite]) rmSync(r.temp, { recursive: true, force: true });
  rmSync(temp, { recursive: true, force: true });
});

test('an English card translates a Korean meeting note instead of pasting it into the mail', () => {
  const temp = mkdtempSync(join(tmpdir(), 'card-cross-language-'));
  const contextLine = '마케터의 밤에서 인사';
  const english = 'Great to meet you at Marketers Night. I would love to show a short demo that takes one request from a single line to a finished result, if useful.';
  const fake = join(temp, 'elanous');
  fakeElanous(fake, [
    { subject: 'Follow-up', body: `Hi, ${contextLine}. ${english}`, linkedin: 'Nice to meet you.', question: 'What should we try first?' },
    { subject: 'Follow-up', body: english, linkedin: 'Nice to meet you at Marketers Night.', question: 'What should we try first?' },
  ]);
  const card = { card: { name: 'Fictional Person', company: 'Fictional Co', email: null, language: 'en' } };
  const result = step('draft', { context: contextLine }, { 'read-card': card, research: { sources: [] } }, { CARD_FOLLOWUP_ELANOUS_BIN: fake });
  expect(result.output.outcome).toBe('ok');
  expect(String(result.output.body)).toBe(english);
  expect(/[가-힣]/.test(String(result.output.body))).toBe(false);
  rmSync(result.temp, { recursive: true, force: true });
  rmSync(temp, { recursive: true, force: true });
});
