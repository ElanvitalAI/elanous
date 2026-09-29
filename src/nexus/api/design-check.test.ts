// ── GET /v1/design-check — the wire body must preserve WHY, not just WHAT ──
//
// The CLI collapses "nothing missing", "something missing", and "could not
// read a path" into one exit code. A browser panel cannot render from that.
// These tests pin the three things the wire body has to keep distinct, and
// the two-roots rule that lets a daemon inspect a project it does not live in.

import { describe, test, expect } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNexusState } from '../state/state';
import { TabRegistry } from '../state/tab-registry';
import { setUserConfigOverlay } from '../../user-config';
import { NexusEventBus } from './event-bus';
import { startNexusHttpServer } from './http-server';
import { buildDesignCheckView, handleDesignDirectionPost, type DesignCheckRouteDeps, type DesignDirectionRouteDeps } from './design-check';

function overrides(
  repoRoot: string | null,
  files: Record<string, string>,
  dirs: Record<string, string[]>,
  craftDirectory = '/elanous/docs/design/craft',
): Partial<DesignCheckRouteDeps> {
  return {
    repoRoot: () => repoRoot,
    defaultRepo: () => undefined,
    craftDirectory: () => craftDirectory,
    readFile: (path) => {
      const found = files[path];
      if (found === undefined) throw new Error(`ENOENT: ${path}`);
      return found;
    },
    readdir: (path) => {
      const found = dirs[path];
      if (found === undefined) throw new Error(`ENOENT: scandir ${path}`);
      return found;
    },
  };
}

const CRAFT = '/elanous/docs/design/craft';

describe('GET /v1/design-check — healthy repository', () => {
  test('carries all three rulebook lists plus the CLI exit code', () => {
    const body = buildDesignCheckView(overrides(
      '/work/project',
      { '/work/project/DESIGN.md': '## Craft rulebooks\n- color\n' },
      { [CRAFT]: ['color.md', 'typography.md', 'NOTICE.md'] },
    ));

    expect(body.ok).toBe(true);
    expect(body.repoRoot).toBe('/work/project');
    expect(body.repoSource).toBe('cwd');
    expect(body.declaredRulebooks).toEqual(['color']);
    expect(body.unavailableRulebooks).toEqual([]);
    expect(body.availableRulebooks).toEqual(['color', 'typography']);
    expect(body.exitCode).toBe(0);
  });

  test('⭐ the two roots are DIFFERENT — DESIGN.md from the repo, craft/ from elanous', () => {
    // This is the rule `#11793` established. If the route ever resolved the
    // craft directory relative to the inspected repository, a project outside
    // the elanous tree would report every rulebook as unavailable — which is
    // indistinguishable from a genuinely broken DESIGN.md.
    const body = buildDesignCheckView(overrides(
      '/somewhere/else/entirely',
      { '/somewhere/else/entirely/DESIGN.md': '## Craft rulebooks\n- color\n' },
      { [CRAFT]: ['color.md'] },
    ));
    expect(body.ok).toBe(true);
    expect(body.documentPath).toBe('/somewhere/else/entirely/DESIGN.md');
    expect(body.craftDirectory).toBe(CRAFT);
    expect(body.unavailableRulebooks).toEqual([]);
  });

  test('a declared-but-missing rulebook surfaces as data AND as exitCode 1', () => {
    const body = buildDesignCheckView(overrides(
      '/work/project',
      { '/work/project/DESIGN.md': '## Craft rulebooks\n- color\n- ghost\n' },
      { [CRAFT]: ['color.md'] },
    ));
    expect(body.ok).toBe(true);
    expect(body.unavailableRulebooks).toEqual(['ghost']);
    // Both must be present: `ok` says a verdict exists, `exitCode` says the
    // repository is unhealthy. Renderers that only read `ok` would show green.
    expect(body.exitCode).toBe(1);
  });

  test('configured repo takes precedence and supplies the same target to the verdict', () => {
    const checked: Array<string | undefined> = [];
    const body = buildDesignCheckView({
      ...overrides('/daemon', { '/configured/DESIGN.md': '## Craft rulebooks\n- color\n' }, { [CRAFT]: ['color.md'] }),
      defaultRepo: () => '/configured',
      repoRoot: (cwd) => { checked.push(cwd); return cwd ?? '/daemon'; },
    });
    expect(checked).toEqual(['/configured']);
    expect(body.repoRoot).toBe('/configured');
    expect(body.repoSource).toBe('config');
    expect(body.documentPath).toBe('/configured/DESIGN.md');
  });

  test('relative configured repo is rejected before git detection', () => {
    const checked: string[] = [];
    const body = buildDesignCheckView({
      ...overrides('/daemon', {}, {}),
      defaultRepo: () => './project',
      repoRoot: (cwd) => { checked.push(cwd ?? 'daemon'); return '/daemon'; },
    });
    expect(checked).toEqual([]);
    expect(body).toMatchObject({ repoRoot: null, repoSource: 'config', blockedOn: 'no-repository' });
  });

  test('invalid configured repo does not silently fall back to daemon cwd', () => {
    const checked: Array<string | undefined> = [];
    const body = buildDesignCheckView({
      ...overrides('/daemon', {}, {}),
      defaultRepo: () => '/missing',
      repoRoot: (cwd) => { checked.push(cwd); return null; },
    });
    expect(checked).toEqual(['/missing']);
    expect(body).toMatchObject({ repoRoot: null, repoSource: 'config', ok: false, blockedOn: 'no-repository' });
  });
});

describe('GET /v1/design-check — blocked states stay DISTINGUISHABLE', () => {
  test('daemon outside a checkout reports no-repository, not a missing file', () => {
    const body = buildDesignCheckView(overrides(null, {}, {}));
    expect(body.ok).toBe(false);
    expect(body.repoRoot).toBeNull();
    expect(body.repoSource).toBeNull();
    // ⛔ Not 'design-document'. "The daemon is not in a checkout" is a
    // deployment fact; reporting a missing file sends the operator hunting.
    expect(body.blockedOn).toBe('no-repository');
    expect(body.path).toBeNull();
    expect(body.exitCode).toBe(1);
  });

  test('unreadable craft directory names itself', () => {
    const body = buildDesignCheckView(overrides(
      '/work/project',
      { '/work/project/DESIGN.md': '## Craft rulebooks\n- color\n' },
      {},
    ));
    expect(body.ok).toBe(false);
    expect(body.blockedOn).toBe('craft-directory');
    expect(body.path).toBe(CRAFT);
  });

  test('missing DESIGN.md names itself', () => {
    const body = buildDesignCheckView(overrides('/work/project', {}, { [CRAFT]: ['color.md'] }));
    expect(body.ok).toBe(false);
    expect(body.blockedOn).toBe('design-document');
    expect(body.path).toBe('/work/project/DESIGN.md');
  });

  test('the three blocked reasons are pairwise distinct', () => {
    const noRepo = buildDesignCheckView(overrides(null, {}, {}));
    const noDir = buildDesignCheckView(overrides('/r', { '/r/DESIGN.md': 'x' }, {}));
    const noDoc = buildDesignCheckView(overrides('/r', {}, { [CRAFT]: [] }));
    const reasons = [noRepo.blockedOn, noDir.blockedOn, noDoc.blockedOn];
    expect(new Set(reasons).size).toBe(3);
    // …while every one of them is exitCode 1. That collapse is exactly why
    // the wire body cannot be "just the exit code".
    expect([noRepo.exitCode, noDir.exitCode, noDoc.exitCode]).toEqual([1, 1, 1]);
  });
});

describe('GET /v1/design-check — B5 방향', () => {
  test('같은 문서에서 방향을 읽어 «같이» 실어 보낸다', () => {
    const body = buildDesignCheckView(overrides(
      '/work/project',
      { '/work/project/DESIGN.md': '## Craft rulebooks\n\n- color\n\n## Design direction\n\n- elanous-pastel-default\n' },
      { [CRAFT]: ['color.md'] },
    ));
    expect(body.ok).toBe(true);
    const dirs = body.directions as { declared: string | null; unavailable: string | null; available: unknown[] };
    expect(dirs.declared).toBe('elanous-pastel-default');
    expect(dirs.unavailable).toBeNull();
    // ⛔ 두 번째 라우트를 만들지 않았다 — 같은 문서·같은 뿌리 규칙을 쓴다.
    expect(dirs.available.length).toBeGreaterThan(0);
    const available = dirs.available as Array<{ id: string; label: string; source: string; category: string | null; typography: unknown }>;
    expect(available.some((d) => d.source === 'theme' && d.label === d.id && d.category === null)).toBe(true);
    expect(available.some((d) => d.source === 'design-system' && !!d.label && !!d.category && !!d.typography)).toBe(true);
  });

  test('⛔ 방향을 «안 골라도» exitCode 가 0 이다 — 방향은 계약이 아니다', () => {
    const body = buildDesignCheckView(overrides(
      '/work/project',
      { '/work/project/DESIGN.md': '## Craft rulebooks\n\n- color\n' },
      { [CRAFT]: ['color.md'] },
    ));
    const dirs = body.directions as { declared: string | null };
    expect(dirs.declared).toBeNull();
    // 새로 개설된 프로젝트가 «실패»로 보이면 안 된다.
    expect(body.exitCode).toBe(0);
  });

  test('⛔ 모르는 방향을 선언해도 규칙집 판정을 «안 흔든다»', () => {
    const body = buildDesignCheckView(overrides(
      '/work/project',
      { '/work/project/DESIGN.md': '## Craft rulebooks\n\n- color\n\n## Design direction\n\n- ghost\n' },
      { [CRAFT]: ['color.md'] },
    ));
    const dirs = body.directions as { unavailable: string | null };
    expect(dirs.unavailable).toBe('ghost');
    // exitCode 는 규칙집 축만 본다. 섞으면 두 축이 서로를 가린다.
    expect(body.exitCode).toBe(0);
    expect(body.unavailableRulebooks).toEqual([]);
  });
});

describe('POST /v1/design-direction — select in the resolved repository', () => {
  const request = (body: unknown) => new Request('http://localhost/v1/design-direction', {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  });

  test('writes to the configured checkout and logs only a successful selection', async () => {
    const writes: Array<[string, string]> = [];
    const logs: Array<[string, string]> = [];
    const response = await handleDesignDirectionPost(request({ id: 'bold' }), {
      defaultRepo: () => '/project',
      repoRoot: (cwd) => cwd ?? '/daemon',
      applyDirection: (path, id) => {
        writes.push([path, id]);
        return { ok: true, documentPath: path, direction: id };
      },
      logSelection: (root, id) => { logs.push([root, id]); },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, repoRoot: '/project', repoSource: 'config', direction: 'bold' });
    expect(writes).toEqual([['/project/DESIGN.md', 'bold']]);
    expect(logs).toEqual([['/project', 'bold']]);
  });

  test('invalid body and absent repository do not write or log', async () => {
    let writes = 0;
    const deps: Partial<DesignDirectionRouteDeps> = {
      defaultRepo: () => '/missing', repoRoot: () => null,
      applyDirection: () => { writes++; throw new Error('should not write'); },
      logSelection: () => { throw new Error('should not log'); },
    };
    expect((await handleDesignDirectionPost(request({ id: '' }), deps)).status).toBe(400);
    expect((await handleDesignDirectionPost(new Request('http://localhost/v1/design-direction', { method: 'POST', body: '{' }), deps)).status).toBe(400);
    const missing = await handleDesignDirectionPost(request({ id: 'bold' }), deps);
    expect(missing.status).toBe(409);
    expect(await missing.json()).toMatchObject({ reason: 'no-repository', repoSource: 'config' });
    expect(writes).toBe(0);
  });

  test('HTTP dispatcher requires owner authorization before parsing or writing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'design-direction-http-'));
    const documentPath = join(root, 'DESIGN.md');
    const original = '## Craft rulebooks\n\n- color\n';
    writeFileSync(documentPath, original);
    execFileSync('git', ['init', '-q', root]);
    setUserConfigOverlay((config) => ({ ...config, harness: { ...config.harness, defaultRepo: root } }));
    const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
    const eventBus = new NexusEventBus();
    state.bus = eventBus;
    const server = startNexusHttpServer({
      state, eventBus, registry: new TabRegistry(state),
      startPort: 45000 + Math.floor(Math.random() * 15000),
      portProbe: () => 'available', metaApi: { bearerToken: 'owner-secret', noAuth: false },
    });
    try {
      const url = `${server.url}/v1/design-direction`;
      const unauthorized = await fetch(url, {
        method: 'POST', headers: { 'sec-fetch-site': 'cross-site' }, body: '{',
      });
      expect(unauthorized.status).toBe(401);
      expect(readFileSync(documentPath, 'utf8')).toBe(original);

      const authorized = await fetch(url, {
        method: 'POST', headers: {
          'sec-fetch-site': 'cross-site', authorization: 'Bearer owner-secret',
          'content-type': 'application/json',
        }, body: JSON.stringify({ id: 'bold' }),
      });
      expect(authorized.status).toBe(200);
      // The daemon reports git's toplevel, which is the real path (macOS: /var → /private/var).
      expect(await authorized.json()).toMatchObject({ ok: true, direction: 'bold', repoRoot: realpathSync(root), repoSource: 'config' });
      expect(readFileSync(documentPath, 'utf8')).toContain('- bold');
    } finally {
      server.stop();
      setUserConfigOverlay(null);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('failed application returns reason without a success log', async () => {
    let logs = 0;
    const deps: Partial<DesignDirectionRouteDeps> = {
      ...overrides('/project', {}, {}),
      applyDirection: (path) => ({ ok: false, documentPath: path, reason: 'unknown-direction', availableDirections: ['bold'] }),
      logSelection: () => { logs++; },
    };
    const response = await handleDesignDirectionPost(request({ id: 'ghost' }), deps);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ reason: 'unknown-direction', availableDirections: ['bold'] });
    const conflict = await handleDesignDirectionPost(request({ id: 'bold' }), {
      ...deps,
      applyDirection: (path) => ({ ok: false, documentPath: path, reason: 'conflicting-system-file', path: '/project/design/system/tokens.css' }),
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ reason: 'conflicting-system-file', path: '/project/design/system/tokens.css' });
    expect(logs).toBe(0);
  });
});
