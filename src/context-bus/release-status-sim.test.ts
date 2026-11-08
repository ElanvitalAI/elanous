import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchReleaseStatus } from '../domains/release-tool.js';
import { buildDashboardSlashRegistry, type DashboardSlashContext } from '../dashboard/slash-runtime/dashboard-handlers.js';
import { setElanousConfigDir, resetElanousConfigDir } from '../elanous-config-dir.js';
import { writeSchedule } from '../release-loop/feature-store.js';
import { enableLandingFreeze } from '../release-loop/landing-freeze.js';
import { contextNow, releaseFactSummary, type ContextFact, type ContextNowDeps } from './context-now.js';
import { renderTelegramNow, renderTuiNow } from './context-now-surfaces.js';
import { defaultTelegramCommands, parseTelegramSlash } from '../telegram-commands.js';

async function telegramReleaseReply(deps: ContextNowDeps): Promise<string> {
  const command = parseTelegramSlash('/release', defaultTelegramCommands(deps));
  if (command.kind !== 'match') throw new Error('Telegram /release was not registered');
  return String(await command.cmd.handler(command.args, {} as never, {} as never));
}

async function tuiReleaseReply(deps: ContextNowDeps): Promise<string[]> {
  const lines: string[] = [];
  const ctx = { pushChatLine: (line: string) => lines.push(line) } as unknown as DashboardSlashContext;
  await buildDashboardSlashRegistry(deps).dispatch('release', [], ctx);
  return lines;
}

test('RLA-CONTEXT-BUS-RELEASE-STATUS: Telegram, TUI and release_status share one simulated release fact', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-status-bus-sim-'));
  const previous = { config: process.env.ELANOUS_CONFIG_DIR, state: process.env.ELANOUS_STATE_DIR };
  process.env.ELANOUS_CONFIG_DIR = root;
  process.env.ELANOUS_STATE_DIR = root;
  setElanousConfigDir(root);
  const at = '2026-11-06T03:00:00.000Z';
  const version = '9.8.7';
  const runId = 'release-sim-1';
  try {
    const runs = join(root, 'graph-runs', 'release-loop');
    mkdirSync(runs, { recursive: true });
    writeFileSync(join(runs, `${runId}.json`), JSON.stringify({ graphId: 'release-loop', runId, startedAt: at,
      status: 'running', path: ['cut', 'gate'], currentNode: { nodeId: 'gate', startedAt: at },
      input: { version, publishAt: '2026-11-06T08:00:00.000Z' }, nodes: [
        { nodeId: 'cut', ok: true, exit: 0, executed: true, output: { outcome: 'ok' },
          waiver: { reason: 'accepted simulated issue', approvedBy: 'OP', at } },
      ] }) + '\n');
    const shards = join(root, 'release', version, 'gate-logs', 'cut');
    const shardsFile = join(shards, 'shards.json');
    mkdirSync(shards, { recursive: true });
    writeFileSync(shardsFile, JSON.stringify({ v: 1, version, updatedAt: at,
      verdict: { introduced: 2, preexisting: 1 }, shards: [
        { id: 'pod-0', state: 'done', rc: 0, plannedMin: 1 },
        { id: 'pod-1', state: 'running', startedAt: at, plannedMin: 10 },
      ] }) + '\n');
    mkdirSync(join(root, 'release', version), { recursive: true });
    const gateVerdictPath = join(root, 'release', version, 'gate-verdict.json');
    writeFileSync(gateVerdictPath, JSON.stringify({ version, commit: 'a'.repeat(40), outcome: 'regression',
      introduced: ['a', 'b'], knownEnv: [], preexisting: ['old'], loadFlaky: [], baselineReceipt: {
        schema: 2, valid: true, reason: 'complete', version, commit: 'a'.repeat(40), head40: 'a'.repeat(40),
        graphSha: null, recipeSha: null, envFingerprint: 'b'.repeat(64), imageDigest: null, executionIdentity: null, files: 2, shards: 1,
      } }) + '\n');
    writeSchedule(version, { cutAt: at, publishAt: '2026-11-06T08:00:00.000Z' }, 'sim', root);
    enableLandingFreeze({ reason: 'simulated emergency hold', by: 'OP' }, root, new Date(at));

    const deps: ContextNowDeps = { now: () => new Date(at), version: () => version,
      checklist: v => ({ version: v, released: '', dev: v, history: [], items: [] }), decisions: () => [],
      seatEntries: () => [], events: () => [], runningRuns: () => [], lateSchedules: () => null };
    const answer = contextNow({ topic: '발행 상황' }, deps);
    const release = answer.facts.find(fact => fact.kind === 'release');
    expect(release).toMatchObject({ kind: 'release', version, phase: 'gate', currentNode: 'gate',
      nextAction: 'gate 완료 대기', gateProgress: { completed: 1, total: 2 },
      regressions: { introduced: 2, preexisting: 1 }, receiptStatus: 'valid',
      waiverEvents: ['cut: accepted simulated issue · 승인 OP'], emergencySwitch: { state: 'unknown' },
      landingFreeze: { state: 'on', reason: 'simulated emergency hold' },
      expectedPublishAt: '2026-11-06T08:00:00.000Z' });

    const telegram = await telegramReleaseReply(deps);
    const tuiLines = await tuiReleaseReply(deps);
    const cli = dispatchReleaseStatus({ topic: 'ops' }, { contextNow: options => contextNow(options, deps) });

    expect(telegram).toBe(renderTelegramNow(answer));
    expect(tuiLines).toEqual(renderTuiNow(answer));
    expect(cli.structured.facts).toContainEqual(release);
    for (const output of [String(telegram), tuiLines.join('\n'), cli.text]) {
      for (const token of ['gate', '1/2', '도입 2', '기존 1', '영수증 valid', '면제 cut', '긴급 전환 unknown', '착지 동결 on', '08:00',
        'run=elanous://graph-runs/release-loop/release-sim-1',
        'gate-progress=elanous://release/9.8.7/gate-shards',
        'regressions=elanous://release/9.8.7/gate-shards',
        'receipt-status=elanous://release/9.8.7/gate-verdict',
        'waivers=elanous://graph-runs/release-loop/release-sim-1',
        'landing-freeze=elanous://landing-freeze',
        'expected-publish-at=elanous://release/9.8.7/schedule']) {
        expect(output).toContain(token);
      }
    }

    writeSchedule(version, { cutAt: at, publishAt: '2026-11-06T09:00:00.000Z' }, 'sim-update', root);
    const rescheduled = contextNow({ topic: '발행 상황' }, deps).facts.find(fact => fact.kind === 'release');
    expect(rescheduled).toMatchObject({ expectedPublishAt: '2026-11-06T09:00:00.000Z' });
    expect(dispatchReleaseStatus({ topic: 'ops' }, { contextNow: options => contextNow(options, deps) }).text).toContain('09:00');
    expect(await telegramReleaseReply(deps)).toContain('09:00');
    expect((await tuiReleaseReply(deps)).join('\n')).toContain('09:00');

    rmSync(join(runs, `${runId}.json`));
    const withoutRun = contextNow({ topic: '발행 상황' }, deps).facts.find(fact => fact.kind === 'release');
    expect(withoutRun).toMatchObject({ status: 'no-run', node: '런 없음', expectedPublishAt: '2026-11-06T09:00:00.000Z',
      landingFreeze: { state: 'on' } });
    expect(withoutRun?.sourceRefs?.some(ref => ref.signal === 'expected-publish-at' && ref.source === 'elanous://release/9.8.7/schedule')).toBe(true);
    expect(withoutRun?.sourceRefs?.some(ref => ref.signal === 'landing-freeze' && ref.source === 'elanous://landing-freeze')).toBe(true);
    expect(dispatchReleaseStatus({ topic: 'ops' }, { contextNow: options => contextNow(options, deps) }).text).toContain('no-run');
    expect(await telegramReleaseReply(deps)).toContain('no-run');
    expect((await tuiReleaseReply(deps)).join('\n')).toContain('no-run');

    const otherDefaultDeps = { ...deps, version: () => '9.8.6' };
    const defaultGateDir = join(root, 'release', '9.8.6', 'gate-logs', 'cut');
    mkdirSync(defaultGateDir, { recursive: true });
    writeFileSync(join(defaultGateDir, 'shards.json'), JSON.stringify({ v: 1, version: '9.8.6', updatedAt: at, shards: [] }) + '\n');
    writeSchedule('9.8.8', { cutAt: at, publishAt: '2026-11-06T10:00:00.000Z' }, 'sim-other', root);
    const discoveredOtherVersion = contextNow({ topic: '발행 상황' }, otherDefaultDeps).facts.find(fact => fact.kind === 'release' && fact.version === '9.8.7');
    expect(discoveredOtherVersion).toMatchObject({ version: '9.8.7', status: 'no-run' });
    const otherVersionReleases = contextNow({ topic: '발행 상황' }, otherDefaultDeps).facts.filter(fact => fact.kind === 'release');
    expect(otherVersionReleases.map(fact => fact.version)).toEqual(['9.8.6', '9.8.7', '9.8.8']);
    const otherVersionCli = dispatchReleaseStatus({ topic: 'ops' }, { contextNow: options => contextNow(options, otherDefaultDeps) }).text;
    const otherVersionTelegram = await telegramReleaseReply(otherDefaultDeps);
    const otherVersionTui = (await tuiReleaseReply(otherDefaultDeps)).join('\n');
    for (const output of [otherVersionCli, otherVersionTelegram, otherVersionTui]) {
      expect(output).toContain('9.8.6 · 런 없음');
      expect(output).toContain('9.8.8 · 런 없음');
      expect(output).toContain('10:00');
      expect(output.length).toBeLessThan(4096);
    }

    writeFileSync(join(runs, 'release-old-986.json'), JSON.stringify({ graphId: 'release-loop', runId: 'release-old-986',
      startedAt: '2026-11-06T02:00:00.000Z', status: 'done', path: ['publish'], input: { version: '9.8.6' },
      nodes: [{ nodeId: 'publish', ok: true }] }) + '\n');
    writeFileSync(join(runs, 'release-new-988.json'), JSON.stringify({ graphId: 'release-loop', runId: 'release-new-988',
      startedAt: '2026-11-06T04:00:00.000Z', status: 'running', path: ['gate'], currentNode: { nodeId: 'gate', startedAt: at },
      input: { version: '9.8.8' }, nodes: [] }) + '\n');
    const perVersionRuns = contextNow({ topic: '발행 상황' }, otherDefaultDeps).facts.filter(fact => fact.kind === 'release');
    expect(perVersionRuns.find(fact => fact.version === '9.8.6')).toMatchObject({ status: 'done' });
    expect(perVersionRuns.find(fact => fact.version === '9.8.8')).toMatchObject({ status: 'running', currentNode: 'gate' });

    writeFileSync(join(runs, 'release-unversioned.json'), JSON.stringify({ graphId: 'release-loop', runId: 'release-unversioned',
      startedAt: at, status: 'running', path: ['gate'], currentNode: { nodeId: 'gate', startedAt: at }, input: {}, nodes: [] }) + '\n');
    const separatedUnversioned = contextNow({ topic: '발행 상황' }, otherDefaultDeps).facts.filter(fact => fact.kind === 'release');
    expect(separatedUnversioned.find(fact => fact.version === '판 미기록')).toMatchObject({ status: 'running', currentNode: 'gate' });
    expect(separatedUnversioned.find(fact => fact.version === '9.8.6')?.status).toBe('done');
    expect(separatedUnversioned.find(fact => fact.version === '9.8.7')?.status).toBe('no-run');
    writeFileSync(shardsFile, '{invalid json');
    writeFileSync(gateVerdictPath, JSON.stringify({ version, commit: 'a'.repeat(40), outcome: 'ok',
      introduced: [], knownEnv: [], preexisting: [], loadFlaky: [], baselineReceipt: { schema: 1, valid: true } }) + '\n');
    const incompleteVerdict = contextNow({ topic: '발행 상황' }, deps).facts.find((fact): fact is Extract<ContextFact, { kind: 'release' }> => fact.kind === 'release' && fact.version === version);
    expect(incompleteVerdict?.receiptStatus).toBe('unreadable');
    expect(incompleteVerdict?.regressions).toBeNull();

    const longSummary = releaseFactSummary({ kind: 'release', version, node: 'gate', status: 'running', source: 'test',
      waiverEvents: Array.from({ length: 30 }, (_, i) => `waiver-${i}`), sourceRefs: [], ledgerErrors: [] });
    expect(longSummary).toContain('생략 27 (/release)');
    expect(longSummary.length).toBeLessThanOrEqual(1500);

    rmSync(runs, { recursive: true, force: true });
    writeFileSync(runs, 'not a directory');
    const unavailableReleases = contextNow({ topic: '발행 상황' }, otherDefaultDeps).facts.filter(fact => fact.kind === 'release');
    expect(unavailableReleases.every(fact => fact.status === 'unknown' && fact.phase === '관측 불가')).toBe(true);
    const unavailableCli = dispatchReleaseStatus({ topic: 'ops' }, { contextNow: options => contextNow(options, otherDefaultDeps) }).text;
    const unavailableTelegram = await telegramReleaseReply(otherDefaultDeps);
    const unavailableTui = (await tuiReleaseReply(otherDefaultDeps)).join('\n');
    for (const output of [unavailableCli, unavailableTelegram, unavailableTui]) {
      expect(output).toContain('런 관측 불가');
      expect(output).toContain('런 원장 복구 후 재관측');
      expect(output).toContain('런 목록을 읽을 수 없음');
      expect(output).not.toContain('no-run');
    }

    writeFileSync(shardsFile, '{invalid json');
    const unreadable = contextNow({ topic: '발행 상황' }, deps).facts.find((fact): fact is Extract<ContextFact, { kind: 'release' }> => fact.kind === 'release' && fact.version === version);
    expect(unreadable?.ledgerErrors?.some(error => error.signal === 'gate-shards' && error.reason === '원장 형식 오류')).toBe(true);
    const malformedShardMessage = 'gate-shards (elanous://release/9.8.7/gate-shards): 원장 형식 오류';
    expect(dispatchReleaseStatus({ topic: 'ops' }, { contextNow: options => contextNow(options, deps) }).text).toContain(malformedShardMessage);
    expect(await telegramReleaseReply(deps)).toContain(malformedShardMessage);
    expect((await tuiReleaseReply(deps)).join('\n')).toContain(malformedShardMessage);

    writeFileSync(gateVerdictPath, JSON.stringify({ version, commit: 'a'.repeat(40), outcome: 'ok', baselineReceipt: { valid: 'yes' } }) + '\n');
    const malformedVerdict = contextNow({ topic: '발행 상황' }, deps).facts.find((fact): fact is Extract<ContextFact, { kind: 'release' }> => fact.kind === 'release' && fact.version === version);
    expect(malformedVerdict?.receiptStatus).toBe('unreadable');
    expect(malformedVerdict?.ledgerErrors?.some(error => error.signal === 'gate-verdict' && error.reason === '원장 형식 오류')).toBe(true);
    const malformedVerdictMessage = 'gate-verdict (elanous://release/9.8.7/gate-verdict): 원장 형식 오류';
    expect(dispatchReleaseStatus({ topic: 'ops' }, { contextNow: options => contextNow(options, deps) }).text).toContain(malformedVerdictMessage);
    expect(await telegramReleaseReply(deps)).toContain(malformedVerdictMessage);
    expect((await tuiReleaseReply(deps)).join('\n')).toContain(malformedVerdictMessage);
  } finally {
    resetElanousConfigDir();
    if (previous.config === undefined) delete process.env.ELANOUS_CONFIG_DIR; else process.env.ELANOUS_CONFIG_DIR = previous.config;
    if (previous.state === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = previous.state;
    rmSync(root, { recursive: true, force: true });
  }
});
