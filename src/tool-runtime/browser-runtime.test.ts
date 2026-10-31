import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserActionDeps, BrowserActionResult } from '../harness/browser-act.js';
import { dispatchBrowserHand } from './browser-hand-runtime.js';

const ISSUE = 'c0ffee00-0000-4000-8000-000000000001';
const PERSONA = { personaId: 'browser-demo', displayName: 'Browser demo', actionHosts: ['ir.example.test'] };
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function capture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'browser-hand-test-'));
  dirs.push(dir);
  const path = join(dir, 'capture.png');
  writeFileSync(path, Buffer.from('png fixture'));
  return path;
}

function actionWithCapture(request: { url: string; target: string }, deps: BrowserActionDeps | undefined, path: string): BrowserActionResult {
  deps?.observe?.('executed', { attachmentRef: path, captureOutcome: 'ok' });
  return { ok: true, url: request.url, target: request.target, observed: { coordinates: null, captureOutcome: 'ok' } };
}

describe('BrowserHand (DEMO1104-BROWSER-INTERACTION)', () => {
  test('fails closed before CDP when not armed', async () => {
    let calls = 0;
    const result = await dispatchBrowserHand({ url: 'https://example.test', target: 'body', armed: false, linearSubtaskId: ISSUE }, undefined, {
      confirmHuman: async () => true,
      browserAct: async () => { calls += 1; return { ok: true, url: '', target: '' } as BrowserActionResult; },
      readPageText: async () => '',
    });
    expect(result).toMatchObject({ ok: false, reason: 'unarmed' });
    expect(calls).toBe(0);
  });

  test('requires a separate human confirmation before an armed request can inspect or navigate', async () => {
    let inspections = 0;
    let actions = 0;
    const result = await dispatchBrowserHand({
      url: 'https://ir.example.test/report', target: 'body', armed: true,
      linearSubtaskId: ISSUE, persona: PERSONA.personaId,
    }, undefined, {
      confirmHuman: async () => false,
      readPageText: async () => { inspections += 1; return ''; },
      browserAct: async request => { actions += 1; return { ok: true, url: request.url, target: request.target }; },
    });
    expect(result).toMatchObject({ ok: false, reason: 'human-approval-required' });
    expect(inspections).toBe(0);
    expect(actions).toBe(0);
  });

  test('uses the attached-CDP safety function, uploads its captured artifact and attaches to the named Linear subtask', async () => {
    const path = capture();
    const calls: unknown[] = [];
    const result = await dispatchBrowserHand({ url: 'https://ir.example.test/report', target: 'body', armed: true, linearSubtaskId: ISSUE, persona: PERSONA.personaId }, undefined, {
      confirmHuman: async () => true,
      browserAct: async (request, deps) => {
        calls.push({ request, deps });
        return actionWithCapture(request, deps, path);
      },
      getApiKey: async () => 'test-key',
      resolvePersona: async () => PERSONA,
      readPageText: async () => '',
      upload: async input => { calls.push(['upload', input]); return 'https://uploads.example.test/capture.png'; },
      attach: async input => { calls.push(['attach', input]); return 'attachment-1'; },
    });

    expect(result).toMatchObject({ ok: true, captureUrl: 'https://uploads.example.test/capture.png', attachmentId: 'attachment-1' });
    expect(calls[0]).toMatchObject({ request: { armed: true, url: 'https://ir.example.test/report', target: 'body' }, deps: { reversibilityPolicy: 'navigation-only' } });
    expect(calls[1]).toEqual(['upload', expect.objectContaining({ apiKey: 'test-key', filename: 'capture.png', contentType: 'image/png', body: Buffer.from('png fixture') })]);
    expect(calls[2]).toEqual(['attach', expect.objectContaining({ apiKey: 'test-key', issueId: ISSUE, url: 'https://uploads.example.test/capture.png' })]);
  });

  test('a login/paywall failure detours once to an allowed alternate and records the existing repair-node branch', async () => {
    const path = capture();
    const urls: string[] = [];
    const repairNodes: unknown[] = [];
    const result = await dispatchBrowserHand({
      url: 'https://ir.example.test/blocked', target: 'body', armed: true,
      linearSubtaskId: ISSUE, persona: PERSONA.personaId, alternateUrl: 'https://archive.example.test/report',
    }, undefined, {
      confirmHuman: async () => true,
      browserAct: async (request, deps) => {
        urls.push(request.url);
        return actionWithCapture(request, deps, path);
      },
      browserActDeps: { observe: (event, data) => { if (event === 'repair-node') repairNodes.push(data); } },
      getApiKey: async () => 'test-key',
      resolvePersona: async () => ({ ...PERSONA, actionHosts: ['ir.example.test', 'archive.example.test'] }),
      readPageText: async url => url.includes('/blocked') ? 'Login required to continue' : 'Public article content',
      upload: async () => 'https://uploads.example.test/capture.png',
      attach: async () => 'attachment-1',
    });

    expect(urls).toEqual(['https://archive.example.test/report']);
    expect(result).toMatchObject({
      ok: true, blocked: true, detoured: true,
      repairNode: { branch: 'ASIDE-HAND-NODE·BROWSER-ROUNDTRIP-ASIDE', outcome: 'detoured', graphEvent: { type: 'node-added', kind: 'hand', decider: 'browser-hand' } },
    });
    expect(repairNodes).toHaveLength(1);
  });

  test('a browser-act login failure may detour once when read-only inspection is unavailable', async () => {
    const path = capture();
    const urls: string[] = [];
    const result = await dispatchBrowserHand({
      url: 'https://ir.example.test/blocked', target: 'body', armed: true,
      linearSubtaskId: ISSUE, persona: PERSONA.personaId, alternateUrl: 'https://archive.example.test/report',
    }, undefined, {
      confirmHuman: async () => true,
      browserAct: async (request, deps) => {
        urls.push(request.url);
        if (urls.length === 1) return { ok: false, url: request.url, target: request.target, reason: 'execution-failed', error: 'login required to continue' };
        return actionWithCapture(request, deps, path);
      },
      getApiKey: async () => 'test-key',
      resolvePersona: async () => ({ ...PERSONA, actionHosts: ['ir.example.test', 'archive.example.test'] }),
      readPageText: async () => undefined,
      upload: async () => 'https://uploads.example.test/capture.png',
      attach: async () => 'attachment-1',
    });
    expect(urls).toEqual(['https://ir.example.test/blocked', 'https://archive.example.test/report']);
    expect(result).toMatchObject({ ok: true, blocked: true, detoured: true, repairNode: { outcome: 'detoured' } });
  });

  test('records the attempted alternate URL when its action fails', async () => {
    const urls: string[] = [];
    const result = await dispatchBrowserHand({
      url: 'https://ir.example.test/blocked', target: 'body', armed: true,
      linearSubtaskId: ISSUE, persona: PERSONA.personaId, alternateUrl: 'https://archive.example.test/report',
    }, undefined, {
      confirmHuman: async () => true,
      browserAct: async request => {
        urls.push(request.url);
        return { ok: false, url: request.url, target: request.target, reason: 'execution-failed', error: urls.length === 1 ? 'login required' : 'click failed' };
      },
      resolvePersona: async () => ({ ...PERSONA, actionHosts: ['ir.example.test', 'archive.example.test'] }),
      readPageText: async () => undefined,
    });
    expect(urls).toEqual(['https://ir.example.test/blocked', 'https://archive.example.test/report']);
    expect(result).toMatchObject({
      ok: false, detoured: true,
      repairNode: { detourUrl: 'https://archive.example.test/report', outcome: 'detour-failed' },
    });
  });

  test('keeps the chosen alternate URL and attempt flag when pre-inspection found a blocker but the action fails', async () => {
    const urls: string[] = [];
    const result = await dispatchBrowserHand({
      url: 'https://ir.example.test/blocked', target: 'body', armed: true,
      linearSubtaskId: ISSUE, persona: PERSONA.personaId, alternateUrl: 'https://archive.example.test/report',
    }, undefined, {
      confirmHuman: async () => true,
      browserAct: async request => {
        urls.push(request.url);
        return { ok: false, url: request.url, target: request.target, reason: 'execution-failed', error: 'click failed' };
      },
      resolvePersona: async () => ({ ...PERSONA, actionHosts: ['ir.example.test', 'archive.example.test'] }),
      readPageText: async url => url.includes('/blocked') ? 'Login required' : 'Public article',
    });
    expect(urls).toEqual(['https://archive.example.test/report']);
    expect(result).toMatchObject({
      ok: false, detoured: true,
      repairNode: { detourUrl: 'https://archive.example.test/report', outcome: 'detour-failed' },
    });
  });

  test('only reflects an explicit “include this too” selection on the same subtask', async () => {
    const path = capture();
    const calls: unknown[] = [];
    const result = await dispatchBrowserHand({
      url: 'https://ir.example.test/report', target: 'body', armed: true, linearSubtaskId: ISSUE,
      persona: PERSONA.personaId, includeThisToo: true, selection: { text: 'Revenue rose 12%', tab: 'Q3 filing' },
    }, undefined, {
      confirmHuman: async () => true,
      browserAct: async (request, deps) => actionWithCapture(request, deps, path),
      getApiKey: async () => 'test-key',
      resolvePersona: async () => PERSONA,
      readPageText: async () => '',
      upload: async () => 'https://uploads.example.test/capture.png',
      attach: async () => 'attachment-1',
      reflectSelection: async input => { calls.push(input); return true; },
    });
    expect(result).toMatchObject({ ok: true, selectionReflected: true });
    expect(calls).toEqual([{ issueId: ISSUE, body: '이것도 반영: Q3 filing — Revenue rose 12%' }]);
  });

  test('does not report success or reflect a selection when browser-act produced no screenshot artifact', async () => {
    let reflected = false;
    const result = await dispatchBrowserHand({
      url: 'https://ir.example.test/report', target: 'body', armed: true, linearSubtaskId: ISSUE,
      persona: PERSONA.personaId, includeThisToo: true, selection: { text: 'Revenue rose 12%' },
    }, undefined, {
      confirmHuman: async () => true,
      browserAct: async request => ({ ok: true, url: request.url, target: request.target, observed: { coordinates: null, captureOutcome: 'error' } }),
      resolvePersona: async () => PERSONA,
      readPageText: async () => '',
      reflectSelection: async () => { reflected = true; return true; },
    });
    expect(result).toMatchObject({ ok: false, reason: 'capture-missing' });
    expect(reflected).toBe(false);
  });

  test('does not navigate before a persona host boundary authorizes the entry URL', async () => {
    let acted = false;
    const result = await dispatchBrowserHand({
      url: 'https://outside.example.test/report', target: 'body', armed: true, linearSubtaskId: ISSUE, persona: PERSONA.personaId,
    }, undefined, {
      confirmHuman: async () => true,
      resolvePersona: async () => PERSONA,
      readPageText: async () => '',
      browserAct: async request => { acted = true; return { ok: true, url: request.url, target: request.target }; },
    });
    expect(result).toMatchObject({ ok: false, reason: 'host-boundary-blocked' });
    expect(acted).toBe(false);
  });

  test('a blocked source without an allowed alternate fails closed and emits a failed repair node', async () => {
    let actions = 0;
    const nodes: unknown[] = [];
    const result = await dispatchBrowserHand({
      url: 'https://ir.example.test/paywalled', target: 'body', armed: true, linearSubtaskId: ISSUE, persona: PERSONA.personaId,
      alternateUrl: 'https://outside.example.test/open',
    }, undefined, {
      confirmHuman: async () => true,
      resolvePersona: async () => PERSONA,
      readPageText: async () => 'Subscribe to continue',
      browserAct: async () => { actions += 1; return { ok: true, url: '', target: '' }; },
      browserActDeps: { observe: (event, data) => { if (event === 'repair-node') nodes.push(data); } },
    });
    expect(result).toMatchObject({ ok: false, blocked: true, detoured: false, reason: 'blocked-source-no-safe-alternate', repairNode: { outcome: 'detour-failed' } });
    expect(actions).toBe(0);
    expect(nodes).toHaveLength(1);
  });
});
