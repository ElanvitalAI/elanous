/**
 * CFG-STORE1 — 읽기 전용 config drift / explain 계약 (0.2.20 · 2026-10-08).
 *
 * 전부 temp 픽스처 뿌리 — 실 ~/.elanous 미접촉. 핵심 계약:
 *   1. 반증: 운영 llm.codexQuotaPolicy=credits · 파생 우주에 그 키가 없다 → 드리프트 «한 줄»
 *   2. podPool 드리프트(10-08 밤 사건): 자리 트리 사본이 옛 풀(node-c 포함)을 들고 있으면 보인다
 *   3. 비밀 값은 어떤 출력에도 안 찍힌다(경로 마디 ⊕ 배열 속 객체 키)
 *   4. 못 읽은 config 는 «못 읽음»으로 — 같다고 보지 않는다
 *   5. 레지스트리를 읽기만 한다(prune 쓰기 없음)
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeDrift, computeExplain, discoverUniverses, MASK, renderDrift, renderExplain,
} from './config-drift.js';

const roots: string[] = [];
const NO_DEFAULTS = { codeDefaults: () => ({}) };
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cfg-drift-'));
  roots.push(root);
  const prodRoot = join(root, 'home', '.elanous');
  mkdirSync(join(prodRoot, 'logs'), { recursive: true });
  const seats = join(root, 'home', 'elanous-hq', 'seats');
  const work = join(root, 'home', 'elanous-hq', 'work');
  const trees = join(root, 'trees');
  const registryPath = join(prodRoot, 'logs', 'instances.json');
  const writeCfg = (dir: string, cfg: unknown) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), typeof cfg === 'string' ? cfg : JSON.stringify(cfg));
  };
  const writeRegistry = (stateDirs: string[]) => writeFileSync(registryPath, JSON.stringify({
    instances: stateDirs.map((stateDir, i) => ({ name: `test:t${i}`, stateDir, pid: 999999, startedAt: '2026-10-08T00:00:00Z' })),
  }));
  return { root, prodRoot, seats, work, trees, registryPath, writeCfg, writeRegistry };
}

describe('config drift (CFG-STORE1)', () => {
  it('반증 — 운영 credits · 파생에 정책 없음 → 드리프트 한 줄', () => {
    const f = fixture();
    f.writeCfg(f.prodRoot, { llm: { provider: 'codex', codexQuotaPolicy: 'credits' }, harness: { repo: 'o/r' } });
    const derived = join(f.trees, 'tree-a', '.elanous-test');
    f.writeCfg(derived, { llm: { provider: 'codex' }, harness: { repo: 'o/r' } });
    f.writeRegistry([derived]);

    const report = computeDrift(discoverUniverses({ prodRoot: f.prodRoot, registryPath: f.registryPath, treeScanRoots: [] }));
    expect(report.universes.compared).toBe(1);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({
      key: 'llm.codexQuotaPolicy', prodValue: '"credits"', differing: 1, missingInDerived: 1, valueDiffers: 0,
    });
    expect(report.rows[0]!.groups[0]!.examples).toEqual([join(derived, 'config.json')]);

    // 양성 대조 — 정책을 맞추면 0줄
    f.writeCfg(derived, { llm: { provider: 'codex', codexQuotaPolicy: 'credits' }, harness: { repo: 'o/r' } });
    expect(computeDrift(discoverUniverses({ prodRoot: f.prodRoot, registryPath: f.registryPath, treeScanRoots: [] })).rows).toHaveLength(0);
  });

  it('podPool — 자리·작업 트리 사본이 옛 풀(node-c)을 들고 있으면 우주 수·예시 경로로 보인다', () => {
    const f = fixture();
    f.writeCfg(f.prodRoot, { harness: { podPool: 'pool-node-b@node-b:40' } });
    f.writeCfg(join(f.seats, 'MK', '.elanous-test'), { harness: { podPool: 'pool-node-b@node-b:25,pool-node-c@node-c:6' } });
    f.writeCfg(join(f.work, 'MK-x', '.elanous-test'), { harness: { podPool: 'pool-node-b@node-b:25,pool-node-c@node-c:6' } });
    f.writeCfg(join(f.seats, 'UX', '.elanous-test'), { harness: { podPool: 'pool-node-b@node-b:40' } });
    mkdirSync(join(f.seats, 'TC', '.elanous-test'), { recursive: true }); // config 없음 — 비교 제외·수는 낸다

    const d = discoverUniverses({ prodRoot: f.prodRoot, registryPath: null, treeScanRoots: [f.seats, f.work] });
    expect(d.derived.every((u) => u.origins.includes('tree-scan'))).toBe(true);
    const report = computeDrift(d, { key: 'harness.podPool' });
    expect(report.universes).toMatchObject({ total: 4, compared: 3, noConfig: 1, unreadable: 0 });
    expect(report.rows).toHaveLength(1);
    const row = report.rows[0]!;
    expect(row).toMatchObject({ key: 'harness.podPool', differing: 2, valueDiffers: 2 });
    expect(row.groups).toHaveLength(1);
    expect(row.groups[0]!.value).toContain('node-c');
    expect(row.groups[0]!.count).toBe(2);
    expect(renderDrift(report)).toContain('harness.podPool  2/3 우주 다름');

    const explain = computeExplain(d, 'harness.podPool', { codeDefaults: () => ({ harness: {} }) });
    expect(explain.prod).toMatchObject({ layer: 'prod-file', value: '"pool-node-b@node-b:40"' });
    expect(explain.groups.find((g) => !g.sameAsProd)!.count).toBe(2);
    expect(explain.groups.find((g) => g.sameAsProd)!.count).toBe(1);
    expect(renderExplain(explain)).toContain('운영과 다른 우주 2/3');
  });

  it('비밀 값은 가린다 — 경로 마디(apiKey) ⊕ 배열 속 객체 키(botToken)', () => {
    const f = fixture();
    const SECRET_A = 'sk-prod-AAAAAAAAAAAAAAAAAAAA';
    const SECRET_B = 'sk-derived-BBBBBBBBBBBBBBBBBB';
    const BOT = '8799226199:AAE9zA3sqjmurLLFwATRQ-LOEyp4Av1LaYw';
    f.writeCfg(f.prodRoot, { llm: { apiKey: SECRET_A }, notify: { routes: [{ name: 'main', botToken: BOT }] } });
    f.writeCfg(join(f.trees, 'tree-b', '.elanous-test'), { llm: { apiKey: SECRET_B }, notify: { routes: [] } });

    const d = discoverUniverses({ prodRoot: f.prodRoot, registryPath: null, treeScanRoots: [f.trees] });
    const report = computeDrift(d, { includeExpected: true });
    const keys = report.rows.map((r) => r.key);
    expect(keys).toContain('llm.apiKey');
    expect(keys).toContain('notify.routes');
    expect(report.rows.find((r) => r.key === 'llm.apiKey')!.prodValue).toBe(MASK);
    expect(report.rows.find((r) => r.key === 'notify.routes')!.prodValue).toContain('"botToken":"<masked>"');
    const out = renderDrift(report) + JSON.stringify(report)
      + renderExplain(computeExplain(d, 'llm.apiKey', NO_DEFAULTS)) + JSON.stringify(computeExplain(d, 'notify.routes', NO_DEFAULTS));
    for (const secret of [SECRET_A, SECRET_B, BOT]) expect(out).not.toContain(secret);
  });

  it('못 읽은 config 는 «못 읽음» — 같다고 보지 않고 운영을 못 읽으면 비교하지 않는다', () => {
    const f = fixture();
    f.writeCfg(f.prodRoot, { llm: { codexQuotaPolicy: 'credits' } });
    const broken = join(f.trees, 'tree-c', '.elanous-test');
    f.writeCfg(broken, '{ not json');
    f.writeRegistry([broken]);
    const report = computeDrift(discoverUniverses({ prodRoot: f.prodRoot, registryPath: f.registryPath, treeScanRoots: [] }));
    expect(report.universes).toMatchObject({ compared: 0, unreadable: 1 });
    expect(report.unreadable[0]!.configPath).toBe(join(broken, 'config.json'));
    const text = renderDrift(report);
    expect(text).toContain('못 읽음 (같다고 보지 않음)');
    expect(text).toContain('«잴 대상이 없었다»');

    f.writeCfg(f.prodRoot, '{');
    const prodBroken = computeDrift(discoverUniverses({ prodRoot: f.prodRoot, registryPath: f.registryPath, treeScanRoots: [] }));
    expect(prodBroken.prodStatus).toBe('unreadable');
    expect(prodBroken.rows).toHaveLength(0);
    expect(renderDrift(prodBroken)).toContain('「드리프트 0」이 아니다');
    expect(computeExplain(discoverUniverses({ prodRoot: f.prodRoot, registryPath: null, treeScanRoots: [] }), 'llm.x', NO_DEFAULTS).prod.layer)
      .toBe('prod-unreadable');
  });

  it('sync-test 의 의도된 변환(발송 끔·_test 메타)은 기본 제외 · includeExpected 로 보인다', () => {
    const f = fixture();
    f.writeCfg(f.prodRoot, { discord: { enabled: true }, telegram: { enabled: true, homeChannel: 1 } });
    const derived = join(f.trees, 'tree-d', '.elanous-test');
    f.writeCfg(derived, { discord: { enabled: false }, telegram: { enabled: false }, _testSyncedAt: '2026-10-08T00:00:00Z', _testSecretsStripped: 0 });
    f.writeRegistry([derived]);
    const d = discoverUniverses({ prodRoot: f.prodRoot, registryPath: f.registryPath, treeScanRoots: [] });
    expect(computeDrift(d).rows).toHaveLength(0);
    const all = computeDrift(d, { includeExpected: true }).rows.map((r) => r.key);
    expect(all).toEqual(expect.arrayContaining(['discord.enabled', 'telegram.homeChannel', '_testSyncedAt']));
  });

  it('explain 출처 층 — 파일 · 코드 기본값 · 없음', () => {
    const f = fixture();
    f.writeCfg(f.prodRoot, { harness: { podPool: 'p' } });
    const d = discoverUniverses({ prodRoot: f.prodRoot, registryPath: null, treeScanRoots: [] });
    const defaults = () => ({ harness: { nestedElanousMaxDepth: 2 } });
    expect(computeExplain(d, 'harness.podPool', { codeDefaults: defaults }).prod.layer).toBe('prod-file');
    expect(computeExplain(d, 'harness.nestedElanousMaxDepth', { codeDefaults: defaults }).prod).toMatchObject({ layer: 'code-default', value: '2' });
    expect(computeExplain(d, 'harness.nope', { codeDefaults: defaults }).prod.layer).toBe('unset');
  });

  it('레지스트리는 읽기만 한다 — 사라진 항목이 있어도 파일이 그대로다', () => {
    const f = fixture();
    f.writeCfg(f.prodRoot, {});
    f.writeRegistry([join(f.root, 'gone', '.elanous-test'), f.prodRoot]);
    const before = readFileSync(f.registryPath, 'utf-8');
    const d = discoverUniverses({ prodRoot: f.prodRoot, registryPath: f.registryPath, treeScanRoots: [] });
    expect(readFileSync(f.registryPath, 'utf-8')).toBe(before);
    expect(d.derived.map((u) => u.status)).toEqual(['gone']); // 운영 뿌리는 파생에서 뺀다
  });

  it('리뷰 반영 — 파서 메시지(파일 내용 조각)를 내지 않는다', () => {
    const f = fixture();
    f.writeCfg(f.prodRoot, {});
    const SECRET = 'sk-leaky-CCCCCCCCCCCCCCCCCCCC';
    const broken = join(f.trees, 'tree-e', '.elanous-test');
    f.writeCfg(broken, `{"llm":{"apiKey":"${SECRET}" oops}`);
    const d = discoverUniverses({ prodRoot: f.prodRoot, registryPath: null, treeScanRoots: [f.trees] });
    const report = computeDrift(d);
    expect(report.unreadable[0]!.error).toBe('JSON 파싱 실패');
    expect(renderDrift(report) + JSON.stringify(report)).not.toContain(SECRET);
  });

  it('리뷰 반영 — 운영을 못 읽으면 explain 은 파생을 「다름」으로 세지 않는다', () => {
    const f = fixture();
    f.writeCfg(f.prodRoot, '{');
    f.writeCfg(join(f.trees, 'tree-f', '.elanous-test'), { harness: { podPool: 'x' } });
    const r = computeExplain(discoverUniverses({ prodRoot: f.prodRoot, registryPath: null, treeScanRoots: [f.trees] }), 'harness.podPool', NO_DEFAULTS);
    expect(r.comparable).toBe(false);
    expect(r.groups).toHaveLength(0);
    expect(renderExplain(r)).toContain('비교하지 않았다');
    expect(renderExplain(r)).not.toContain('운영과 다른 우주');
  });

  it('리뷰 반영 — llm-fallback 은 운영 llm 절이 «비었을 때만» 출처 층이다', () => {
    const f = fixture();
    writeFileSync(join(f.prodRoot, 'llm-fallback.json'), JSON.stringify({ provider: 'codex', model: 'm-fb' }));
    f.writeCfg(f.prodRoot, { llm: { provider: 'codex' } });
    const d1 = discoverUniverses({ prodRoot: f.prodRoot, registryPath: null, treeScanRoots: [] });
    expect(computeExplain(d1, 'llm.model', NO_DEFAULTS).prod.layer).toBe('unset');
    f.writeCfg(f.prodRoot, { llm: { provider: 'auto' } });
    const d2 = discoverUniverses({ prodRoot: f.prodRoot, registryPath: null, treeScanRoots: [] });
    expect(computeExplain(d2, 'llm.model', NO_DEFAULTS).prod).toMatchObject({ layer: 'llm-fallback', value: '"m-fb"' });
  });

  it('CFG-MASK — 무해한 이름 아래 웹훅·credentials 값은 가리고 보통 URL 은 그대로 둔다(drift ⊕ explain)', () => {
    const f = fixture();
    const HOOK = 'https://discord.com/api/webhooks/123456/abcDEFsecretPart';
    const SLACK = 'https://hooks.slack.com/services/T000/B000/XXXXsecret';
    const GH = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const USERINFO = 'https://bob:hunter2pass@db.example.com/x';
    const PLAIN = 'https://example.com/path';
    f.writeCfg(f.prodRoot, { notify: { url: HOOK, list: [SLACK] }, credentials: { github: GH }, mirror: { url: USERINFO }, site: { url: PLAIN } });
    f.writeCfg(join(f.trees, 'tree-m', '.elanous-test'), { notify: { url: 'https://example.com/other' }, site: { url: 'https://example.com/old' } });
    const d = discoverUniverses({ prodRoot: f.prodRoot, registryPath: null, treeScanRoots: [f.trees] });
    const report = computeDrift(d, { includeExpected: true });
    const row = (k: string) => report.rows.find((r) => r.key === k)!;
    expect(row('notify.url').prodValue).toBe(MASK);
    expect(row('notify.list').prodValue).toBe('["<masked>"]');
    expect(row('credentials.github').prodValue).toBe(MASK);
    expect(row('mirror.url').prodValue).toBe(MASK);
    expect(row('site.url').prodValue).toBe(JSON.stringify(PLAIN));
    expect(row('site.url').groups[0]!.value).toBe('"https://example.com/old"');
    const explains = ['notify.url', 'notify.list', 'credentials.github', 'mirror.url']
      .map((k) => computeExplain(d, k, NO_DEFAULTS));
    for (const e of explains) expect(e.prod.value).toContain(MASK);
    expect(computeExplain(d, 'site.url', NO_DEFAULTS).prod.value).toBe(JSON.stringify(PLAIN));
    const out = renderDrift(report, { limit: 0 }) + JSON.stringify(report)
      + explains.map((e) => renderExplain(e) + JSON.stringify(e)).join('');
    for (const secret of [HOOK, SLACK, GH, USERINFO, 'hunter2pass', 'abcDEFsecretPart']) expect(out).not.toContain(secret);
    expect(out).toContain(PLAIN);
  });

  it('CFG-MASK — 이름 축: credential·auth·cookie·session·dsn·pass 는 가리고 authorOnPod·bypass 는 아니다', async () => {
    const { isSecretName } = await import('./config-drift.js');
    for (const n of ['credentials', 'auth', 'basicAuth', 'authorization', 'bearer', 'cookie', 'sessionId', 'dsn', 'pass', 'smtpPass', 'passphrase', 'oauth'])
      expect([n, isSecretName(n)]).toEqual([n, true]);
    for (const n of ['authorOnPod', 'author', 'bypass', 'passthrough', 'podPool', 'repo'])
      expect([n, isSecretName(n)]).toEqual([n, false]);
  });
});
