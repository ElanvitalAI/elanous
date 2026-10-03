// L2 코어 앱 도구 레지스트리 단위테스트 — 도메인 무관·전 서피스 공용.
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildCoreTools, CORE_TOOL_SPECS, recallOrRestore } from './core-tools.js';
import { openSurfaceEventsDb, recordEvent, queryEvents, applyMemoryDecay } from './surface-events.js';
import { archiveColdEvents, type ArchiveS3Deps } from './memory-archive.js';

describe('buildCoreTools — L2 코어 앱 도구', () => {
  const core = buildCoreTools();

  test('schedule_manage·memory_recall·self_recall 를 코어 도구로 노출(도메인 무관)', () => {
    const names = [...core.names].sort();
    // LF3(2026-07-13) 정합 갱신 — 목록이 4개 시절에 하드코딩된 채 스테일
    // (main 에서 이미 fail). 현행 전체 코어 세트로 갱신 + logs_query 합류.
    expect(names).toEqual([
      'autopilot_missions', 'coo_admin', 'decisions_pending', 'fact_check', 'logs_query', 'memory_recall', 'mission_decide',
      'ops_seats', 'ops_status', 'release_change', 'release_status', 'schedule_manage', 'se_build', 'self_recall', 'session_manage',
    ]);
    expect(core.specs.length).toBe(CORE_TOOL_SPECS.length);
    for (const s of core.specs) {
      expect(typeof s.name).toBe('string');
      expect(s.parameters).toHaveProperty('type', 'object');
    }
  });

  test('memory_recall 설명이 멀티 도메인을 명시(finance 강결합 아님)', () => {
    const spec = core.specs.find(s => s.name === 'memory_recall')!;
    expect(spec.description).toContain('멀티 도메인');
    // domain 파라미터가 finance 고정이 아니라 멀티(finance·elanous·ops) 안내.
    const domainParam = (spec.parameters as any).properties.domain.description as string;
    expect(domainParam).toContain('elanous');
  });

  test('dispatch — 미등록 이름은 error(throw 안 함)', async () => {
    const r = await core.dispatch('nope', {}) as { error?: string };
    expect(r.error).toContain('unknown core tool');
  });

  test('dispatch — memory_recall 라우팅(원장 없으면 빈 hits·fail-soft)', async () => {
    const r = await core.dispatch('memory_recall', { query: 'xyzzy' }) as { hits?: unknown[]; note?: string };
    // 원장 유무와 무관하게 throw 없이 구조 반환.
    expect(r).toBeDefined();
    expect('hits' in r || 'error' in r).toBe(true);
  });

  test('self_recall — 코어 도구(도메인 무관·finance 독립)로 라우팅', async () => {
    const spec = core.specs.find(s => s.name === 'self_recall')!;
    expect(spec).toBeDefined();
    expect(spec.description).toContain('자기 구현·자율행동 이력');
    const r = await core.dispatch('self_recall', { query: 'xyzzy' }) as { events?: unknown[]; error?: string };
    expect(r).toBeDefined();
    expect('events' in r || 'error' in r).toBe(true); // throw 없이 구조 반환
  });
});

// wire 가드 — 전 서피스가 L2 코어 도구를 단일 출처(core-tools)에서 상속하는가.
describe('L2 배선 가드 (서피스 무관 코어 노출)', () => {
  const read = (p: string) => readFileSync(join(import.meta.dir, p), 'utf-8');

  test('continuation(telegram·자율루프)이 buildCoreTools 조립', () => {
    const src = read('../dispatch/continuation-turn-runner.ts');
    expect(src).toContain('buildCoreTools()');
    expect(src).toContain('core.dispatch(name, args)');
  });
  // ★ turn 조립기 통일 Phase 0(2026-07-22) — CLI/daemon 은 core 를 buildSharedAppTools(core+finance 단일
  //   조립기) 경유로 상속(직접 buildCoreTools 대신). shared-app-tools 가 buildCoreTools 를 품는다(아래 별도 가드).
  test('CLI(buildCliAgentTools)가 core 를 buildSharedAppTools 로 상속', () => {
    const src = read('../cli/agent-cli.ts');
    expect(src).toContain('buildSharedAppTools(cfg)');
  });
  test('daemon toolSurface(PWA/iOS/discord/TUI)가 core 를 buildSharedAppTools 로 상속', () => {
    const src = read('../boot/daemon-tools/index.ts');
    expect(src).toContain('buildSharedAppTools(financeCfg)');
    expect(src).toContain('shared.names.has(name)');
  });
  test('buildSharedAppTools(단일 조립기)가 buildCoreTools 를 품는다(core 단일 출처 유지)', () => {
    const src = read('../agent/shared-app-tools.ts');
    expect(src).toContain('buildCoreTools()');
    expect(src).toContain('core.dispatch(name, args'); // B5: 뒤에 런타임 문맥 인자가 붙는다
  });
  test('finance 팩(finance-tools)은 코어 도구를 더 이상 안 품는다(강결합 해소)', () => {
    const src = read('./finance-tools.ts');
    expect(src).not.toContain('SCHEDULE_MANAGE_SPEC');
    expect(src).not.toContain("name: 'memory_recall'");
    expect(src).not.toContain("name: 'self_recall'"); // self_recall 도 L2(코어)이지 finance 아님
  });
  test('self_recall 은 L2 core-tools 에 등록(finance-tools 아님)', () => {
    const src = read('./core-tools.ts');
    expect(src).toContain('SELF_RECALL_SPEC');
    expect(src).toContain('self_recall: dispatchSelfRecall');
  });
  test('POST /v1/self-event 가 method 블록 안에서 라우팅된다(외부 주입 HTTP 진입점)', () => {
    const src = read('../nexus/api/http-server.ts');
    expect(src).toContain("pathname === '/v1/self-event' && method === 'POST'");
    expect(src).toContain('handleSelfEvent(req, opts.metaApi)');
  });
});

// 축B P2 — memory_recall 느린 복원 배선(recallOrRestore·db+S3 mock 주입).
describe('recallOrRestore — 회상 + 느린 복원(축B P2)', () => {
  const mockS3 = (): ArchiveS3Deps & { store: Map<string, string> } => {
    const store = new Map<string, string>();
    return { store, available: () => true, put: (id, json) => { store.set(id, json); }, get: (id) => store.get(id) ?? null };
  };
  const old = (days: number) => new Date(Date.now() - days * 8.64e7).toISOString();
  /** cold → S3 이관된 기억 1건 준비, id 반환. */
  const seedArchived = (db: ReturnType<typeof openSurfaceEventsDb>, s3: ArchiveS3Deps): string => {
    const id = recordEvent(db, { surface: 'x', direction: 'outbound', kind: 'digest', text: 'KORU 재진입 발송 본문', summary: 'KORU 재진입', importance: 3, ts: old(300) });
    applyMemoryDecay(db);
    archiveColdEvents(db, s3);
    return id;
  };

  test('archived 후보를 id 포함해 노출(복원 전 발견)', () => {
    const db = openSurfaceEventsDb(':memory:');
    const id = seedArchived(db, mockS3());
    const r = recallOrRestore(db, { query: 'KORU' }) as { archived?: Array<{ id: string; summary: string }> };
    expect(r.archived?.length).toBe(1);
    expect(r.archived![0]!.id).toBe(id);          // id 노출 → restoreId 로 복원 가능
    db.close();
  });

  test('restoreId 지정 → 느린 복원(events 재삽입·recall_count++·warm)', () => {
    const db = openSurfaceEventsDb(':memory:');
    const s3 = mockS3();
    const id = seedArchived(db, s3);
    expect(queryEvents(db, {}).length).toBe(0);   // 아카이브됨(로컬 비었음)
    const r = recallOrRestore(db, { restoreId: id }, s3) as { restored?: { id: string; recall_count: number } };
    expect(r.restored).toBeTruthy();
    expect(r.restored!.id).toBe(id);
    expect(r.restored!.recall_count).toBe(1);     // 복원=회상→미엘린 강화
    const local = queryEvents(db, {});
    expect(local.length).toBe(1);                 // 복원됨
    expect(local[0]!.tier).toBe('warm');          // 재활성화
    db.close();
  });

  test('restoreId 미존재 → restored:null(fail-soft)', () => {
    const db = openSurfaceEventsDb(':memory:');
    const r = recallOrRestore(db, { restoreId: 'nope' }, mockS3()) as { restored: null };
    expect(r.restored).toBeNull();
    db.close();
  });

  test('restoreId 없으면 기존 회상 경로(비파괴)', () => {
    const db = openSurfaceEventsDb(':memory:');
    recordEvent(db, { surface: 'x', direction: 'outbound', kind: 'alert', text: '최근 중요 알림', importance: 9, ts: old(1) });
    const r = recallOrRestore(db, { query: '알림' }) as { count: number; hits: unknown[] };
    expect(r.count).toBe(1);
    expect(r.hits.length).toBe(1);
    db.close();
  });
});
