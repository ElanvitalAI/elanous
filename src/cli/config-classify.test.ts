import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CLASSIFY_RULES, classifyConfig, renderClassify } from './config-classify.js';
import { MASK } from './config-drift.js';

const SECRET = 'sk-test-PRIVATE-1234567890';
const raw = {
  telegram: { botToken: SECRET },
  ui: { theme: 'light' },
  paths: { stateDir: '/tmp/isolated-state' },
  policy: { enabled: true },
};
const defaults = { ui: { theme: 'light' }, policy: { enabled: false } };
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('config classify (CFG-CLASSIFY)', () => {
  it('네 규칙을 우선순위대로 적용하고 운영 덮어쓰기 셋을 센다', () => {
    const report = classifyConfig(raw, defaults);
    expect(CLASSIFY_RULES.map((rule) => rule.class)).toEqual(['secret', 'product-default', 'machine-fact', 'operational']);
    expect(report.leaves.map((leaf) => [leaf.key, leaf.class, leaf.overridesDefault])).toEqual([
      ['paths.stateDir', 'machine-fact', true],
      ['policy.enabled', 'operational', true],
      ['telegram.botToken', 'secret', true],
      ['ui.theme', 'product-default', false],
    ]);
    expect(report.totalLeaves).toBe(4);
    expect(report.counts).toEqual({ secret: 1, 'product-default': 1, 'machine-fact': 1, operational: 1 });
    expect(report.overridesDefault).toBe(3);
    for (const leaf of report.leaves) expect(leaf.rule).toBe(CLASSIFY_RULES.find((rule) => rule.class === leaf.class)!.rule);
  });

  it('비밀 경로·값은 우선 판정되고 사람/JSON 출력에 값이 없다', () => {
    const report = classifyConfig({ ...raw, notify: { url: 'https://discord.com/api/webhooks/123/secret' } },
      { ...defaults, telegram: { botToken: SECRET } });
    expect(report.leaves.find((leaf) => leaf.key === 'telegram.botToken')).toMatchObject({ class: 'secret', overridesDefault: false });
    expect(report.leaves.find((leaf) => leaf.key === 'notify.url')?.class).toBe('secret');
    const output = renderClassify(report);
    expect(output).toContain(`telegram.botToken = ${MASK}`);
    expect(output).toContain('운영 덮어쓰기 3');
    expect(output).toContain('상위 키: notify × 1 · telegram × 1');
    expect(output + JSON.stringify(report)).not.toContain(SECRET);
    expect(output + JSON.stringify(report)).not.toContain('discord.com');
  });

  it('배열·빈 객체도 한 잎, 같은 내용의 객체·배열은 기본값 복사다', () => {
    const report = classifyConfig({ misc: { empty: {}, items: [{ name: 'a' }] }, policy: { enabled: true } },
      { misc: { empty: {}, items: [{ name: 'a' }] } });
    expect(report.leaves.map(({ key, class: kind }) => [key, kind])).toEqual([
      ['misc.empty', 'product-default'], ['misc.items', 'product-default'], ['policy.enabled', 'operational'],
    ]);
    expect(report.overridesDefault).toBe(1);
  });

  it('기본값 없음과 다른 값은 덮어쓰기로 남고 주소/절대 경로는 기계 사실이다', () => {
    const report = classifyConfig({ endpoint: 'https://example.com', target: '/var/tmp/state', policy: { enabled: false } },
      { policy: { enabled: true } });
    expect(report.leaves.map(({ class: kind, overridesDefault }) => [kind, overridesDefault])).toEqual([
      ['machine-fact', true], ['operational', true], ['machine-fact', true],
    ]);
  });

  it('키 마디의 snake_case 경로는 기계 사실, 키 일부 문자열은 정책으로 남는다', () => {
    const report = classifyConfig({ network: { listen_port: 3200 }, policy: { support: true } }, {});
    expect(report.leaves.map(({ class: kind }) => kind)).toEqual(['machine-fact', 'operational']);
  });

  it('실물 진입점 --test=<dir> + --config-dir 격리 파일: 수 합계=잎 수, 쓰기 없음', () => {
    const root = mkdtempSync(join(tmpdir(), 'cfg-classify-'));
    roots.push(root);
    const configDir = join(root, 'config');
    mkdirSync(configDir);
    const path = join(configDir, 'config.json');
    const original = JSON.stringify(raw);
    writeFileSync(path, original);
    const run = spawnSync('bun', [join(resolve('.'), 'bin/elanous.mjs'), `--test=${join(root, 'test')}`,
      'config', 'classify', '--config-dir', configDir, '--json'], {
      cwd: resolve('.'), encoding: 'utf8', timeout: 120_000, env: { ...process.env, XDG_CONFIG_HOME: join(root, 'xdg') },
    });
    expect(run.error).toBeUndefined();
    expect(run.status, run.stderr).toBe(0);
    const report = JSON.parse(run.stdout) as ReturnType<typeof classifyConfig>;
    expect(report.totalLeaves).toBe(4);
    expect(report.leaves).toHaveLength(4);
    expect(Object.values(report.counts).reduce((sum, count) => sum + count, 0)).toBe(report.totalLeaves);
    expect(report.overridesDefault).toBe(4); // 실물 코드 기본값과 픽스처의 네 키는 일치하지 않는다
    expect(run.stdout).not.toContain(SECRET);
    expect(readFileSync(path, 'utf8')).toBe(original);
  });
});
