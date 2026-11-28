import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkPluginFirstRatchet, regenerateBaseline, scanExportedFunctions } from './plugin-first-supervisor';

// Expected strings are literals, independent of the product constants (rule 11).
const GUIDE = '에이전트별 감독 TS 로직 추가 금지 — 공용 실행기 노드 kind 로 + agent.yaml 인스턴스 (src/loop-agent/v3/node-kinds.ts 에 kind 등록은 허용)';
const BASELINE = 'scripts/ratchets/plugin-first-supervisor.baseline.json';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

const git = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function put(root: string, path: string, body: string) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), body); }
function commit(root: string, msg: string) { git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', msg); }

/** A synthetic main: one guardian file, one v3 node-kind table, baseline frozen on it, origin/main = that commit. */
function syntheticMain(): string {
  const root = mkdtempSync(join(tmpdir(), 'plugin-first-'));
  roots.push(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'ratchet@test.invalid');
  git(root, 'config', 'user.name', 'ratchet');
  put(root, 'src/guardian-agent/hosts.ts', 'export function hostsTick(n: number) { return n + 1; }\nfunction helper() { return 0; }\n');
  put(root, 'src/loop-agent/v3/node-kinds.ts', "export const NODE_KINDS = { gate: { kind: 'gate' } };\n");
  commit(root, 'main source');
  put(root, BASELINE, `${JSON.stringify(regenerateBaseline(root, 'HEAD'), null, 2)}\n`);
  commit(root, 'freeze baseline');
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(root, 'checkout', '-q', '-b', 'pr');
  return root;
}

describe('PLUGIN-FIRST-RATCHET — synthetic PRs', () => {
  test('PR 1 (violation): a new guardian file with an exported detector is RED with the literal guidance', () => {
    const root = syntheticMain();
    put(root, 'src/guardian-agent/foo.ts', 'export function detectFoo(rows: number[]) { return rows.filter((r) => r > 3); }\n');
    commit(root, 'agent-specific detector');
    expect(checkPluginFirstRatchet(root)).toEqual([`plugin-first:new-file:src/guardian-agent/foo.ts — ${GUIDE}`]);
    expect(checkPluginFirstRatchet(root)).toEqual([
      'plugin-first:new-file:src/guardian-agent/foo.ts — 에이전트별 감독 TS 로직 추가 금지 — 공용 실행기 노드 kind 로 + agent.yaml 인스턴스 (src/loop-agent/v3/node-kinds.ts 에 kind 등록은 허용)',
    ]);
  });

  test('PR 2 (allowed): a new kind in node-kinds.ts ⊕ a new v3 module ⊕ an agent.yaml instance is GREEN', () => {
    const root = syntheticMain();
    put(root, 'src/loop-agent/v3/node-kinds.ts', "export const NODE_KINDS = { gate: { kind: 'gate' }, 'peer-watch': { kind: 'peer-watch' } };\n");
    put(root, 'src/loop-agent/v3/peer-watch.ts', 'export function peerWatchTick(peers: string[]) { return peers.length; }\n');
    put(root, 'src/kit/peers/index.ts', 'export const listPeers = () => [];\n');
    put(root, 'graphs/loop-agents/guardian/agent.yaml', 'apiVersion: elanous/loop-agent@3\nnodes:\n  - kind: peer-watch\n');
    commit(root, 'shared kind');
    expect(checkPluginFirstRatchet(root)).toEqual([]);
  });

  test('a new exported function in an existing supervisor file is RED; editing a body or adding a private helper is not', () => {
    const root = syntheticMain();
    put(root, 'src/guardian-agent/hosts.ts', 'export function hostsTick(n: number) { return helper2(n) * 2; }\nfunction helper() { return 0; }\nfunction helper2(n: number) { return n; }\n');
    expect(checkPluginFirstRatchet(root)).toEqual([]);
    put(root, 'src/guardian-agent/hosts.ts', 'export function hostsTick(n: number) { return n; }\nexport const hostsLadder = async (n: number) => n;\n');
    expect(checkPluginFirstRatchet(root)).toEqual([`plugin-first:new-function:src/guardian-agent/hosts.ts#hostsLadder — ${GUIDE}`]);
  });

  test('tests and deletions never count; a rename inside the roots is a new file', () => {
    const root = syntheticMain();
    put(root, 'src/guardian-agent/foo.test.ts', 'export function fixture() { return 1; }\n');
    rmSync(join(root, 'src/guardian-agent/hosts.ts'));
    expect(checkPluginFirstRatchet(root)).toEqual([]);
    git(root, 'checkout', '-q', '--', 'src/guardian-agent/hosts.ts');
    renameSync(join(root, 'src/guardian-agent/hosts.ts'), join(root, 'src/guardian-agent/hosts2.ts'));
    expect(checkPluginFirstRatchet(root)).toEqual([`plugin-first:new-file:src/guardian-agent/hosts2.ts — ${GUIDE}`]);
  });

  test('a supervisor file TypeScript cannot parse is RED (fail-closed)', () => {
    const root = syntheticMain();
    put(root, 'src/guardian-agent/hosts.ts', 'export function hostsTick(n: number { return n; }\n');
    expect(checkPluginFirstRatchet(root)).toEqual([
      'plugin-first:parse-error:src/guardian-agent/hosts.ts — 구문 오류라 감독 경로를 셀 수 없다 — 고친 뒤 다시 잰다(fail-closed)',
    ]);
  });

  test('a missing or hand-widened baseline throws instead of passing', () => {
    const root = syntheticMain();
    const baseline = JSON.parse(readFileSync(join(root, BASELINE), 'utf8')) as { entries: string[] };
    baseline.entries.push('src/guardian-agent/foo.ts');
    writeFileSync(join(root, BASELINE), JSON.stringify(baseline));
    expect(() => checkPluginFirstRatchet(root)).toThrow('plugin-first baseline does not match sourceRef inventory');
    rmSync(join(root, BASELINE));
    expect(() => checkPluginFirstRatchet(root)).toThrow('plugin-first baseline missing: scripts/ratchets/plugin-first-supervisor.baseline.json');
  });

  test('race: an entry that reached origin/main after the freeze is tolerated for a PR based on it', () => {
    const root = syntheticMain();
    git(root, 'checkout', '-q', 'main');
    put(root, 'src/steward/landed.ts', 'export function landedTick() { return 1; }\n');
    commit(root, 'landed on main after the freeze');
    git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    git(root, 'checkout', '-q', '-b', 'pr2');
    expect(checkPluginFirstRatchet(root)).toEqual([]);
  });
});

describe('scanExportedFunctions — what counts as an exported body', () => {
  test('declarations, arrows, wrapped arrows, classes, local re-exports and default exports count; types and values do not', () => {
    const src = [
      'export function a() {}',
      'export async function b() {}',
      'export const c = () => 1;',
      'export const d = withLock(async () => 1);',
      'export class E {}',
      'export const LIMIT = 3;',
      'export interface F { x: number }',
      'export type G = string;',
      'function h() {}',
      'export { h as hAlias };',
      "export { x } from './elsewhere';",
      'export default function () {}',
    ].join('\n');
    expect(scanExportedFunctions(src, 'src/steward/x.ts')).toEqual(['E', 'a', 'b', 'c', 'd', 'default', 'hAlias']);
    expect(scanExportedFunctions('export const = ;', 'src/steward/x.ts')).toBeNull();
  });
});
