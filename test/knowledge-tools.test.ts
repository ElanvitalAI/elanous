// ── PFC-S4.2 + S4.3 tool layer ──

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../src/debug/log';
import type { LogRecord } from '../src/mss/logging/record';
import {
  buildKnowledgeQueryTool,
  dispatchKnowledgeQuery,
} from '../src/knowledge/tools/knowledge-query';
import {
  buildKnowledgeWriteTool,
  dispatchKnowledgeWrite,
} from '../src/knowledge/tools/knowledge-write';
import type { ObsidianVault } from '../src/auto-research/obsidian-bridge';

function seedVault(): ObsidianVault {
  const root = mkdtempSync(join(tmpdir(), 'kt-'));
  mkdirSync(join(root, 'Incidents'), { recursive: true });
  writeFileSync(join(root, 'Incidents', 'a.md'),
    `---\nseverity: HIGH\ntitle: test\nresolved: false\ntags: [x]\nkind: incident\n---\n# hello\nworld\n`);
  return { root, isSimulated: false, label: 'kt' };
}

describe('KnowledgeQuery tool', () => {
  test('spec shape — name + no required', () => {
    const spec = buildKnowledgeQueryTool();
    expect(spec.name).toBe('KnowledgeQuery');
    expect(spec.parameters.required).toBeUndefined();
  });

  test('happy path — returns results + summary output', async () => {
    const vault = seedVault();
    const r = await dispatchKnowledgeQuery({ tags: ['x'] }, { vault });
    expect(r.total).toBe(1);
    expect(r.output).toContain('1/1 result');
  });

  test('question with vault filters remains a vault query instead of selecting a pack', async () => {
    const vault = seedVault();
    let selections = 0;
    const selectPack = () => { selections += 1; return { id: 'pack:fixture@1', title: 'fixture' }; };
    for (const input of [
      { question: 'ticketing design', tags: ['x'] },
      { question: 'ticketing design', fulltext: 'world' },
      { question: 'ticketing design', kind: 'incident' as const },
    ]) {
      const result = await dispatchKnowledgeQuery(input, { vault, selectPack });
      expect(result.pack_hits).toBeUndefined();
      expect(result.results).toHaveLength(1);
    }
    expect(selections).toBe(0);
  });

  test('pack.load records selected document identity and digest only after a pack hit', async () => {
    const events: LogRecord[] = [];
    const unregister = debug.registerSink({ name: 'knowledge-pack-load-receipt-test', emit: event => events.push(event) });
    try {
      await dispatchKnowledgeQuery({ question: '아키텍처' }, { selectPack: () => ({ id: 'pack:sysarch@1.0.0', title: 'Architecture' }),
        searchPack: () => [{ id: 'component-cdn', ref: 'pack:sysarch@1.0.0#component-cdn', title: 'CDN', body: 'official summary', updatedAt: '2026-11-14' }] });
      expect(events).toContainEqual(expect.objectContaining({ category: 'pack.load', event: 'document',
        data: expect.objectContaining({ packId: 'pack:sysarch@1.0.0', documentId: 'component-cdn', documentSha256: expect.stringMatching(/^[0-9a-f]{64}$/u) }) }));
      events.length = 0;
      await dispatchKnowledgeQuery({ question: '아키텍처' }, { selectPack: () => ({ id: 'pack:sysarch@1.0.0', title: 'Architecture' }), searchPack: () => [] });
      expect(events.some(event => event.category === 'pack.load')).toBe(false);
    } finally { unregister(); }
  });

  test('auto-select storage failure stays explicit instead of masquerading as an empty vault result', async () => {
    const vault = seedVault();
    const events: LogRecord[] = [];
    const unregister = debug.registerSink({ name: 'knowledge-query-test', emit: event => events.push(event) });
    try {
      const result = await dispatchKnowledgeQuery({ question: 'ticketing design' }, {
        vault,
        selectPack: () => { throw new Error('KGS store unavailable'); },
      });

      expect(result.pack_hits).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.output).toContain('KGS store unavailable');
      expect(events).toContainEqual(expect.objectContaining({
        category: 'knowledge-pack.select', event: 'failed', level: 'warn',
        data: expect.objectContaining({ fallback: 'none', errorType: 'Error' }),
      }));
    } finally {
      unregister();
    }
  });

  test('shipped system architecture pack on/off uses the same request without persistent installation', async () => {
    const vault = seedVault();
    for (const question of ['FE BE DB 시험 배포 아키텍처 설계', '동네 도서관 대출 사이트 구조와 API DB 시험 배포 절차를 설계해줘']) {
      const on = await dispatchKnowledgeQuery({ question }, { vault, resolvePack: () => ({ kind: 'none' }), bundledSystemArchitecture: true });
      const off = await dispatchKnowledgeQuery({ question }, { vault, resolvePack: () => ({ kind: 'none' }), bundledSystemArchitecture: false });
      expect(on.selectedPack?.id).toBe('pack:system-architecture-public@0.2.0');
      expect(on.pack_hits?.[0]?.ref).toContain('pack:system-architecture-public@0.2.0#');
      expect(off.selectedPack).toBeUndefined();
      expect(off.pack_hits).toEqual([]);
      expect(off.reason).toBe('pack-disabled');
    }
    const unrelated = await dispatchKnowledgeQuery({ question: '오늘 9시 알림 설정' }, { vault, resolvePack: () => ({ kind: 'none' }) });
    expect(unrelated.selectedPack).toBeUndefined();
    expect(unrelated.pack_hits).toEqual([]);
    const previousArm = process.env.ELANOUS_SYSTEM_ARCH_PACK;
    try {
      process.env.ELANOUS_SYSTEM_ARCH_PACK = 'off';
      const envOff = await dispatchKnowledgeQuery({ question: 'FE BE DB 시험 배포 아키텍처 설계' },
        { vault, resolvePack: () => ({ kind: 'none' }) });
      expect(envOff.selectedPack).toBeUndefined();
      expect(envOff.pack_hits).toEqual([]);
      expect(envOff.reason).toBe('pack-disabled');
    } finally {
      if (previousArm === undefined) delete process.env.ELANOUS_SYSTEM_ARCH_PACK;
      else process.env.ELANOUS_SYSTEM_ARCH_PACK = previousArm;
    }
  });

  test('negated architecture wording in deploy and photo requests does not load bundled or installed architecture cards', async () => {
    const vault = seedVault();
    const prompts = [
      '기존 앱 배포만 해줘. 아키텍처 설계는 필요 없어.',
      '사진만 검색해 줘. 시스템 설계는 하지 마.',
    ];
    for (const question of prompts) {
      const bundled = await dispatchKnowledgeQuery({ question }, { vault, resolvePack: () => ({ kind: 'none' }), bundledSystemArchitecture: true });
      expect(bundled.selectedPack).toBeUndefined();
      expect(bundled.pack_hits).toEqual([]);
      expect(bundled.reason).toBe('architecture-not-requested');
      const installed = await dispatchKnowledgeQuery({ question }, { vault,
        resolvePack: () => ({ kind: 'selected', pack: { id: 'pack:system-architecture-public@0.2.0', title: 'system architecture' }, priority: 1, intentTags: [] }),
        bundledSystemArchitecture: true,
        searchPack: () => { throw new Error('negated architecture pack must not be searched'); },
      });
      expect(installed.selectedPack).toBeUndefined();
      expect(installed.pack_hits).toEqual([]);
      expect(installed.reason).toBe('architecture-not-requested');
    }
  });

  test('backend architecture remains selected on either side of a UI-design exclusion', async () => {
    for (const question of [
      '기존 UI 설계는 필요 없어. 대신 새 백엔드 시스템 아키텍처를 설계해줘.',
      '새 백엔드 시스템 아키텍처를 설계해줘. 기존 UI 설계는 필요 없어.',
    ]) {
      const result = await dispatchKnowledgeQuery({ question }, {
        resolvePack: () => ({ kind: 'none' }), bundledSystemArchitecture: true,
      });
      expect(result.selectedPack?.id).toBe('pack:system-architecture-public@0.2.0');
      expect(result.pack_hits?.[0]?.ref).toContain('pack:system-architecture-public@0.2.0#');
    }
  });

  test('copy edit of architecture wording alone does not load design cards', async () => {
    const question = '아키텍처 설계 문구 오탈자만 수정해줘.';
    for (const resolvePack of [
      () => ({ kind: 'none' as const }),
      () => ({ kind: 'selected' as const, pack: { id: 'pack:system-architecture-public@0.2.0', title: 'system architecture' }, priority: 1, intentTags: [] }),
    ]) {
      const result = await dispatchKnowledgeQuery({ question }, { resolvePack,
        searchPack: () => { throw new Error('copy edit must not search architecture pack'); } });
      expect(result.selectedPack).toBeUndefined();
      expect(result.pack_hits).toEqual([]);
      expect(result.reason).toBe('architecture-not-requested');
    }
  });

  test('trustedPackOnly fulltext never reads a supplied or discovered vault', async () => {
    const root = mkdtempSync(join(tmpdir(), 'knowledge-trusted-pack-'));
    const absentVault = join(root, 'must-stay-absent');
    const seededVault = seedVault();
    writeFileSync(join(seededVault.root, 'Incidents', 'secret.md'), '# SYNTHETIC_VAULT_MARKER');
    const previousVault = process.env.ELANOUS_OBSIDIAN_VAULT;
    const opts = { trustedPackOnly: true, resolvePack: () => ({ kind: 'none' as const }) };
    Object.defineProperty(opts, 'vault', { get: () => { throw new Error('vault read forbidden'); } });
    try {
      process.env.ELANOUS_OBSIDIAN_VAULT = absentVault;
      const noPack = await dispatchKnowledgeQuery({ fulltext: 'SYNTHETIC_VAULT_MARKER' }, opts);
      expect(noPack.reason).toBe('no-matching-pack');
      expect(noPack.results).toEqual([]);
      expect(noPack.output).not.toContain('SYNTHETIC_VAULT_MARKER');
      const seeded = await dispatchKnowledgeQuery({ fulltext: 'SYNTHETIC_VAULT_MARKER' },
        { trustedPackOnly: true, vault: seededVault, resolvePack: () => ({ kind: 'none' }) });
      expect(seeded.results).toEqual([]);
      expect(seeded.total).toBe(0);
      const packOnly = await dispatchKnowledgeQuery({ question: '백엔드 시스템 아키텍처 설계', fulltext: 'API' }, opts);
      expect(packOnly.selectedPack?.id).toBe('pack:system-architecture-public@0.2.0');
      expect(packOnly.pack_hits?.[0]?.ref).toContain('pack:system-architecture-public@0.2.0#');
      expect(packOnly.results).toEqual([]);
      expect(existsSync(absentVault)).toBe(false);
    } finally {
      if (previousVault === undefined) delete process.env.ELANOUS_OBSIDIAN_VAULT;
      else process.env.ELANOUS_OBSIDIAN_VAULT = previousVault;
      rmSync(root, { recursive: true, force: true });
      rmSync(seededVault.root, { recursive: true, force: true });
    }
  });

  test('no pack for a question returns a reason without creating an Obsidian vault directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'knowledge-no-pack-'));
    const absentVault = join(root, 'must-stay-absent');
    const previousVault = process.env.ELANOUS_OBSIDIAN_VAULT;
    try {
      process.env.ELANOUS_OBSIDIAN_VAULT = absentVault;
      const result = await dispatchKnowledgeQuery({ question: '오늘 9시 알림 설정' },
        { resolvePack: () => ({ kind: 'none' }) });
      expect(result.reason).toBe('no-matching-pack');
      expect(result.pack_hits).toEqual([]);
      expect(result.results).toEqual([]);
      expect(existsSync(absentVault)).toBe(false);
    } finally {
      if (previousVault === undefined) delete process.env.ELANOUS_OBSIDIAN_VAULT;
      else process.env.ELANOUS_OBSIDIAN_VAULT = previousVault;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('an auto-selected pack search failure is logged without the raw question', async () => {
    const events: LogRecord[] = [];
    const unregister = debug.registerSink({ name: 'knowledge-query-provider-failure', emit: event => events.push(event) });
    const question = 'private ticketing question';
    try {
      const result = await dispatchKnowledgeQuery({ question }, {
        resolvePack: () => ({ kind: 'selected', pack: { id: 'pack:ticketing@1.0.0', title: 'Ticketing' }, priority: 1, intentTags: ['ticketing'] }),
        searchPack: () => { throw new Error('provider unavailable'); },
      });

      expect(result.output).toContain('KnowledgeQuery failed: provider unavailable');
      expect(events).toContainEqual(expect.objectContaining({
        category: 'knowledge-pack.select', event: 'provider-failed', level: 'warn',
        data: expect.objectContaining({ stage: 'pack-search', fallback: 'none', packId: 'pack:ticketing@1.0.0', errorType: 'Error' }),
      }));
      expect(JSON.stringify(events)).not.toContain(question);
    } finally {
      unregister();
    }
  });

  test('kind filter routes correctly', async () => {
    const vault = seedVault();
    const r = await dispatchKnowledgeQuery({ kind: 'incident' }, { vault });
    expect(r.total).toBe(1);
  });

  test('invalid regex returns structured error (no throw)', async () => {
    const vault = seedVault();
    const r = await dispatchKnowledgeQuery({ fulltext: '[[[' }, { vault });
    expect(r.total).toBe(0);
    expect(r.output).toContain('failed');
  });

  test('limit clamp still enforced via dispatch', async () => {
    const vault = seedVault();
    const r = await dispatchKnowledgeQuery({ tags: ['x'], limit: 999 }, { vault });
    expect(r.results.length).toBeLessThanOrEqual(100);
  });
});

describe('KnowledgeWrite tool', () => {
  test('spec shape — required rel_path + body', () => {
    const spec = buildKnowledgeWriteTool();
    expect(spec.name).toBe('KnowledgeWrite');
    expect(spec.parameters.required).toEqual(['rel_path', 'body']);
  });

  test('happy path — writes note', async () => {
    const vault = seedVault();
    const r = await dispatchKnowledgeWrite({
      rel_path: 'Notes/h.md',
      body: 'body',
      kind: 'note',
      frontmatter: { title: 't' },
    }, { vault });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(existsSync(r.path)).toBe(true);
      expect(readFileSync(r.path, 'utf-8')).toContain('body');
    }
  });

  test('schema fail returns ok:false + errors', async () => {
    const vault = seedVault();
    const r = await dispatchKnowledgeWrite({
      rel_path: 'Incidents/miss.md',
      body: 'body',
      kind: 'incident',
      frontmatter: { title: 'only' },    // missing severity/resolved
    }, { vault });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.length).toBeGreaterThan(0);
    }
  });

  test('kind auto-inject into frontmatter', async () => {
    const vault = seedVault();
    const r = await dispatchKnowledgeWrite({
      rel_path: 'Notes/k.md',
      body: 'body',
      kind: 'note',
      frontmatter: { title: 'a' },
    }, { vault });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(readFileSync(r.path, 'utf-8')).toContain('kind: note');
    }
  });

  test('dispatch catches path-escape as error (not throw)', async () => {
    const vault = seedVault();
    const r = await dispatchKnowledgeWrite({
      rel_path: '../escape.md',
      body: 'b',
    }, { vault });
    expect(r.ok).toBe(false);
  });
});
