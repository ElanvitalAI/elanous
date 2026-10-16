// A1 — first-class finance tools (structure + safety + wire).
//
// Most dispatch bodies hit machine-local DBs (absent in CI → fail-soft
// {error}), so their full behavior is covered by dogfood. The SQL-injection
// guards run against a disposable SQLite fixture below; here we also guard
// the spec surface, unknown-tool handling, and messenger-turn assembly wiring.
//
// ⭐ 배선 주어 — 실측으로 갈랐다(후보 둘이 있었고 하나는 «닿지 않는다»):
//   telegram-agent.ts:18  makeTelegramAgentRunTurn → makeElanousAgentRunTurn(cfg,'telegram')
//   monad-agent-turn.ts:71  const fin = finance ? buildFinanceTools() : null   ← 여기가 주인
//   ⛔ src/agent/shared-app-tools.ts 는 «다른 소비자»다 — daemon toolSurface(index.ts:312)와
//      CLI(index.ts:8576)만 그것을 부르고, ***텔레그램 경로는 그 파일에 닿지 않는다***.
//      그래서 배선 검사를 그리로 옮기면 「telegram 이 게이트를 지키나」를 «안 재게» 된다.
//   📌 부수 관측: 「turn 조립기 통일 Phase 0」(2026-07-22)이 셋을 합치려 했으나 telegram 은
//      여전히 자기 손으로 조립한다 — 통일은 «반쪽»이다. 이 시험은 그 현재 상태를 문다.
//
// ⭐ 13F 가드 — DB 가 «있어야» 입력 검증에 닿는다. 그 DB 를 진짜 state-dir 에 만들지 «않는다»:
//   임시 ELANOUS_STATE_DIR 로 갈라 세우고 env 를 되돌린다(운영 ~/.elanous 를 시험이 만지면
//   프로세스가 중간에 죽었을 때 «빈 DB»가 남아 진짜 조회가 조용히 빈손이 된다).

import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildFinanceTools, FINANCE_ALERT_VIEWS } from '../src/domains/finance-tools.js';

/** finance-tools resolves scores.db from homedir() at import time. Run these
 * guard checks in a child with a disposable HOME so they reach validation
 * without reading or creating the developer's real scores.db. */
function dispatchWithScoresFixture(requests: Array<{ name: string; args: Record<string, unknown> }>): Array<Record<string, unknown>> {
  const home = mkdtempSync(join(tmpdir(), 'finance-scores-'));
  try {
    const dbDir = join(home, '.cache', 'asset-attractiveness');
    mkdirSync(dbDir, { recursive: true });
    const db = new Database(join(dbDir, 'scores.db'));
    try {
      db.run('CREATE TABLE scores (preset TEXT, symbol TEXT, as_of TEXT, total_score REAL, z_score REAL, signal TEXT)');
      db.prepare('INSERT INTO scores VALUES (?, ?, ?, ?, ?, ?)').run(
        'semis', '005930.KO', new Date().toISOString().slice(0, 10), 53.9, -1.2, 'SELL',
      );
    } finally {
      db.close();
    }
    const child = `
      const { buildFinanceTools } = await import(process.env.FINANCE_TOOLS_MODULE);
      const { dispatch } = buildFinanceTools();
      const requests = JSON.parse(process.env.FINANCE_REQUESTS);
      const results = [];
      for (const request of requests) results.push(await dispatch(request.name, request.args));
      console.log(JSON.stringify(results));
    `;
    const output = execFileSync(process.execPath, ['-e', child], {
      encoding: 'utf-8',
      timeout: 15_000,
      env: {
        ...process.env,
        HOME: home,
        ELANOUS_STATE_DIR: home,
        FINANCE_TOOLS_MODULE: pathToFileURL(join(import.meta.dir, '..', 'src', 'domains', 'finance-tools.ts')).href,
        FINANCE_REQUESTS: JSON.stringify(requests),
      },
    });
    return JSON.parse(output) as Array<Record<string, unknown>>;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe('finance tool surface', () => {
  const { specs, names, dispatch } = buildFinanceTools();

  test('exposes the expected first-class tools', () => {
    expect([...names].sort()).toEqual(
      ['conatus_position', 'finance_13f', 'finance_13f_movers', 'finance_13f_sectors', 'finance_alerts', 'finance_attractiveness', 'finance_backtest', 'finance_bt_loop', 'finance_capstone', 'finance_capstone_override', 'finance_dig', 'finance_dislocation', 'finance_kfutures', 'finance_knowledge', 'finance_koru_swing', 'finance_kr_flow', 'finance_loops', 'finance_market_backbone', 'finance_monitor', 'finance_ontology', 'finance_opportunity', 'finance_panel', 'finance_quote', 'finance_region', 'finance_screener', 'finance_sector', 'finance_signals', 'finance_trend', 'finance_verify_gate'],
    );
    for (const s of specs) {
      expect(typeof s.name).toBe('string');
      expect(typeof s.description).toBe('string');
      expect(s.parameters).toHaveProperty('type', 'object');
    }
  });

  test('descriptions steer read-only + reliability (no-trade, anchor-not-memory)', () => {
    const conatus = specs.find(s => s.name === 'conatus_position')!;
    expect(conatus.description).toMatch(/READ-ONLY|Never executes/i);
    const backbone = specs.find(s => s.name === 'finance_market_backbone')!;
    expect(backbone.description).toMatch(/asset-class only/i);
  });

  test('unknown tool → soft error, never throws', async () => {
    await expect(dispatch('nope', {})).resolves.toHaveProperty('error');
  });

  test('finance_dig — topic required (soft error), spec steers on-demand + read-only', async () => {
    const r = await dispatch('finance_dig', {}) as { error?: string };
    expect(r.error).toMatch(/topic 필수/);
    const spec = specs.find(s => s.name === 'finance_dig')!;
    expect(spec.description).toMatch(/온디맨드/);
    expect(spec.description).toMatch(/verify\+HITL/);
    expect((spec.parameters as { required?: string[] }).required).toEqual(['topic']);
  });

  test('SQL-injection guard on attractiveness args', () => {
    const [valid, bad, after] = dispatchWithScoresFixture([
      { name: 'finance_attractiveness', args: { symbol: '005930.KO' } },
      { name: 'finance_attractiveness', args: { symbol: "005930'; DROP TABLE scores;--" } },
      { name: 'finance_attractiveness', args: { symbol: '005930.KO' } },
    ]);
    expect(valid.table).toContain('005930.KO');
    expect(bad.error).toMatch(/invalid symbol/);
    expect(after.table).toBe(valid.table);
  }, 20_000);

  test('finance_13f_sectors (A2.2b): aggregate money-movement lens, non-throwing', async () => {
    const r = await dispatch('finance_13f_sectors', {}) as Record<string, unknown>;
    // knowledge.db present on this machine → rollup; absent in CI → {error}. Both non-throwing.
    expect('sector_flow_qoq' in r || 'error' in r).toBe(true);
    const sectors = specs.find(s => s.name === 'finance_13f_sectors')!;
    expect(sectors.description).toMatch(/SECTOR-level|섹터/i);
    // drill-down: sector arg lists issuers; the name is interpolated into SQL → guarded.
    const drill = await dispatch('finance_13f_sectors', { sector: 'Energy' }) as Record<string, unknown>;
    expect('issuers' in drill || 'error' in drill).toBe(true);
    // 임시 state-dir 로 갈라 빈 13F DB 를 세운다 — 핸들러가 DB 부재로 먼저 되돌아가면
    // safeToken 가드에 «닿지 못해» 이 시험이 가드를 안 무는 상태가 된다.
    const stateDir = mkdtempSync(join(tmpdir(), 'finance-tools-'));
    const previousStateDir = process.env.ELANOUS_STATE_DIR;
    try {
      process.env.ELANOUS_STATE_DIR = stateDir;
      writeFileSync(join(stateDir, 'knowledge_13f.db'), '');
      const bad = await dispatch('finance_13f_sectors', { sector: "x'; DROP TABLE dim_security;--" }) as { error?: string };
      expect(bad.error).toMatch(/^invalid sector:/);
    } finally {
      if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = previousStateDir;
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test('finance_ontology: cluster/blast/corr/recall non-throwing + READ-ONLY note', async () => {
    // knowledge.db + kg tables present on this machine → results; absent in CI → {error}. Both non-throwing.
    const cluster = await dispatch('finance_ontology', { op: 'cluster', node: 'chain:반도체' }) as Record<string, unknown>;
    expect('cluster' in cluster || 'error' in cluster).toBe(true);
    const corr = await dispatch('finance_ontology', { op: 'corr' }) as Record<string, unknown>;
    expect('correlations' in corr || 'error' in corr).toBe(true);
    const recall = await dispatch('finance_ontology', { op: 'recall', query: '반도체' }) as Record<string, unknown>;
    expect('seeds' in recall || 'error' in recall).toBe(true);
    const spec = specs.find(s => s.name === 'finance_ontology')!;
    expect(spec.description).toMatch(/온톨로지|클러스터|READ-ONLY/i);
    expect(spec.description).toMatch(/매매 아님|verify\+HITL/);
  });

  test('finance_panel (A3 심의): factsheet roster + score, non-throwing + injection-safe', async () => {
    const r = await dispatch('finance_panel', { symbol: '005930.KO' }) as Record<string, unknown>;
    // panels skill JSON present on this machine → panel roster; absent → {error}. Both non-throwing.
    expect('panel' in r || 'error' in r).toBe(true);
    if ('panel' in r) {
      expect(r).toHaveProperty('consensus_formula');
      expect(r).toHaveProperty('instruction');
    }
    const spec = specs.find(s => s.name === 'finance_panel')!;
    expect(spec.description).toMatch(/PANEL|패널|심의/i);
    expect((spec.parameters as { required?: string[] }).required).toContain('symbol');
    const bad = await dispatch('finance_panel', { symbol: "x'; DROP TABLE scores;--" }) as { error?: string };
    expect(bad.error).toMatch(/valid symbol required/);
  });

  test('finance_region: objective-anchor spec + region guard (no slow omni call)', async () => {
    const spec = specs.find(s => s.name === 'finance_region')!;
    expect(spec.description).toMatch(/objective|앵커|anchor/i);
    expect(spec.parameters).toHaveProperty('properties.region');
    // Unknown region must fail fast, BEFORE any omni-market subprocess.
    const bad = await dispatch('finance_region', { region: 'ZZ' }) as { error?: string };
    // region dir may be absent in CI → that error is fine too; both non-throwing.
    expect(typeof bad.error === 'string').toBe(true);
    if (bad.error && !/dir not found|no region/.test(bad.error)) {
      expect(bad.error).toMatch(/unknown region/);
    }
  });

  test('finance_monitor (P3a): single-call combined snapshot, all sections fail-soft', async () => {
    const r = await dispatch('finance_monitor', {}) as Record<string, unknown>;
    // Combined view always returns the five section keys — each is a string
    // (a table on this machine, or the section's soft {error} text in CI).
    for (const k of ['backbone', 'asset_rotation', 'country_attractiveness', 'sector_rotation', 'institutional_consensus']) {
      expect(typeof r[k]).toBe('string');
    }
    expect(r).toHaveProperty('note');
    const spec = specs.find(s => s.name === 'finance_monitor')!;
    expect(spec.description).toMatch(/SINGLE-CALL|종합|snapshot/i);
  });

  test('finance_dislocation (P3b): backbone vs sentiment divergence, non-throwing', async () => {
    const r = await dispatch('finance_dislocation', {}) as Record<string, unknown>;
    // x_asset.db present + sentiment fresh → dislocations; absent/no-overlap → {error}. Both non-throwing.
    expect('dislocations' in r || 'error' in r).toBe(true);
    if ('dislocations' in r) {
      expect(Array.isArray(r.dislocations)).toBe(true);
      expect(r).toHaveProperty('summary');
    }
    const spec = specs.find(s => s.name === 'finance_dislocation')!;
    expect(spec.description).toMatch(/dislocation|괴리|센티/i);
  });

  test('finance_kfutures (P7c): read-only KOSPI200 futures, non-throwing', async () => {
    const r = await dispatch('finance_kfutures', {}) as Record<string, unknown>;
    expect('futures' in r || 'error' in r).toBe(true); // KIS session present → price; absent → {error}
    const spec = specs.find(s => s.name === 'finance_kfutures')!;
    expect(spec.description).toMatch(/선물|futures|KOSPI200/i);
    expect(spec.description).toMatch(/READ-ONLY|조회 전용|주문 없음/i);
  }, 30_000);

  test('finance_verify_gate (P8c): session-aware fail-closed, read-only, no execution', async () => {
    const r = await dispatch('finance_verify_gate', {}) as Record<string, unknown>;
    // One of the three states — never throws.
    expect(['CLEARED', 'BLOCKED', 'MARKET_CLOSED']).toContain(r.gate);
    expect(r).toHaveProperty('session');
    // Governance: the note MUST flag read-only + no order execution + HITL.
    expect(String(r.note)).toMatch(/조회|read-only/);
    expect(String(r.note)).toMatch(/집행 없음|주문 못|HITL/);
    // When market is closed, it is MARKET_CLOSED (not a scary risk BLOCK) and
    // still surfaces the config-based risk invariant.
    if (r.gate === 'MARKET_CLOSED') {
      expect(r).toHaveProperty('risk_invariant');
    }
    const spec = specs.find(s => s.name === 'finance_verify_gate')!;
    expect(spec.description).toMatch(/게이트|gate|verify|fail-closed/i);
  }, 90_000);

  test('finance_signals (P7b): unknown kind guarded; valid kind non-throwing', async () => {
    // Unknown kind → guarded error (no subprocess).
    const bad = await dispatch('finance_signals', { kind: 'nope' }) as { error?: string };
    expect(bad.error).toMatch(/unknown kind/);
    // factor is DB/cache-only (no KIS) so it either reports or fail-softs — non-throwing.
    const r = await dispatch('finance_signals', { kind: 'factor' }) as Record<string, unknown>;
    expect('report' in r || 'error' in r).toBe(true);
    const spec = specs.find(s => s.name === 'finance_signals')!;
    expect((spec.parameters as { required?: string[] }).required).toContain('kind');
    expect(spec.description).toMatch(/신호|signal|sector_flow/i);
  }, 100_000);

  test('finance_alerts (P7a): read-only Conatus alert status, non-throwing + fail-soft', async () => {
    // Real subprocess smoke: shells out to the Conatus alert scripts (with
    // Toss creds via conatusEnv). Each is fail-soft, but network-touching, so
    // it needs a generous timeout like the other shell-out tools below.
    const r = await dispatch('finance_alerts', {}) as Record<string, unknown>;
    expect(Array.isArray(r.alerts)).toBe(true);
    // One entry per alert VIEW — assert against the SoT so adding/removing a
    // view (e.g. the koru --gap view) updates in ONE place, no magic-number drift.
    expect((r.alerts as unknown[]).length).toBe(FINANCE_ALERT_VIEWS.length);
    for (const a of r.alerts as Array<Record<string, unknown>>) {
      expect(typeof a.status).toBe('string');
    }
    // Safety wire-guard: every view is invoked read-only (--status/--gap only),
    // never an argless call (lev_stop's argless path auto-sells).
    for (const v of FINANCE_ALERT_VIEWS) {
      expect(v.args.length).toBeGreaterThan(0);
      expect(v.args.every(a => a === '--status' || a === '--gap')).toBe(true);
    }
    // Governance: note must flag read-only / no-order.
    expect(String(r.note)).toMatch(/read-only|주문.*없음|조회/);
    const spec = specs.find(s => s.name === 'finance_alerts')!;
    expect(spec.description).toMatch(/알림|alert|Conatus/i);
  }, 60_000);

  test('finance_opportunity (P5a): opportunity policy board, non-throwing + detection-only note', async () => {
    const r = await dispatch('finance_opportunity', {}) as Record<string, unknown>;
    expect('opportunities' in r).toBe(true); // always returns a board (possibly empty)
    expect(Array.isArray(r.opportunities)).toBe(true);
    expect(r).toHaveProperty('board');
    // Governance: the note must flag detection-only / disarmed (no auto-launch).
    expect(String(r.note)).toMatch(/disarmed|탐지 전용|자동기동/);
    const spec = specs.find(s => s.name === 'finance_opportunity')!;
    expect(spec.description).toMatch(/기회|opportunity|자율/i);
  });

  test('finance_sector (P3c): price×13F fused sector view, non-throwing', async () => {
    const r = await dispatch('finance_sector', {}) as Record<string, unknown>;
    // scores.db(sector-global) + knowledge.db(13F) present → fused; absent → {error}. Both non-throwing.
    expect('sectors' in r || 'error' in r).toBe(true);
    if ('sectors' in r) {
      expect(Array.isArray(r.sectors)).toBe(true);
      expect(r).toHaveProperty('table');
    }
    const spec = specs.find(s => s.name === 'finance_sector')!;
    expect(spec.description).toMatch(/섹터|sector|융합|기관/i);
  });

  test('finance_trend (A2.1/A4): rotation + country + guards + injection-safe', async () => {
    const rot = await dispatch('finance_trend', { scope: 'rotation' }) as Record<string, unknown>;
    // scores.db exists on this machine → table; in CI absent → {error}. Either is non-throwing.
    expect('table' in rot || 'error' in rot).toBe(true);
    // A4 country + A4b sector scopes — non-throwing, and the spec advertises them.
    const country = await dispatch('finance_trend', { scope: 'country' }) as Record<string, unknown>;
    expect('table' in country || 'error' in country).toBe(true);
    const sector = await dispatch('finance_trend', { scope: 'sector' }) as Record<string, unknown>;
    expect('table' in sector || 'error' in sector).toBe(true);
    const trendSpec = specs.find(s => s.name === 'finance_trend')!;
    expect(trendSpec.description).toMatch(/country|국가/i);
    expect(trendSpec.description).toMatch(/sector|섹터/i);
    const [validHistory, bad, noKey, after] = dispatchWithScoresFixture([
      { name: 'finance_trend', args: { scope: 'attractiveness', key: '005930.KO', days: 730 } },
      { name: 'finance_trend', args: { scope: 'attractiveness', key: "x'; DROP--" } },
      { name: 'finance_trend', args: { scope: 'attractiveness' } },
      { name: 'finance_trend', args: { scope: 'attractiveness', key: '005930.KO', days: 730 } },
    ]);
    expect(validHistory.series).toContain('SELL');
    expect(bad.error).toMatch(/needs key=symbol|invalid/);
    expect(noKey.error).toMatch(/needs key=symbol/);
    expect(after.series).toBe(validHistory.series);
  }, 20_000);
});

describe('finance-tools wire (messenger-turn assembly)', () => {
  // 사슬을 «두 칸» 다 문다 — ⑴ telegram 이 그 조립기에 위임하나 ⑵ 그 조립기가 게이트를 지키나.
  // 한 칸만 물면 위임이 끊겨도(또는 조립이 바뀌어도) 초록이 남는다.
  const telegramSrc = readFileSync(join(import.meta.dir, '..', 'src/telegram-agent.ts'), 'utf-8');
  const assemblySrc = readFileSync(join(import.meta.dir, '..', 'src/agent/monad-agent-turn.ts'), 'utf-8');
  test('telegram delegates to the assembly that merges the enabled finance pack', () => {
    expect(telegramSrc).toMatch(/makeTelegramAgentRunTurn[\s\S]*makeElanousAgentRunTurn\(cfg,\s*['"]telegram['"]\)/);
    expect(assemblySrc).toMatch(/import\s*\{\s*buildFinanceTools\s*\}\s*from\s*['"][^'"]*finance-tools/);
    expect(assemblySrc).toMatch(/const fin = finance \? buildFinanceTools\(\) : null/);
    expect(assemblySrc).toMatch(/fin\.names\.has\(name\)/);
  });
});
