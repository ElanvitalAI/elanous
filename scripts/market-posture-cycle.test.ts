// market_posture 생산자 사이클 단위테스트 — [외부 구현·claude-code] 아크1 글루(2026-07-16).
// 순수 조립·dep 주입(regime/capstone/emergency/publish seam) 및 격리된 CLI 로그 경로.
import { setDefaultTimeout, test, expect, describe } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../src/debug/log.js';
import { LogStore } from '../src/mss/logging/log-store.js';
import type { DebugEvent } from '../src/debug/log.js';
import type { MarketPosture } from '../src/domains/market-posture.js';
import type { RegimeVector } from '../src/domains/regime-synth.js';
import type { PublishResult } from '../src/domains/market-posture-store.js';
import {
  regimeToThreatDrivers, assembleMarketPostureInput, runMarketPostureCycle,
} from './market-posture-cycle.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const regime = (over: Partial<RegimeVector> = {}): RegimeVector => ({
  axes: [], composite: 0, regimeLabel: 'NEUTRAL', transition: false, transitionAxes: [],
  asOf: '2026-07-16T00:00:00.000Z', ...over,
});

describe('regimeToThreatDrivers — regime → 융합 threat drivers', () => {
  test('RISK_OFF 심도 = composite 음의 크기', () => {
    const d = regimeToThreatDrivers(regime({ composite: -0.5, regimeLabel: 'RISK_OFF' }));
    const riskOff = d.find((x) => x.key === 'regime_risk_off')!;
    expect(riskOff.contribution).toBeCloseTo(0.5, 5);
    expect(riskOff.weight).toBe(1);
  });
  test('RISK_ON(양의 composite)은 threat 0(기여 없음)', () => {
    const d = regimeToThreatDrivers(regime({ composite: 0.4, regimeLabel: 'RISK_ON' }));
    expect(d.find((x) => x.key === 'regime_risk_off')!.contribution).toBe(0);
  });
  test('전환·지정학 음의 방향이 driver 로 합류', () => {
    const d = regimeToThreatDrivers(regime({
      composite: -0.3, transition: true,
      axes: [{ axis: 'geopolitics', direction: -1, strength: 0.8, confidence: 1, note: '' }],
    }));
    expect(d.some((x) => x.key === 'regime_transition')).toBe(true);
    expect(d.some((x) => x.key === 'geopolitics')).toBe(true);
  });
});

describe('assembleMarketPostureInput — 입력 융합', () => {
  test('emergency 없으면 freshness UNKNOWN·tripwire 생략·정직 provenance', () => {
    const inp = assembleMarketPostureInput(regime({ composite: -0.4 }), { now: () => Date.parse('2026-07-16T01:00:00Z') });
    expect(inp.freshness.status).toBe('UNKNOWN');
    expect(inp.tripwire).toBeUndefined();
    expect(inp.provenance.sources).toContain('emergency:none');
    expect(inp.provenance.calculatedBy).toBe('market-posture-cycle');
    expect(inp.drivers!.length).toBeGreaterThan(0);
  });
  test('emergency(지수 -5%) 있으면 FRESH·tripwire 합류', () => {
    const inp = assembleMarketPostureInput(regime(), {
      readEmergency: () => ({ indices: [{ symbol: 'KOSPI', dayReturn: -0.05 }] }),
    });
    expect(inp.freshness.status).toBe('FRESH');
    expect(inp.tripwire?.indices?.[0]?.dayReturn).toBe(-0.05);
    expect(inp.provenance.sources).toContain('emergency');
  });
});

describe('runMarketPostureCycle — derive → publish', () => {
  test('regime 게시 성공 — DEFCON 산정·publish 호출', () => {
    let published: unknown = null;
    const r = runMarketPostureCycle({
      loadRegime: () => regime({ composite: -0.2 }),
      load: () => null,
      publish: (p): PublishResult => { published = p; return { ok: true }; },
    });
    expect(r.published).toBe(true);
    expect(r.defcon).toBeGreaterThanOrEqual(1);
    expect(r.defcon).toBeLessThanOrEqual(5);
    expect(published).not.toBeNull();
  });
  test('emergency 지수 -5% → tripwire DEFCON 2', () => {
    const r = runMarketPostureCycle({
      loadRegime: () => regime(),
      readEmergency: () => ({ indices: [{ symbol: 'KOSPI', dayReturn: -0.05 }] }),
      load: () => null,
      publish: (): PublishResult => ({ ok: true }),
    });
    expect(r.defcon).toBe(2);
  });
  test('regime 없으면 미게시(입력 결측·fail-soft)', () => {
    const r = runMarketPostureCycle({ loadRegime: () => null, load: () => null, publish: (): PublishResult => ({ ok: true }) });
    expect(r.published).toBe(false);
    expect(r.note).toContain('regime.db');
  });

  test('two cycles log computed and tripwire change, with pre-publish previous value and safe fields', () => {
    const events: DebugEvent[] = [];
    const off = debug.registerSink({ name: 'posture-cycle-test', emit: e => { if (e.category === 'posture.defcon') events.push(e); } });
    let saved: MarketPosture | null = null;
    const order: string[] = [];
    const deps = {
      loadRegime: () => regime({ regimeLabel: 'NEUTRAL', axes: [{ axis: 'geopolitics', direction: -1, strength: 0.2, confidence: 1, note: 'secret note' }] }),
      load: () => { order.push('load'); return saved; },
      publish: (p: MarketPosture): PublishResult => { order.push('publish'); saved = p; return { ok: true }; },
      now: () => Date.parse('2026-07-16T01:00:00Z'),
    };
    try {
      expect(runMarketPostureCycle(deps)).toMatchObject({ published: true, defcon: 5 });
      expect(events.map(e => e.event)).toEqual(['computed']);
      expect(events[0]?.data).toMatchObject({ defcon: 5, previousDefcon: null, changed: false, regimeLabel: 'NEUTRAL', freshness: { status: 'UNKNOWN' }, tripwires: [] });
      expect((events[0]?.data as { drivers: unknown }).drivers).toContainEqual({ name: 'geopolitics', value: 0.2, weight: 0.5 });
      expect(JSON.stringify(events[0]?.data)).not.toContain('secret note');
      expect(runMarketPostureCycle({ ...deps, readEmergency: () => ({ indices: [{ symbol: 'KOSPI', dayReturn: -0.05 }] }) }))
        .toMatchObject({ published: true, defcon: 2 });
      expect(events.map(e => e.event)).toEqual(['computed', 'computed', 'changed']);
      expect(events[1]?.data).toMatchObject({ defcon: 2, previousDefcon: 5, changed: true, tripwires: [{ type: 'index', name: 'KOSPI', value: -0.05 }], freshness: { status: 'FRESH' } });
      expect(events[2]?.data).toMatchObject({ from: 5, to: 2, cause: 'tripwire' });
      expect(order).toEqual(['load', 'publish', 'load', 'publish']);
      expect(runMarketPostureCycle({ ...deps, readEmergency: () => ({ indices: [{ symbol: 'KOSPI', dayReturn: -0.05 }] }) }).published).toBe(true);
      expect(events.slice(3).map(e => e.event)).toEqual(['computed']);
      expect((events[3]?.data as { changed: boolean }).changed).toBe(false);
    } finally { off(); }
  });

  test('fired tripwires expose only labels and numbers; no raw emergency fields', () => {
    const events: DebugEvent[] = [];
    const off = debug.registerSink({ name: 'posture-cycle-test', emit: e => { if (e.category === 'posture.defcon') events.push(e); } });
    try {
      const r = runMarketPostureCycle({
        loadRegime: () => regime(), load: () => null,
        readEmergency: () => ({
          indices: [
            { symbol: 'KOSPI', dayReturn: -0.02 },
            { symbol: 'NASDAQ', dayReturn: -0.1, circuitBreaker: true, account: 'not-for-logs' },
          ],
          futures: [{ symbol: 'ES', gapDown: true, token: 'not-for-logs' }],
          systemCrisis: true,
        }),
        publish: () => ({ ok: true }),
      });
      expect(r.defcon).toBe(1);
      expect(events[0]?.data).toMatchObject({ tripwires: [
        { type: 'index', name: 'NASDAQ', value: -0.1 },
        { type: 'future', name: 'ES' },
        { type: 'systemCrisis' },
      ] });
      expect(JSON.stringify(events[0]?.data)).not.toContain('not-for-logs');
    } finally { off(); }
  });

  test('driver change has drivers cause; missing regime skips without loading or publishing', () => {
    const events: DebugEvent[] = [];
    const off = debug.registerSink({ name: 'posture-cycle-test', emit: e => { if (e.category === 'posture.defcon') events.push(e); } });
    try {
      const old = runMarketPostureCycle({ loadRegime: () => regime(), load: () => null, publish: () => ({ ok: true }) });
      expect(old.defcon).toBe(5);
      let published = false;
      const updated = runMarketPostureCycle({
        loadRegime: () => regime({ composite: -0.8 }),
        load: () => ({ defcon: 5 }) as MarketPosture,
        publish: () => { published = true; return { ok: true }; },
      });
      expect(updated.defcon).toBe(3);
      expect(published).toBe(true);
      expect(events.at(-1)?.data).toMatchObject({ from: 5, to: 3, cause: 'drivers' });
      expect(runMarketPostureCycle({
        loadRegime: () => null,
        load: () => { throw new Error('should not load'); },
        publish: () => { throw new Error('should not publish'); },
      })).toEqual({ published: false, note: 'regime.db 최신 벡터 없음 — posture 미산정(입력 결측·게시 스킵)' });
      expect(events.at(-1)).toMatchObject({ event: 'skipped', data: { reason: 'regime-missing' } });
    } finally { off(); }
  });

  test('observation read failure cannot block the original publish result', () => {
    const r = runMarketPostureCycle({
      loadRegime: () => regime(),
      load: () => { throw new Error('unavailable read'); },
      publish: () => ({ ok: true }),
    });
    expect(r.published).toBe(true);
    expect(r.defcon).toBe(5);
    expect(r.note).toContain('market_posture 게시');
  });

  test('rejected publication emits warn without changing published/defcon/note', () => {
    const events: DebugEvent[] = [];
    const off = debug.registerSink({ name: 'posture-cycle-test', emit: e => { if (e.category === 'posture.defcon') events.push(e); } });
    try {
      const r = runMarketPostureCycle({ loadRegime: () => regime(), load: () => null, publish: () => ({ ok: false, reason: 'invalid contract' }) });
      expect(r).toEqual({ published: false, defcon: 5, note: '게시 거부: invalid contract' });
      expect(events.map(e => e.event)).toEqual(['computed', 'publish-rejected']);
      expect(events[1]).toMatchObject({ level: 'warn', data: { reason: 'invalid contract' } });
    } finally { off(); }
  });

  test('a rejected tripwire change leaves the prior posture stored and emits no changed event', () => {
    const events: DebugEvent[] = [];
    const off = debug.registerSink({ name: 'posture-cycle-test', emit: e => { if (e.category === 'posture.defcon') events.push(e); } });
    const state: { saved: MarketPosture | null } = { saved: null };
    try {
      const first = runMarketPostureCycle({
        loadRegime: () => regime(), load: () => state.saved,
        publish: p => { state.saved = p; return { ok: true }; },
      });
      expect(first).toMatchObject({ published: true, defcon: 5 });
      const before = state.saved;
      const rejected = runMarketPostureCycle({
        loadRegime: () => regime(), load: () => state.saved,
        readEmergency: () => ({ indices: [{ symbol: 'KOSPI', dayReturn: -0.05 }] }),
        publish: () => ({ ok: false, reason: 'invalid contract' }),
      });
      expect(rejected).toEqual({ published: false, defcon: 2, note: '게시 거부: invalid contract' });
      expect(state.saved).toBe(before);
      expect(state.saved?.defcon).toBe(5);
      expect(events.map(e => e.event)).toEqual(['computed', 'computed', 'publish-rejected']);
      expect(events[1]?.data).toMatchObject({ previousDefcon: 5, defcon: 2, changed: true });
      expect(events[2]).toMatchObject({ level: 'warn', data: { reason: 'invalid contract' } });
    } finally { off(); }
  });

  test('CLI entry registers standalone sink before cycle and writes skipped to isolated logs.db', () => {
    const dir = mkdtempSync(join(tmpdir(), 'market-posture-logs-'));
    try {
      const child = spawnSync(process.execPath, ['scripts/market-posture-cycle.ts'], {
        cwd: process.cwd(), encoding: 'utf8', timeout: 20_000,
        env: { ...process.env, ELANOUS_STATE_DIR: dir, ELANOUS_CONFIG_DIR: dir, NODE_ENV: 'production' },
      });
      expect(child.status).toBe(1);
      expect(child.stderr).not.toContain('error:');
      const reader = LogStore.openReadOnly(join(dir, 'logs', 'logs.db'));
      try {
        const rows = reader.query({ exactCategories: ['posture.defcon'], events: ['skipped'], limit: 10 });
        expect(rows.length).toBeGreaterThan(0);
        expect(JSON.parse(rows[0]!.data ?? '{}')).toMatchObject({ reason: 'regime-missing' });
      } finally { reader.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
