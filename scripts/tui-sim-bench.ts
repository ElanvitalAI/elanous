// ── tui-sim-bench — 멀티모델 코드품질 벤치 (하나의 goal → N≤4 프로바이더 격리 비교 · 2026-07-20) ──
//
// 대표 요청: "한가지 골을 던졌을 때 멀티 프로바이더 코드 품질 비교"(격리 워크트리 기반). PR 까지 안 가고
// **worktree git diff** 로 비교한다. cloud(anthropic·grok·codex·gemini)·local(gemma-4·ornith 등) 혼합 지정.
//
// 구조:
//   1) 각 spec 마다 격리 state-dir(config+state) 준비 — 베이스 config 복사 후 provider/model override.
//   2) tui-sim start --test --worktree --state-dir <dir> 로 인스턴스별 워크트리 부팅.
//   3) 같은 goal 전송 → 자율 goal-loop 빌드.
//   4) 완료(GOAL COMPLETE)까지 폴링(타임아웃 가드).
//   5) 각 worktree `git diff`(stat+full) 수집.
//   6) diff-stat 표 + (옵션) LLM judge 로 코드품질 랭킹.
//
// ⚠️ 오염 규율(실측 교훈): **한 머신에서 로컬 goal-loop 을 동시 실행하면 클라이언트 기아로 correctness 가
//   깨진다.** 그래서 cloud spec(원격 API)은 동시, local spec(같은 endpoint)은 **직렬**로 돌린다.
//
// 사용:
//   bun run scripts/tui-sim-bench.ts \
//     --goal-file /tmp/goal.txt \
//     --spec opus=anthropic:claude-opus-4-8 \
//     --spec grok=grok:grok-4.3 \
//     --spec gemma=local:mlx-community/gemma-4-26b-a4b-it@http://localhost:1234 \
//     --spec ornith=local:ornith-1.0-9b@http://node-b:1234 \
//     [--judge anthropic:claude-opus-4-8] [--timeout 900] [--boot 10]
//
// spec 문법:  <label>=<provider>:<model>[@<baseUrl>]   (baseUrl 은 local 전용).
//   provider ∈ anthropic|grok|openai-codex|gemini|local.

import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, existsSync, cpSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
// 검증된 클린-빌드 앵커 단일 출처(self-implement self-run 과 공유 — 측정→운영 동일 규율).
import { CLEAN_BUILD_ANCHOR } from '../src/self-implement/build-discipline.js';

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

interface Spec { label: string; provider: string; model: string; baseUrl?: string; isLocal: boolean; }
interface Result { spec: Spec; worktree: string | null; diffStat: string; diff: string; completed: boolean; note: string; }

function argVal(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}
function argAll(args: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) if (args[i] === flag && i + 1 < args.length) out.push(args[i + 1]!);
  return out;
}

/** `<label>=<provider>:<model>[@<baseUrl>]` 파싱. */
function parseSpec(raw: string): Spec {
  const eq = raw.indexOf('=');
  if (eq < 0) throw new Error(`spec 형식 오류(= 없음): ${raw}`);
  const label = raw.slice(0, eq).trim();
  const rest = raw.slice(eq + 1).trim();
  const at = rest.indexOf('@');
  const body = at >= 0 ? rest.slice(0, at) : rest;
  const baseUrl = at >= 0 ? rest.slice(at + 1) : undefined;
  const colon = body.indexOf(':');
  if (colon < 0) throw new Error(`spec 형식 오류(provider:model 없음): ${raw}`);
  const provider = body.slice(0, colon).trim();
  const model = body.slice(colon + 1).trim();
  return { label, provider, model, baseUrl, isLocal: provider === 'local' };
}

/** 인스턴스별 격리 state-dir 준비 — 베이스 config 복사 후 provider/model override. */
function prepStateDir(benchRoot: string, spec: Spec): string {
  const dir = join(benchRoot, spec.label);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  // 베이스 config — **`.elanous-test/config.json`(서피스 off 테스트 config) 우선**. 프로덕션 `~/.elanous` 를
  // 복사하면 Discord/Telegram/MCP 등 전 서피스가 부팅돼(telegram 은 프로덕션 데몬과 409 Conflict) 노이즈로
  // goal 제출이 삼켜진다(실측). 테스트 config 는 서피스가 꺼진 클린 TUI → 순수 goal-loop.
  const baseCfg = [join(repoRoot, '.elanous-test', 'config.json'), join(homedir(), '.elanous', 'config.json'), join(homedir(), '.config', 'elanous', 'config.json')].find((p) => existsSync(p));
  if (baseCfg) cpSync(baseCfg, join(dir, 'config.json'));
  else console.error(`[bench] ⚠️ ${spec.label}: 베이스 config 없음 — provider 미설정 위험`);
  // provider/model override (config-dir 스코프).
  const cfg = (kv: string[]) => execFileSync('bun', ['run', join(repoRoot, 'bin/elanous.mjs'), ...kv, '--config-dir', dir], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ELANOUS_STATE_DIR: dir } });
  // 서피스 비활성화 — bench 인스턴스는 순수 goal-loop TUI 여야 한다. Telegram(프로덕션 데몬과 409
  // Conflict)·Discord·nexus autostart 가 켜지면 부팅 노이즈가 goal 제출(Enter)을 삼킨다(실측).
  for (const k of ['telegram.enabled', 'discord.enabled', 'nexus.autostart', 'nexus.enabled']) {
    try { cfg(['config', 'set', k, 'false']); } catch { /* 키 부재 무시 */ }
  }
  try {
    if (spec.isLocal) {
      const setup = ['local', 'setup', '--model', spec.model];
      if (spec.baseUrl) setup.push('--url', spec.baseUrl);
      cfg(setup);
    } else {
      cfg(['config', 'set', 'llm.provider', spec.provider]);
      cfg(['config', 'set', 'llm.model', spec.model]);
      // ⚠️ config 의 `.llm.apiKey` 는 활성 provider 키 하나뿐 → provider 만 바꾸면 엉뚱한 키로 호출("Incorrect key").
      // tui-sim PTY 는 env 미상속이므로 격리 config 에 provider별 올바른 키를 env 에서 주입해야 인증된다.
      const KEY_ENV: Record<string, string> = { grok: 'XAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', gemini: 'GEMINI_API_KEY', openai: 'OPENAI_API_KEY' };
      const envVar = KEY_ENV[spec.provider];
      const envKey = envVar ? process.env[envVar] : undefined;
      if (envKey) cfg(['config', 'set', 'llm.apiKey', envKey]);
      // openai-codex 는 OAuth(별도 토큰스토어) — apiKey 주입 불가. 복사된 config 의 codex 인증에 의존.
    }
    // #2 goal-loop 모드 — across-turn 반복 아밍(증거게이트까지). 단일턴 대신 반복 자기수정.
  } catch (e: any) { console.error(`[bench] ${spec.label} config override 경고: ${String(e?.message ?? e).slice(0, 120)}`); }
  return dir;
}

/** 한 spec 실행 — **헤드리스 에이전트**(`elanous chat --tools`)로 격리 워크트리에서 goal 빌드.
 *  tui-sim PTY 드라이빙(부팅·붙여넣기·서피스 노이즈)이 멀티라인 goal 제출에 근본적으로 취약해, 동일한
 *  tool-loop(Read/Grep/Edit/Write/Bash)을 헤드리스로 직접 돈다. cwd=worktree → Write/Edit 가 워크트리에
 *  쓰고, `git diff` 로 산출물 회수. config-dir 격리로 모델별 provider/키 적용.
 *  ⭐ goalLoop=true 면 `--goal-loop` 로 canonical goal-loop(runGoalLoop) 아밍 — across-turn 반복
 *  자기수정(증거게이트 GOAL-COMPLETE 까지). 아밍 경로는 이 플래그 하나다(CHAT-GOAL-LOOP-DEFAULT-OFF). */
async function runSpec(_spec: Spec, stateDir: string, goal: string, timeoutMs: number, goalLoop = false): Promise<{ worktree: string | null; completed: boolean; note: string; }> {
  const wt = join(stateDir, 'worktree');
  try { execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: repoRoot, stdio: 'ignore' }); } catch { /* 없음 */ }
  try { execFileSync('git', ['worktree', 'add', '--detach', wt, 'HEAD'], { cwd: repoRoot, stdio: 'ignore' }); }
  catch (e: any) { return { worktree: null, completed: false, note: `worktree 실패: ${String(e?.message ?? e).slice(0, 60)}` }; }
  try {
    execFileSync('bun', ['run', join(repoRoot, 'bin/elanous.mjs'), 'chat', '--tools', ...(goalLoop ? ['--goal-loop'] : []), '--config-dir', stateDir, goal], {
      cwd: wt, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ELANOUS_STATE_DIR: stateDir },
    });
    return { worktree: wt, completed: true, note: '완료' };
  } catch (e: any) {
    const timedOut = e?.killed === true || /ETIMEDOUT|SIGTERM/.test(String(e?.signal ?? e?.code ?? ''));
    return { worktree: wt, completed: !timedOut, note: timedOut ? '타임아웃' : `종료(${String(e?.message ?? e).slice(0, 50)})` };
  }
}

function git(cwd: string, args: string[]): string {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e: any) { return String(e?.stdout ?? ''); }
}

/** worktree 의 uncommitted diff 수집(stat + full·상한). untracked 포함(add -N). */
function collectDiff(worktree: string): { diffStat: string; diff: string } {
  git(worktree, ['add', '-A', '-N']); // untracked 를 diff 에 포함(intent-to-add)
  const diffStat = git(worktree, ['diff', '--stat']).trim();
  let diff = git(worktree, ['diff']);
  if (diff.length > 24_000) diff = diff.slice(0, 24_000) + '\n… [truncated]';
  return { diffStat, diff };
}

/** LLM judge — 모든 diff 를 한 프롬프트로 넣어 모델별 코드품질 점수/랭킹. judge 전용 config-dir(frontier
 *  모델 활성화)에서 `elanous chat --config-dir` 일회성 호출. ⚠️ chat 은 --provider/--model 플래그가 없고
 *  active provider 를 쓰므로, judge 모델은 config-dir 로 지정한다(모델별 인스턴스와 동형). */
async function judge(results: Result[], judgeSpec: string, goal: string, benchRoot: string): Promise<string> {
  const blocks = results.map((r) => `### [${r.spec.label}] (${r.spec.provider}:${r.spec.model}) · ${r.completed ? '완료' : '미완'}\n\`\`\`diff\n${r.diff || '(변경 없음)'}\n\`\`\``).join('\n\n');
  const prompt = [
    '너는 코드리뷰 심판이다. 하나의 동일한 구현 goal 을 여러 모델이 각자 격리 워크트리에서 구현한 diff 들이다.',
    '각 모델의 코드 품질을 **정확성(0-40)·완성도(goal 요구 충족·0-30)·간결성/가독성(0-20)·테스트(0-10)** 로 채점하고,',
    '100점 만점 총점과 한줄평을 매겨 **총점 내림차순 순위표**로 답하라. 마지막에 승자와 근거 2줄.',
    '',
    `## GOAL\n${goal}`,
    '',
    `## 제출물 (모델별 diff)\n${blocks}`,
  ].join('\n');
  const jspec = parseSpec(`judge=${judgeSpec}`);
  const jdir = prepStateDir(benchRoot, jspec);
  try {
    const out = execFileSync('bun', ['run', join(repoRoot, 'bin/elanous.mjs'), 'chat', '--config-dir', jdir, '--json', prompt], {
      cwd: repoRoot, encoding: 'utf8', timeout: 300_000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ELANOUS_STATE_DIR: jdir },
    });
    // --json → {reply,...} (마지막 JSON 라인).
    const jline = out.trim().split('\n').filter((l) => l.trim().startsWith('{')).pop();
    if (jline) { try { return (JSON.parse(jline).reply as string) ?? out.trim(); } catch { /* fall through */ } }
    return out.trim();
  } catch (e: any) { return `judge 실패: ${String(e?.message ?? e).slice(0, 200)}`; }
}

// ── 프롬프트 보강 (--goal-augment) — 관측된 약점 대응(grok/gemma 테스트누락·gemma 스텁) ──
// 전역 = 완료 규율(전 모델 동일). 프로바이더별 = 그 계열 약점 맞춤. 약한 모델을 공정 비교선까지 끌어올린다.
const GLOBAL_AUG = [
  '',
  '───────────────────────────────',
  '⚠️ 완료 규율 (반드시 준수):',
  '- TODO·placeholder·"곧 작성"/"I will write" 류 메타 주석 금지. 모든 함수를 실제로 **완전 구현**하라.',
  '- goal 의 **모든** 요구를 이행하라 — 테스트 파일 작성과 2차 엣지케이스까지 빠짐없이.',
  '- 완료를 선언하기 전에 `bun test <파일>` 을 실행해 **통과를 확인**하라(Bash 사용 가능).',
  '- 체크리스트를 모두 충족해야 완료: [ ] 구현 [ ] 테스트 파일 [ ] 테스트 통과 [ ] 엣지케이스.',
].join('\n');
const PER_PROVIDER_AUG: Record<string, string> = {
  // gemma 실측 실패모드(REPORT-gemma-goalloop-lever) 겨냥: ①spec-drift ②자문자답/dead-code 주석 잔존.
  // self-implement self-run 과 **동일 앵커 공유**(build-discipline.CLEAN_BUILD_ANCHOR·측정→운영 단일 출처).
  local: '\n' + CLEAN_BUILD_ANCHOR,
  grok: '\n- (반드시) goal 이 요구한 **테스트 파일**을 빠뜨리지 말고 생성하라 — 구현만 하고 끝내지 마라.',
};

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const goalFile = argVal(args, '--goal-file');
  const goalArg = argVal(args, '--goal');
  const goal = goalFile ? readFileSync(goalFile, 'utf8') : (goalArg ?? '');
  if (!goal.trim()) { console.error('goal 필요: --goal-file <path> 또는 --goal "<text>"'); process.exit(2); }
  const specs = argAll(args, '--spec').map(parseSpec);
  if (!specs.length || specs.length > 4) { console.error('--spec 은 1~4개(label=provider:model[@baseUrl])'); process.exit(2); }
  const judgeSpec = argVal(args, '--judge');
  const augEnabled = args.includes('--goal-augment'); // 전역+프로바이더별 프롬프트 보강
  const goalLoopMode = args.includes('--goal-loop');  // 헤드리스 반복 goal-loop(증거게이트까지·전 spec)
  // per-spec goal-loop — lever 효과 측정용(같은 goal 을 단일샷 vs 반복 나란히 비교). csv 라벨만 아밍.
  const loopLabels = new Set((argVal(args, '--loop-labels') ?? '').split(',').map((s) => s.trim()).filter(Boolean));
  // per-spec 프롬프트 보강 — 튜닝 효과 측정용(같은 goal 을 plain vs augmented 나란히 비교). csv 라벨만.
  const augLabels = new Set((argVal(args, '--augment-labels') ?? '').split(',').map((s) => s.trim()).filter(Boolean));
  const timeoutMs = (Number(argVal(args, '--timeout')) || 900) * 1000;
  const benchRoot = join(repoRoot, '.elanous-test', 'bench', `run-${execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()}`);
  mkdirSync(benchRoot, { recursive: true });

  console.error(`\n🏁 tui-sim-bench · ${specs.length}종 · goal ${goal.length}자${augEnabled ? ' · +보강' : ''}${goalLoopMode ? ' · +goal-loop' : ''}`);
  for (const s of specs) console.error(`  • ${s.label} = ${s.provider}:${s.model}${s.baseUrl ? ` @${s.baseUrl}` : ''} ${s.isLocal ? '[local]' : '[cloud]'}`);

  // cloud = 동시 · local = 직렬(오염 방지).
  const cloud = specs.filter((s) => !s.isLocal);
  const local = specs.filter((s) => s.isLocal);
  const results: Result[] = [];

  async function execOne(spec: Spec): Promise<Result> {
    const specLoop = goalLoopMode || loopLabels.has(spec.label); // 전역 또는 라벨 지정 시 반복 아밍
    const specAug = augEnabled || augLabels.has(spec.label);      // 전역 또는 라벨 지정 시 프롬프트 보강
    const dir = prepStateDir(benchRoot, spec);
    // 모델별 goal — 보강 활성 시 전역 완료규율 + 프로바이더별 맞춤 보강 append.
    const g = specAug ? goal + GLOBAL_AUG + (PER_PROVIDER_AUG[spec.provider] ?? '') : goal;
    console.error(`[bench] ▶ ${spec.label} 시작…${specLoop ? ' [goal-loop]' : ''}${specAug ? ` [augmented${PER_PROVIDER_AUG[spec.provider] ? '+' + spec.provider : ''}]` : ''}`);
    const r = await runSpec(spec, dir, g, timeoutMs, specLoop);
    const { diffStat, diff } = r.worktree ? collectDiff(r.worktree) : { diffStat: '', diff: '' };
    console.error(`[bench] ✔ ${spec.label} — ${r.note} (${Math.max(0, diffStat.split('\n').length - 1)} files)`);
    return { spec, worktree: r.worktree, diffStat, diff, completed: r.completed, note: r.note };
  }

  // ⚠️ 순서가 중요: cloud(원격 API)를 먼저 동시 실행·완료까지 대기 → 그 다음 local 을 직렬로.
  // cloud 와 local 을 겹쳐 돌리면 한 머신에 데몬이 몰려(gemma 추론 + N데몬 오케스트레이션) 클라이언트
  // 기아로 correctness 가 깨진다(실측 교훈). cloud 끼리는 원격이라 동시 안전.
  const cloudResults = await Promise.all(cloud.map(execOne));
  for (const s of local) results.push(await execOne(s)); // local 직렬(cloud 종료 후)
  results.push(...cloudResults);
  // 입력 순서로 정렬.
  results.sort((a, b) => specs.indexOf(a.spec) - specs.indexOf(b.spec));

  // ── 리포트 ──
  const lines: string[] = [];
  lines.push('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push(`🏆 tui-sim-bench 결과 — ${specs.length}종 · 동일 goal · 격리 worktree diff`);
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push(`${'모델'.padEnd(12)} ${'상태'.padEnd(8)} ${'파일'.padStart(4)} ${'diff(+ins/-del)'.padStart(16)}`);
  lines.push('─'.repeat(46));
  for (const r of results) {
    const files = r.diffStat ? Math.max(0, r.diffStat.split('\n').length - 1) : 0;
    const churn = r.diffStat.match(/(\d+) insertions?.*?(\d+) deletions?/)?.slice(1, 3).join('/') ?? r.diffStat.match(/(\d+) insertion/)?.[1] ?? '0';
    lines.push(`${r.spec.label.padEnd(12)} ${(r.completed ? '완료' : '미완').padEnd(8)} ${String(files).padStart(4)} ${String(churn).padStart(16)}`);
  }
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(lines.join('\n'));

  if (judgeSpec) {
    console.error('\n⚖️  LLM judge 채점 중…');
    console.log('\n' + (await judge(results, judgeSpec, goal, benchRoot)));
  }
  // 정리 안내(worktree 는 보존 — salvage/검토용).
  console.error(`\n📂 worktree 보존: ${results.map((r) => r.worktree).filter(Boolean).join(', ')}`);
  console.error(`   정리:  bun run scripts/tui-sim.ts clean --all`);
}

main().catch((e) => { console.error('tui-sim-bench 실패:', e); process.exit(1); });
