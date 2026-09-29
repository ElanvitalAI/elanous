// Tool-ladder scenarios, run for real in a fresh shell PTY (RFC drive-coding-agents §1b S1·S2·S7).
// env profile → chooseRung → (install if missing · sudo stays human) → the task as one shell line → check the artifact.
//
//   bun scripts/pty-scenarios/run.ts S1 [--narrow-path] [--json] [--keep]
//   bun scripts/pty-scenarios/run.ts S2
//   bun scripts/pty-scenarios/run.ts S3        # rung 2 · gh · no install
//   bun scripts/pty-scenarios/run.ts S7        # S1 on a bare VM (no MCP · no harness)
//
// ⛔ Not under `bun test` (NODE_ENV=test turns the PTY manifest off). Artifacts go to a temp dir.

import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EnvProfile } from '../../src/agent-mission/env-profile.js';
import type { RungChoice } from '../../src/agent-mission/tool-ladder.js';
import { installMissingTool, waitForPtyCompletion, type ToolInstallResult } from '../../src/agent-mission/tool-install.js';
import { installFromDocs } from '../../src/agent-mission/doc-guided-install.js';
import { runPtySnapshot, runPtyText } from '../../src/cli/pty-takeover-cli.js';
import { ensureRunIdentity } from '../../src/harness/harness-space.js';
import { emitDecision, type DecisionEvent } from '../../src/live/detail-switch.js';
import { ptyAvailable, startPty } from '../../src/pty-shell/registry.js';
import { envLiteral } from '../../src/platform/env-literal.js';

type ScenarioId = 'S1' | 'S2' | 'S3' | 'S7' | 'S8';
interface Scenario {
  id: ScenarioId;
  mission: string;
  /** Writes the input into dir and returns what the check needs. */
  prepare: (dir: string) => Record<string, unknown>;
  /** The one shell line for the chosen tool (null = this tool cannot do it). */
  line: (tool: string, dir: string) => string | null;
  /** Checks the artifact; returns a one-line verdict. */
  check: (dir: string, prepared: Record<string, unknown>) => { ok: boolean; detail: string };
  /** A tool nobody pre-packaged: research its official install page, pick a line for a manager this machine has (doc-guided install). */
  docInstall?: { tool: string; smoke: string };
  /** Lower-rung fallback when the preferred tool cannot be installed (e.g. sudo) — with its own smallest real task. */
  fallback?: { tool: string; cmd: string[]; expect: string };
}

const ORDERS = 'id,customer,amount\n1,kim,1200\n2,lee,350\n3,park,4800\n4,choi,75\n';
const orderTotal = 1200 + 350 + 4800 + 75;

const s1: Scenario = {
  id: 'S1',
  mission: '이 CSV 에서 금액 합계를 JSON 으로',
  prepare: (dir) => { writeFileSync(join(dir, 'orders.csv'), ORDERS); return { total: orderTotal }; },
  line: (tool, dir) => tool === 'jq'
    ? `cd ${q(dir)} && tail -n +2 orders.csv | cut -d, -f3 | jq -s '{total: add}' > out.json`
    : tool === 'awk'
      ? `cd ${q(dir)} && awk -F, 'NR>1{s+=$3} END{printf "{\\"total\\": %d}\\n", s}' orders.csv > out.json`
      : null,
  check: (dir, prepared) => {
    const path = join(dir, 'out.json');
    if (!existsSync(path)) return { ok: false, detail: 'out.json 없음' };
    try {
      const total = (JSON.parse(readFileSync(path, 'utf8')) as { total?: unknown }).total;
      return total === prepared.total ? { ok: true, detail: `total=${total}` } : { ok: false, detail: `total=${String(total)} (기대 ${String(prepared.total)})` };
    } catch (e) { return { ok: false, detail: `JSON 아님: ${String(e).slice(0, 80)}` }; }
  },
  fallback: { tool: 'awk', cmd: ['awk', 'BEGIN{print 1+1}'], expect: '2' },
};

const s2: Scenario = {
  id: 'S2',
  mission: '이 영상 앞 10초를 GIF 로',
  prepare: (dir) => {
    // A 12s test pattern — made on the host with whatever ffmpeg the host has (input only; the task runs in the PTY).
    // A bare machine may have no ffmpeg at all — then there is no input yet; the scenario still shows the install decision.
    try {
      execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10:duration=12', join(dir, 'in.mp4')]);
    } catch { return { seconds: 10, fps: 10, noInput: true }; }
    return { seconds: 10, fps: 10 };
  },
  line: (tool, dir) => tool === 'ffmpeg'
    ? `cd ${q(dir)} && ffmpeg -hide_banner -loglevel error -y -i in.mp4 -t 10 -vf fps=10,scale=240:-1 out.gif`
    : null,
  check: (dir, prepared) => {
    const path = join(dir, 'out.gif');
    if (!existsSync(path)) return { ok: false, detail: 'out.gif 없음' };
    try {
      const frames = Number(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', path], { encoding: 'utf8' }).trim());
      const want = Number(prepared.seconds) * Number(prepared.fps);
      return Math.abs(frames - want) <= 2 ? { ok: true, detail: `frames=${frames}` } : { ok: false, detail: `frames=${frames} (기대 약 ${want})` };
    } catch (e) { return { ok: false, detail: `ffprobe 실패: ${String(e).slice(0, 80)}` }; }
  },
};

// Rung 2: the tool already knows the answer — no install, the domain CLI is the whole job.
const REPO = process.env.ELANOUS_SCENARIO_REPO ?? 'ElanvitalAI/elanous';
const draftCountLine = (cutoff: string) => `gh pr list --repo ${REPO} --state open --draft --limit 500 --json number,createdAt --jq '[.[] | select(.createdAt < "${cutoff}")] | length'`;
const s3: Scenario = {
  id: 'S3',
  mission: '열린 PR 중 사흘 넘은 draft 목록',
  prepare: () => {
    const cutoff = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
    // The answer key comes from the host's own gh, outside the PTY.
    const expected = Number(execFileSync('sh', ['-c', draftCountLine(cutoff)], { env: envLiteral(noProxyEnv(process.env as Record<string, string>)), encoding: 'utf8' }).trim());
    return { cutoff, expected };
  },
  line: (tool, dir) => tool === 'gh' ? `cd ${q(dir)} && ${draftCountLine(String(prepared3.cutoff))} > out.txt` : null,
  check: (dir, prepared) => {
    const path = join(dir, 'out.txt');
    if (!existsSync(path)) return { ok: false, detail: 'out.txt 없음' };
    const got = Number(readFileSync(path, 'utf8').trim());
    // PRs can open or close between the two calls — one off is still the same answer.
    return Number.isFinite(got) && Math.abs(got - Number(prepared.expected)) <= 1
      ? { ok: true, detail: `draft>3d=${got} (호스트 ${String(prepared.expected)})` }
      : { ok: false, detail: `draft>3d=${got} (호스트 ${String(prepared.expected)})` };
  },
};
let prepared3: Record<string, unknown> = {};

/** gh talks to GitHub directly; the session's proxy variables break it. */
function noProxyEnv(env: Record<string, string>): Record<string, string> {
  const out = { ...env };
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) delete out[key];
  return out;
}

// S8: a CLI the ladder has never heard of — research, read the official page, install with what this machine has.
const s8: Scenario = {
  id: 'S8',
  mission: '처음 보는 CLI mlr(Miller) 로 이 CSV 에서 금액 합계를 JSON 으로',
  prepare: s1.prepare,
  docInstall: { tool: 'mlr', smoke: "printf 'a,b\\n1,2\\n' | mlr --icsv --ojson cat" },
  line: (tool, dir) => tool === 'mlr'
    ? `cd ${q(dir)} && mlr --icsv --ojson --no-jlistwrap stats1 -a sum -f amount then rename amount_sum,total orders.csv > out.json`
    : null,
  check: s1.check,
};

const SCENARIOS: Record<ScenarioId, Scenario> = { S1: s1, S2: s2, S3: s3, S7: { ...s1, id: 'S7' }, S8: s8 };

const cliPath = join(import.meta.dir, '../../bin/elanous.mjs');

/** Step 0 is the landed CLI (`agent-mission plan --json`), run with the PTY's own env so the profile sees the same PATH. */
function planViaCli(mission: string, env: Record<string, string>): { profile: EnvProfile } & RungChoice {
  const out = spawnSync(process.execPath, [cliPath, 'agent-mission', 'plan', '--json', mission], { env: envLiteral(env), encoding: 'utf8', timeout: 60_000 });
  const line = (out.stdout ?? '').split('\n').filter((l) => l.startsWith('{')).pop();
  if (out.status !== 0 || !line) throw new Error(`agent-mission plan failed (exit ${out.status}): ${(out.stderr ?? '').trim().slice(-200)}`);
  return JSON.parse(line) as { profile: EnvProfile } & RungChoice;
}

function q(value: string): string { return `'${value.replace(/'/g, `'"'"'`)}'`; }

async function snapshot(ref: string): Promise<string> { return (await runPtySnapshot(ref)).message; }

/** Types one line with a completion marker and waits for it; returns the shell exit code. */
async function runLine(ref: string, line: string, timeoutMs: number): Promise<number> {
  const marker = `ELANOUS_SCN_${Date.now().toString(36)}_END_`;
  const typed = await runPtyText(ref, `${line}; printf '\\n%s%s\\n' '${marker}' "$?"`, true, undefined, 'agent');
  if (typed.exitCode) throw new Error(typed.message);
  const screen = await waitForPtyCompletion(ref, { timeoutMs, completionMarker: marker }, snapshot);
  const rc = new RegExp(`${marker}([0-9]+)`).exec(screen.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''))?.[1];
  if (rc === undefined) throw new Error('exit marker missing');
  return Number(rc);
}

export interface ScenarioResult {
  scenario: ScenarioId; mission: string; rung: number; tool: string | null; chosenReason: string;
  install: ToolInstallResult['outcome'] | 'not-needed'; installReason?: string;
  used: string | null; fallback: boolean; ok: boolean; verdict: string; seconds: number;
  decisions: Record<string, number>; ptyId: string; os: string;
}

export async function runScenario(id: ScenarioId, opts: { narrowPath?: boolean; keep?: boolean; holdSeconds?: number; hide?: string[] } = {}): Promise<ScenarioResult> {
  const scenario = SCENARIOS[id];
  if (!ptyAvailable()) throw new Error('node-pty unavailable');
  ensureRunIdentity(process.env);
  // A one-shot process must attach the logs.db sink itself — otherwise every decision and install log vanishes silently.
  try { const { registerStandaloneLogSink } = await import('../../src/domains/standalone-log-sink.js'); await registerStandaloneLogSink('pty-scenarios'); } catch { /* observation must not stop the run */ }
  const started = performance.now();
  const decisions: Record<string, number> = {};
  const decision = (event: DecisionEvent) => { decisions[event.kind] = (decisions[event.kind] ?? 0) + 1; emitDecision(event); };
  const dir = mkdtempSync(join(tmpdir(), `elanous-${id.toLowerCase()}-`));
  const prepared = scenario.prepare(dir);
  if (id === 'S3') prepared3 = prepared;

  // --narrow-path drops package-manager bins so the shell has to find (or install) the tool itself.
  const env: Record<string, string> = { ...noProxyEnv(process.env as Record<string, string>), PS1: '$ ', PROMPT: '$ ' };
  if (opts.narrowPath) env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
  // --hide <tool> puts a stub first on PATH that answers «not found» — to walk the fallback path on a machine that has everything.
  if (opts.hide?.length) {
    const shim = join(dir, '.hide');
    mkdirSync(shim, { recursive: true });
    for (const tool of opts.hide) { const f = join(shim, tool); writeFileSync(f, `#!/bin/sh\necho "${tool}: hidden for this scenario" >&2\nexit 127\n`); chmodSync(f, 0o755); }
    env.PATH = `${shim}:${env.PATH ?? ''}`;
  }

  const choice = planViaCli(scenario.mission, env);
  const profile = choice.profile;
  decision({ kind: 'ROUTE', what: `칸 ${choice.rung} · ${choice.tool ?? '—'}`, reason: choice.reason, purpose: '가장 낮은 칸으로 끝낸다', target: choice.tool ?? 'harness' });
  const pty = startPty({ cmd: '/bin/sh', args: ['-i'], kind: 'shell', nickname: `scenario-${id.toLowerCase()}`, accessMode: 'auto', cols: 140, rows: 40, env, workdir: dir });
  const ref = pty.id;
  console.error(`[scenario] ${id} pty=${ref} run=${process.env.ELANOUS_RUN_ID ?? '?'}`);
  let install: ScenarioResult['install'] = 'not-needed';
  let installReason: string | undefined;
  let used: string | null = choice.tool;
  let fallback = false;
  try {
    await new Promise((resolve) => setTimeout(resolve, 400));
    if (scenario.docInstall) {
      const doc = await installFromDocs({ tool: scenario.docInstall.tool, smoke: scenario.docInstall.smoke, ptyRef: ref }, {
        typeLine: async (r, line) => { const t = await runPtyText(r, line, true, undefined, 'agent'); if (t.exitCode) throw new Error(t.message); },
        waitIdle: (r, o) => waitForPtyCompletion(r, o, snapshot),
        decision,
      });
      install = doc.outcome === 'dry-run' ? 'failed' : doc.outcome;
      installReason = `${doc.line ?? '—'} · ${doc.url ?? '—'} · ${doc.reason.slice(0, 120)}`;
      used = doc.outcome === 'installed' ? scenario.docInstall.tool : null;
    } else if (choice.tool) {
      const result = await installMissingTool({ tool: choice.tool as never, ptyRef: ref }, {
        typeLine: async (r, line) => { const t = await runPtyText(r, line, true, undefined, 'agent'); if (t.exitCode) throw new Error(t.message); },
        waitIdle: (r, o) => waitForPtyCompletion(r, o, snapshot),
        decision,
      });
      install = result.outcome;
      installReason = result.reason;
      if (result.outcome === 'escalate' || result.outcome === 'failed') {
        // The preferred tool needs a human (sudo / no remedy) — take the next lower tool that already works.
        // Same PATH as the PTY; the install module only knows its own tools, so the fallback carries its own check.
        const probe = scenario.fallback && spawnSync(scenario.fallback.cmd[0]!, scenario.fallback.cmd.slice(1), { env: envLiteral(env), encoding: 'utf8', timeout: 10_000 });
        if (scenario.fallback && probe && probe.status === 0 && probe.stdout.trim() === scenario.fallback.expect) {
          used = scenario.fallback.tool;
          fallback = true;
          decision({ kind: 'ROUTE', what: `${choice.tool} 대신 ${scenario.fallback.tool}`, reason: result.reason, purpose: '사람을 기다리지 않고 같은 칸의 다른 도구로', target: scenario.fallback.tool });
        } else used = null;
      }
    }
    const line = used ? scenario.line(used, dir) : null;
    let verdict: { ok: boolean; detail: string };
    if (!line) verdict = { ok: false, detail: `이 칸에 쓸 도구가 없다(${choice.tool ?? '—'} · ${installReason ?? ''})` };
    else {
      const rc = await runLine(ref, line, 120_000);
      verdict = rc === 0 ? scenario.check(dir, prepared) : { ok: false, detail: `셸 exit ${rc}` };
    }
    decision({ kind: 'VERIFY', what: `${id} 산출물 확인`, reason: verdict.detail, purpose: '산출물을 직접 잰다', target: 'shell' });
    if (opts.holdSeconds) await new Promise((resolve) => setTimeout(resolve, opts.holdSeconds! * 1000));
    return {
      scenario: id, mission: scenario.mission, rung: choice.rung, tool: choice.tool, chosenReason: choice.reason,
      install, ...(installReason ? { installReason } : {}), used, fallback,
      ok: verdict.ok, verdict: verdict.detail, seconds: Math.round((performance.now() - started) / 100) / 10,
      decisions, ptyId: ref, os: profile.os,
    };
  } finally {
    pty.kill();
    if (!opts.keep) rmSync(dir, { recursive: true, force: true });
  }
}

function table(r: ScenarioResult): string {
  const d = Object.entries(r.decisions).map(([k, n]) => `${k} ${n}`).join(' · ');
  return [
    `| 시나리오 | 칸 | 도구(→실제) | 설치 | 결과 | 소요 | 판단 |`,
    `|---|---|---|---|---|---|---|`,
    `| ${r.scenario} «${r.mission}» | ${r.rung} | ${r.tool ?? '—'}${r.fallback ? ` → ${r.used}` : ''} | ${r.install}${r.installReason && r.install !== 'already' ? ` (${r.installReason.slice(0, 60)})` : ''} | ${r.ok ? "✅" : "❌"} ${r.verdict.slice(0, 120)} | ${r.seconds}s | ${d} |`,
  ].join('\n');
}

if (import.meta.main) {
  const id = (process.argv[2] ?? '').toUpperCase() as ScenarioId;
  if (!(id in SCENARIOS)) { console.error('usage: bun scripts/pty-scenarios/run.ts <S1|S2|S3|S7|S8> [--narrow-path] [--hide <tool>]… [--hold <sec>] [--json] [--keep]'); process.exit(2); }
  const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
  const hide = process.argv.flatMap((v, i) => (process.argv[i - 1] === '--hide' ? [v] : []));
  const result = await runScenario(id, {
    narrowPath: process.argv.includes('--narrow-path'), keep: process.argv.includes('--keep'),
    ...(arg('--hold') ? { holdSeconds: Number(arg('--hold')) } : {}), ...(hide.length ? { hide } : {}),
  });
  console.log(process.argv.includes('--json') ? JSON.stringify(result) : table(result));
  process.exit(result.ok ? 0 : 1);
}
