import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { NEXT_TUI_INPUT_CONTEXT, resolveNextTuiRoute } from '../../core/registry.js';
import { makeNextTuiAppServices, runNextTuiAppBranchRoute, type NextTuiAppServices } from './index.js';
import type { CredentialSlotStatus } from '../../../nexus/config/secrets/cred-slots.js';

test('/app resolves to the optional app branch and validates the existing app contract', async () => {
  const route = resolveNextTuiRoute('/app check', NEXT_TUI_INPUT_CONTEXT);
  expect(route?.branchModule).toBe('./branches/app/index.js');
  const directory = mkdtempSync(join(tmpdir(), 'next-app-'));
  const chatLines: string[] = [];
  const host = { cwd: directory, chatLines, setChatScrollOffset: () => {} };
  try {
    writeFileSync(join(directory, 'app.yaml'), 'apiVersion: elanous.app/v0\nslug: example\ntitle: Example\nfrontend: { kind: static-export }\n');
    await runNextTuiAppBranchRoute('/app check', host);
    expect(chatLines.join('\n')).toContain('example · Example · app.yaml 유효');
    writeFileSync(join(directory, 'app.yaml'), 'not: an app\n');
    await runNextTuiAppBranchRoute('/app check', host);
    expect(chatLines.at(-1)).toContain('app.yaml:');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('/app simulate sends the real service argv through the isolated CLI boundary', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'next-app-sim-'));
  const chatLines: string[] = [];
  const seen: { args?: readonly string[]; cwd?: string } = {};
  const spawn = ((args: readonly string[], options: { cwd?: string }) => {
    seen.args = args;
    seen.cwd = options.cwd;
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
    queueMicrotask(() => { child.stdout.end('시나리오 | passed\n영수증 | isolated-receipt\n'); child.emit('close', 0); });
    return child as ChildProcess;
  }) as typeof import('../../../instance/spawn-elanous.js').spawnElanous;
  try {
    writeFileSync(join(directory, 'app.yaml'), 'apiVersion: elanous.app/v0\nslug: example\ntitle: Example\nfrontend: { kind: static-export }\n');
    await runNextTuiAppBranchRoute('/app simulate . happy', { cwd: directory, chatLines, setChatScrollOffset: () => {} }, makeNextTuiAppServices(spawn));
    expect(seen.args).toEqual(['--test', 'sim', 'app', directory, '--scenario', 'happy']);
    expect(seen.cwd).toBeUndefined();
    expect(chatLines).toContain('영수증 | isolated-receipt');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('/app uses the existing simulation, lifecycle and secret services without exposing secret values', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'next-app-services-'));
  const chatLines: string[] = [];
  const calls: string[] = [];
  const host = { cwd: directory, chatLines, setChatScrollOffset: () => {} };
  const services: NextTuiAppServices = {
    simulate: async (path, scenario) => { calls.push(`simulate:${path}:${scenario}`); return ['시나리오 | passed', '영수증 | test-receipt']; },
    lifecycle: (slug) => { calls.push(`lifecycle:${slug}`); return { events: [], snapshot: null }; },
    credentialSlots: async () => [
      { id: 'cred:openai.api_key', service: 'openai', label: 'OpenAI', field: 'api_key', setupUrl: '', present: true },
      { id: 'cred:higgsfield.secret', service: 'higgsfield', label: 'Higgsfield', field: 'secret', setupUrl: '', present: false },
    ] as CredentialSlotStatus[],
    appSecretIds: async () => ['app/example/KEY', 'app/other/OTHER'],
  };
  try {
    writeFileSync(join(directory, 'app.yaml'), 'apiVersion: elanous.app/v0\nslug: example\ntitle: Example\nfrontend: { kind: static-export }\ncredentials: [cred:openai.api_key, cred:higgsfield.secret]\n');
    await runNextTuiAppBranchRoute('/app simulate . happy', host, services);
    await runNextTuiAppBranchRoute('/app status .', host, services);
    await runNextTuiAppBranchRoute('/app history .', host, services);
    await runNextTuiAppBranchRoute('/app secrets .', host, services);
    expect(calls).toEqual([`simulate:${directory}:happy`, 'lifecycle:example', 'lifecycle:example']);
    expect(chatLines.join('\n')).toContain('영수증 | test-receipt');
    expect(chatLines.join('\n')).toContain('cred:openai.api_key · 있음');
    expect(chatLines.join('\n')).toContain('cred:higgsfield.secret · 비어 있음');
    expect(chatLines.join('\n')).toContain('앱 전용 비밀 있음: KEY');
    expect(chatLines.join('\n')).not.toContain('OTHER');
    writeFileSync(join(directory, 'app.yaml'), 'apiVersion: elanous.app/v0\nslug: example\ntitle: Example\nfrontend: { kind: static-export }\n');
    chatLines.length = 0;
    await runNextTuiAppBranchRoute('/app secrets .', host, services);
    expect(chatLines).toContain('선언된 공통 자격 슬롯 없음');
    expect(chatLines).toContain('앱 전용 비밀 있음: KEY');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('/app history offers older pages instead of silently discarding events', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'next-app-history-'));
  const chatLines: string[] = [];
  const host = { cwd: directory, chatLines, setChatScrollOffset: () => {} };
  // Source: src/context-bus/context-now-surfaces.ts renderTuiNow displays eight events per page.
  const events = Array.from({ length: 9 }, (_, index) => ({ id: `event-${index}` }));
  const services: NextTuiAppServices = {
    simulate: async () => [],
    lifecycle: () => ({ events: events as unknown as ReturnType<NextTuiAppServices['lifecycle']>['events'], snapshot: null }),
    credentialSlots: async () => [],
    appSecretIds: async () => [],
  };
  try {
    writeFileSync(join(directory, 'app.yaml'), 'apiVersion: elanous.app/v0\nslug: example\ntitle: Example\nfrontend: { kind: static-export }\n');
    await runNextTuiAppBranchRoute('/app history .', host, services);
    expect(chatLines.join('\n')).toContain('이전 기록 1건 · /app history . 2');
    expect(chatLines.join('\n')).not.toContain('event-0');
    chatLines.length = 0;
    await runNextTuiAppBranchRoute('/app history . 2', host, services);
    expect(chatLines.join('\n')).toContain('event-0');
    expect(chatLines.join('\n')).toContain('최신 기록 · /app history . 1');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
