// ☸️ self-implement 자식을 k8s Job(Pod)으로 — 슈퍼바이저(`self orchestrate`)의 세 번째 실행 칸.
//
// 계약은 로컬 spawn(`defaultSelfImplementSpawn`)과 «같다»: 입력 → { address, done }. 그래서 분해·동시 실행 상한·
// 감독 루프·원장이 수정 없이 따라온다(RFC-elanous-on-docker-and-kubernetes-isolation-ladder · ROADMAP C2).
// Pod 안에서는 일반 골은 `self implement`, 전달된 ask 골 문서는 `harness ask` 로 실행하고 마지막 줄 JSON 을 Job 로그로 읽는다.
//
// 📏 2026-09-25 실측 근거(docker/harness · docker/runner):
//   · 자격 = 호스트 계정의 «refresh 없는» 사본(1회용 refresh 보호) — Secret(읽기 전용) → 쓰기 가능한 홈으로 복사.
//   · 격리 관문(initContainer) 필수 — kube-router 는 새 Pod 에 정책을 늦게 건다(첫 ~0.5초 운영 31415 에 닿음 3/3).
//   · 이미지는 `docker/harness/Dockerfile`(elanous 설치 ⊕ 정적 codex·짝·rg·gh) — 이 모듈은 이미지를 «만들지» 않는다.
// ⛔ worktreePath 는 Pod 안 경로라 호스트에서 쓸 수 없다 → disposition 에서 지운다.
// 부작용(kubectl·파일)은 주입받는다 — 시험은 가짜 kubectl 로 누른다.

import { podSkillsDigest, readSkillEnvFiles, resolvePodSkills } from './pod-skills.js';
import { podSourceScript, type PodSource } from './pod-source-receive.js';
import { GROUNDING_TOKEN_ENV, GROUNDING_URL_ENV, mintGroundingToken, revokeGroundingRun, type GroundingTokenScope } from '../../grounding/token.js';
import { POD_CREDENTIAL_GROK_PATH } from '../../nexus/api/pod-credential-api.js';
import { POD_CREDENTIAL_TOKEN_ENV, POD_CREDENTIAL_URL_ENV } from '../../grok/credential.js';
import { collectPodLedgers, createPodLedgerFollower } from './pod-ledger-collect.js';
import { collectPodArtifacts } from './pod-artifact-return.js';
import { effectiveInstanceRoot } from '../../instance/resolve.js';
import { controlInboxEnv } from '../../harness/control-inbox.js';
import { finishPodFragment, writePodFragment } from '../../harness/self-send-target.js';
import { mintRunId, normalizeRunId } from '../../harness/harness-space.js';
import { appendRunLedgerEntry, runLedgerDir, runLedgerPath } from '../../self-implement/run-ledger.js';
import type { GoalExecutionRecord } from '../../self-implement/orchestrator.js';

export const POD_CONTROL_INBOX_DIR = '/tmp/elanous-control.inbox';
/** Pod Job 수명 상한(`activeDeadlineSeconds`) — 대표 2026-09-26 90분 → 180분(90분에 `DeadlineExceeded` 로 죽은 런 둘). */
export const POD_JOB_DEADLINE_SECONDS = 10_800;

/** 자식 컨테이너 «요청» — 🩸 2026-09-27: limits 만 두면 k8s 가 requests=limits(cpu 4)로 잡아, 32코어 노드에
 *  «자리 요청»이 88% 차서 잡이 Pending 인데 실사용은 14%였다(풀 25 자리 중 ~8 만 떴다). 상한(limits)은 그대로 두고
 *  예약만 실사용에 맞춘다. */
export const POD_CHILD_REQUESTS = { cpu: '1', memory: '4Gi' } as const;
import type { PodPoolMember, PodPoolScheduler } from './pod-pool.js';
import { ACTUAL_SUBSTRATE_ENV, RUN_CONTRACT_ENV, carryRunContract, completionFloorFor } from '../../self-implement/graph-run-contract.js';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { findGitDir } from '../../git-fs/locate.js';
import { debug } from '../../debug/log.js';
import { authStorePath } from '../../oauth/store.js';
import { grokAuthFilePath, resolveGrokCredential } from '../../grok/credential.js';
import { defaultGrokModel } from '../../grok/models.js';
import { resolveHostId } from '../../platform/host-id.js';
import { LLM_TIER_MAP_BY_PROVIDER, lookupLlmTierSpec, type LlmTierProvider } from '../../model-tier/llm-tier-map.js';
import { parseSelfImplementJson, type SelfImplementJobDone, type SelfImplementJobSpawn } from './self-implement.js';

export type Kubectl = (args: readonly string[], input?: string) => { status: number | null; stdout: string; stderr: string };

export interface PodSpawnOptions {
  /** 이미지 판(라벨 elanous.commit) — 주입(시험·감독기가 이미 잰 값). 없으면 docker 로 잰다. */
  imageCommit?: string | null;
  /** codex 계정 이름(`~/.elanous/auth.json` 의 `openai-codex:<이름>`). 기본 team. */
  account?: string;
  /** Job 마다 계정을 고른다(pod-account-broker) — 있으면 `account` 보다 먼저. */
  accountBroker?: () => string;
  /** 미지정이면 종전 Codex Job. */
  provider?: 'openai-codex' | 'grok';
  /** 🔐 API 키 과금 허용은 명시 true 뿐. */
  grokApiKeyOptIn?: boolean;
  namespace?: string;
  /** 클러스터 안 이미지(`docker/harness/run.sh` 가 만드는 `elanous-harness:local`). */
  image?: string;
  repoUrl?: string;
  /** 원천 — 없으면 종전 `git clone --depth 50`. bundle 이면 apply 뒤 kubectl cp 로 싣는다. */
  source?: PodSource;
  /** 호스트 환경에서 읽어 Pod env 로 넣을 키 이름(예: OPENROUTER_API_KEY · ANTHROPIC_API_KEY) — 벤치마크 과금 경로. */
  passEnv?: readonly string[];
  /** 자식 `self implement` 에 덧붙일 인자. */
  extraArgs?: readonly string[];
  /** Pod 에 그대로 넣을 «비밀 아닌» env — 벤치 팔의 `ELANOUS_LLM_PROVIDER`·`ELANOUS_LLM_MODEL`·`ELANOUS_ARM_ID`. */
  armEnv?: Readonly<Record<string, string>>;
  /** Job 수명 상한(초). */
  deadlineSeconds?: number;
  pollMs?: number;
  kubectl?: Kubectl;
  /** 🔑 Pod 필수 스킬의 키(.env)를 이 런의 Secret 으로 넘긴다 — 명시 opt-in(유료 크레딧을 쓴다). */
  skillEnv?: boolean;
  /** 스킬 키 읽기(시험 주입) — `{ <스킬>: <.env 내용> }`. */
  readSkillEnv?: () => Record<string, string>;
  /** ☸️ 여러 클러스터 풀(pod-pool.ts) — Job 마다 우선순위 순 첫 빈 자리로. 없으면 현재 컨텍스트 하나. */
  pool?: PodPoolScheduler;
  /** ☸️ 원격 그라운딩 주소(P13) — 없으면 호스트 env ELANOUS_GROUNDING_URL → 설정 pod.groundingUrl. 셋 다 없으면 토큰을 안 만든다. */
  groundingUrl?: string;
  /** 시험 심 — 토큰 발급·회수. scope 는 그라운딩 발급에는 안 넘기고, grok 구독 중계 발급에만 'llm-credential' 로 넘긴다. */
  mintGrounding?: (claims: { runId: string; job: string; ttlMs: number; scope?: GroundingTokenScope }) => Promise<{ token: string; exp: number }>;
  revokeGrounding?: (runId: string) => void;
  sleep?: (ms: number) => Promise<void>;
  credentials?: () => { elanousAuth: string; codexAuth: string; ghToken: string };
  grokCredentials?: () => { grokAuth?: string; grokApiKey?: string; ghToken: string };
  /** 호스트 키 캐시(`~/.cache/<소문자 이름>`)에서 키를 읽는다(시험 주입) — env 에 없을 때. */
  readKeyCache?: (name: string) => string | undefined;
  env?: NodeJS.ProcessEnv;
}

export function defaultKubectl(args: readonly string[], input?: string): { status: number | null; stdout: string; stderr: string } {
  // 셸 프록시가 kubectl 의 로컬 API 요청을 가로챈다(2026-09-25 실측) — 자식 env 에서 뺀다.
  const env = { ...process.env };
  for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) delete env[k];
  const r = spawnSync('kubectl', [...args], { encoding: 'utf8', input, env, timeout: 120_000 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: (r.stderr ?? '') + (r.error ? String(r.error) : '') };
}

/** Job·Secret 이름 — 런마다 다르게(병렬) · k8s 이름 규칙(소문자·숫자·하이픈 · 63자 이하). */
export function podJobName(spaceId: string): string {
  const slug = spaceId.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  const hash = createHash('sha256').update(spaceId).digest('hex').slice(0, 8);
  return `si-${slug || 'job'}-${hash}`.replace(/-+/g, '-').slice(0, 58);
}

/** 호스트 계정 → refresh 없는 사본(elanous 저장소 ⊕ codex auth.json) ⊕ gh 토큰. */
export function hostCredentials(account: string, storePath: string = authStorePath(), ghToken: () => string = defaultGhToken): { elanousAuth: string; codexAuth: string; ghToken: string } {
  // 경로는 해석기로(격리 게이트 · 2026-09-25) — 손으로 `~/.elanous/auth.json` 을 조립하면 test↔prod 격리가 새는 자리가 된다.
  const store = JSON.parse(readFileSync(storePath, 'utf8')) as { version?: number; providers: Record<string, Record<string, unknown>> };
  const entry = store.providers[`openai-codex:${account}`] as { tokens: Record<string, unknown>; lastRefresh?: string; authMode?: string; codexHome?: string } | undefined;
  if (!entry?.codexHome) throw new Error(`openai-codex:${account} 계정이 없거나 codexHome 을 모른다`);
  const codex = JSON.parse(readFileSync(join(entry.codexHome, 'auth.json'), 'utf8')) as { tokens: Record<string, unknown> };
  const access = String(codex.tokens.access_token ?? '');
  const exp = Number(JSON.parse(Buffer.from(access.split('.')[1] ?? '', 'base64url').toString('utf8') || '{}').exp ?? 0);
  if (exp * 1000 - Date.now() < 3 * 3600_000) throw new Error(`openai-codex:${account} access token 이 3시간 안에 만료 — 호스트에서 먼저 갱신(컨테이너는 갱신 못 한다)`);
  const elanousAuth = JSON.stringify({
    version: store.version ?? 1,
    // ⭐ P4(2026-09-26): elanous 사본도 «방금 검사한» codex 홈의 토큰으로 싣는다 — 두 저장소는 따로 갱신된다.
    //   🩸 실측: third 는 elanous 쪽 토큰이 4시간 전에 만료됐고 codex 홈 쪽은 235시간 남아 있었다 → Pod 가 갱신 400 으로 첫 호출 전에 죽었다(할당량 소진으로 오분류).
    providers: { 'openai-codex': { tokens: { ...entry.tokens, accessToken: access, expiresAt: exp * 1000, refreshToken: '' }, lastRefresh: entry.lastRefresh, authMode: entry.authMode, chatGPT: { accountId: codex.tokens.account_id } } },
  });
  const codexAuth = JSON.stringify({ ...codex, tokens: { ...codex.tokens, refresh_token: '' } });
  return { elanousAuth, codexAuth, ghToken: ghToken() };
}

/** resolveGrokCredential 과 동일한 출처를 읽되 Pod 로는 refresh 없는 access 사본만 보낸다. */
export function hostGrokCredentials(opts: {
  home?: string; env?: NodeJS.ProcessEnv; apiKeyOptIn?: boolean; ghToken?: () => string;
} = {}): { grokAuth?: string; grokApiKey?: string; ghToken: string } {
  const credential = resolveGrokCredential({ home: opts.home, env: opts.env });
  if (credential?.kind === 'subscription') {
    const scopes = JSON.parse(readFileSync(grokAuthFilePath(opts.home), 'utf8')) as Record<string, unknown>;
    const redacted: Record<string, { key: string; expires_at?: string; user_id?: string }> = {};
    for (const [name, value] of Object.entries(scopes)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const scope = value as Record<string, unknown>;
      if (scope.key !== credential.token) continue;
      redacted[name] = {
        key: scope.key,
        ...(typeof scope.expires_at === 'string' ? { expires_at: scope.expires_at } : {}),
        ...(typeof scope.user_id === 'string' ? { user_id: scope.user_id } : {}),
      };
    }
    if (!Object.keys(redacted).length) throw new Error('grok: 구독 access 토큰 없음');
    return { grokAuth: JSON.stringify(redacted), ghToken: (opts.ghToken ?? defaultGhToken)() };
  }
  if (credential?.kind === 'api_key' && opts.apiKeyOptIn === true) {
    return { grokApiKey: credential.token, ghToken: (opts.ghToken ?? defaultGhToken)() };
  }
  throw new Error('grok: 구독 자격 없음 · API 키 opt-in 꺼짐 또는 키 없음');
}

/** 키 캐시 관례: `~/.cache/<env 이름 소문자>`(예: OPENROUTER_API_KEY → ~/.cache/openrouter_api_key · src/config.ts 와 같다). */
function defaultReadKeyCache(name: string): string | undefined {
  try { const v = readFileSync(join(homedir(), '.cache', name.toLowerCase()), 'utf8').trim(); return v || undefined; } catch { return undefined; }
}

export function defaultGhToken(): string {
  const r = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout.trim()) throw new Error('gh auth token 실패 — 호스트에서 gh auth login');
  return r.stdout.trim();
}

/** Job 스크립트의 salvage 단계 — 자식 rc 가 0 이 아닐 때만, 변경·미푸시 커밋이 있는 격리 워크트리를 `salvage/<job>/<worktree>` 로 push.
 *  main·self-impl/ 로는 절대 안 민다. 실패해도 제어 흐름을 바꾸지 않는다(호출자는 이 뒤에 `exit $rc`). */
export function podSalvageScript(): string {
  return [
    'if [ "${rc:-0}" -ne 0 ]; then',
    '  job_name="${ELANOUS_POD_NAME:-unknown-job}"',
    '  salvage_any=0',
    '  while IFS= read -r wt; do',
    '    [ -n "$wt" ] || continue',
    '    case "$wt" in',
    '      /*) ;;',
    "      *) printf 'ELANOUS_POD_SALVAGE_NONE bad-worktree-path\\n'; continue ;;",
    '    esac',
    '    wt_name=$(basename -- "$wt")',
    '    case "$wt_name" in',
    "      ''|.*|*/*|*'..'*) printf 'ELANOUS_POD_SALVAGE_NONE bad-worktree-name\\n'; continue ;;",
    '    esac',
    '    branch="salvage/${job_name}/${wt_name}"',
    '    case "$branch" in',
    '      salvage/*) ;;',
    "      *) printf 'ELANOUS_POD_SALVAGE_NONE refused-prefix\\n'; continue ;;",
    '    esac',
    '    case "$branch" in',
    "      main|self-impl|self-impl/*) printf 'ELANOUS_POD_SALVAGE_NONE refused-prefix\\n'; continue ;;",
    '    esac',
    '    (',
    '      set +e',
    '      cd -- "$wt" || { printf \'ELANOUS_POD_SALVAGE_NONE cd-failed\\n\'; exit 0; }',
    '      git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { printf \'ELANOUS_POD_SALVAGE_NONE not-a-worktree\\n\'; exit 0; }',
    '      dirty=0',
    '      git diff --quiet || dirty=1',
    '      git diff --cached --quiet || dirty=1',
    '      if [ -n "$(git ls-files --others --exclude-standard)" ]; then dirty=1; fi',
    '      ahead=0',
    '      if git rev-parse --verify HEAD >/dev/null 2>&1; then',
    "        if git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then",
    "          if [ \"$(git rev-list --count '@{u}..HEAD' 2>/dev/null || true)\" != 0 ]; then ahead=1; fi",
    '        else',
    '          if git rev-parse --verify origin/HEAD >/dev/null 2>&1; then',
    '            base=$(git rev-parse origin/HEAD)',
    '          elif git rev-parse --verify origin/main >/dev/null 2>&1; then',
    '            base=$(git rev-parse origin/main)',
    '          else',
    '            base=$(git rev-list --max-parents=0 HEAD 2>/dev/null | head -n 1)',
    '          fi',
    '          if [ -n "$base" ] && [ "$(git rev-list --count "${base}..HEAD" 2>/dev/null || true)" != 0 ]; then ahead=1; fi',
    '        fi',
    '      fi',
    '      if [ "$dirty" -eq 0 ] && [ "$ahead" -eq 0 ]; then',
    "        printf 'ELANOUS_POD_SALVAGE_NONE clean\\n'",
    '        exit 0',
    '      fi',
    '      if [ "$dirty" -eq 1 ]; then',
    "        git add -A -- . || { printf 'ELANOUS_POD_SALVAGE_NONE add-failed\\n'; exit 0; }",
    '        git commit -m "salvage: ${job_name} rc=${rc}" || { printf \'ELANOUS_POD_SALVAGE_NONE commit-failed\\n\'; exit 0; }',
    '      fi',
    '      git push origin "HEAD:refs/heads/${branch}" || { printf \'ELANOUS_POD_SALVAGE_NONE push-failed\\n\'; exit 0; }',
    '      commit=$(git rev-parse HEAD) || { printf \'ELANOUS_POD_SALVAGE_NONE rev-parse-failed\\n\'; exit 0; }',
    "      printf 'ELANOUS_POD_SALVAGE %s %s\\n' \"$branch\" \"$commit\"",
    '    )',
    '    salvage_any=1',
    "  done < <(git worktree list --porcelain | awk '/^worktree / { sub(/^worktree /, \"\"); print }')",
    "  if [ \"$salvage_any\" -eq 0 ]; then printf 'ELANOUS_POD_SALVAGE_NONE no-worktree\\n'; fi",
    'fi',
  ].join('\n');
}
const GATE = `ok=0
for i in $(seq 1 60); do
  if curl -s -m 1 -o /dev/null http://host.orb.internal:31415/health || curl -s -m 1 -o /dev/null http://core.elanous-prod:8080/; then ok=0; else ok=$((ok+1)); fi
  [ "$ok" -ge 3 ] && { echo "[gate] isolation enforced after \${i} probes"; exit 0; }
  sleep 0.5
done
echo "[gate] ISOLATION NOT ENFORCED within 30s"; exit 1`;

/** Job 매니페스트(JSON) — docker/harness/job.yaml 과 같은 격리(관문 ⊕ 읽기 전용 Secret ⊕ 한도). */
export function podJobManifest(o: { name: string; namespace: string; image: string; /** 레지스트리 이미지면 IfNotPresent(노드가 pull) · 반입 이미지면 Never. */ imagePullPolicy?: 'Never' | 'IfNotPresent'; repoUrl: string; source?: PodSource; args: readonly string[]; passEnv: readonly string[]; deadlineSeconds: number; runId?: string; parentRunId?: string; armEnv?: Readonly<Record<string, string>>; hostId?: string; imageCommit?: string | null; skillEnvs?: readonly string[]; memoryLimit?: string; goalDoc?: string; grokCredential?: 'subscription' | 'api_key' }): Record<string, unknown> {
  const quoted = o.args.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
  const goalPath = o.goalDoc ? `'${(o.goalDoc.startsWith('-') ? `./${o.goalDoc}` : o.goalDoc).replace(/'/g, `'\\''`)}'` : undefined;
  const askBaseIndex = o.goalDoc ? o.args.indexOf('--base') : -1;
  const quotedAsk = (askBaseIndex >= 0 && o.args[askBaseIndex + 1]
    ? ` '--base' '${o.args[askBaseIndex + 1]!.replace(/'/g, `'\\''`)}'`
    : '') + (o.goalDoc && o.args.includes('--open-pr') && !o.args.includes('--auto-merge') ? ' --no-auto-merge' : '');
  const script = [
    'set -u',
    o.grokCredential === 'subscription'
      ? 'mkdir -p ~/.grok && install -m 600 /creds/grok-auth.json ~/.grok/auth.json && export ELANOUS_LLM_PROVIDER=grok'
      : o.grokCredential === 'api_key'
        ? 'mkdir -p ~/.grok && install -m 600 /creds/grok-api-key ~/.grok/api-key && export XAI_API_KEY="$(cat ~/.grok/api-key)" && export ELANOUS_LLM_PROVIDER=grok'
        : 'mkdir -p ~/.elanous ~/.codex && cp /creds/elanous-auth.json ~/.elanous/auth.json && cp /creds/codex-auth.json ~/.codex/auth.json && chmod 600 ~/.elanous/auth.json ~/.codex/auth.json',
    'export GH_TOKEN="$(cat /creds/gh-token)"',
    // 🔑 스킬 키(.env) — 이미지엔 없다. 이 런의 Secret 에서 각 스킬 폴더로 0600 복사(값은 로그에 안 나온다).
    ...(o.skillEnvs?.length ? [`for n in ${o.skillEnvs.join(' ')}; do [ -d ~/.claude/skills/$n ] && install -m 600 /creds/skillenv-$n ~/.claude/skills/$n/.env; done; echo "[pod] skill env: ${o.skillEnvs.join(',')}"`] : []),
    'git config --global user.name "elanous pod child" && git config --global user.email "noreply@anthropic.com" && gh auth setup-git',
    'curl -s -m 3 -o /dev/null http://host.orb.internal:31415/health && { echo "[pod] ISOLATION FAIL"; exit 3; }',
    podSourceScript(o.source ?? { kind: 'default' }, o.repoUrl),
    ...(goalPath ? [
      `mkdir -p -- "$(dirname -- ${goalPath})" && cp -- /creds/goal-doc ${goalPath} || exit 6`,
    ] : []),
    // 마지막 줄 JSON 이 «맨 끝»이어야 한다(parseSelfImplementJson) — rollup 은 그 앞에.
    goalPath
      ? `elanous harness ask ${goalPath} --json${quotedAsk} > /tmp/si.out 2>&1; rc=$?; bun -e 'const fs=require("fs");const p="/tmp/si.out";const s=fs.readFileSync(p,"utf8");const line=s.trimEnd().split("\\n").at(-1);try{const o=JSON.parse(line);if(o.kind==="self"&&o.result&&typeof o.result==="object")fs.appendFileSync(p,"\\n"+JSON.stringify({...o.result,...(typeof o.ok==="boolean"?{ok:o.ok}:{})})+"\\n")}catch{}'`
      : `elanous self implement "$(cat /creds/feature)" --json ${quoted} > /tmp/si.out 2>&1; rc=$?`,
    'cat /tmp/si.out',
    '[ -f scripts/usage-rollup.ts ] && bun scripts/usage-rollup.ts --since 12h || echo "ELANOUS_USAGE_ROLLUP {\"measured\":false,\"reason\":\"no rollup script\"}"',
    `if mkdir -p "$HOME/outbox/pod-logs" && elanous logs --all --include-test --since 12h --limit 20000 --json > "$HOME/outbox/pod-logs/logs.jsonl"; then
  :
else
  logs_rc=$?
  rm -f "$HOME/outbox/pod-logs/logs.jsonl"
  printf 'ELANOUS_POD_LOGS_UNAVAILABLE export-exit-%s\\n' "$logs_rc"
fi`,
    `set -o pipefail
artifact_bytes=0
if [ -d "$HOME/outbox" ]; then
  while IFS= read -r -d '' file; do
    [ -f "$file" ] && [ ! -L "$file" ] || continue
    relative=\${file#"$HOME/outbox/"}
    size=$(( $(wc -c < "$file") ))
    if [ "$size" -gt 5242880 ] || [ $((artifact_bytes + size)) -gt 20971520 ]; then
      printf 'ELANOUS_POD_ARTIFACT_SKIPPED %s %s\\n' "$relative" "$size"
      continue
    fi
    path_token=$(printf '%s' "$relative" | base64 | tr -d '\\n' | tr '+/' '-_' | tr -d '=')
    if encoded=$(gzip -c "$file" | base64 | tr -d '\\n'); then
      artifact_bytes=$((artifact_bytes + size))
      total=$(( (\${#encoded} + 7999) / 8000 ))
      for ((n=1; n<=total; n++)); do
        chunk=\${encoded:$(( (n-1)*8000 )):8000}
        printf 'ELANOUS_POD_ARTIFACT %s %s/%s %s\\n' "$path_token" "$n" "$total" "$chunk"
      done
    else
      printf 'ELANOUS_POD_ARTIFACT_SKIPPED %s %s\\n' "$relative" "$size"
    fi
  done < <(find "$HOME/outbox" -type f -print0)
fi
found=0
for ledger in "\${ELANOUS_STATE_DIR:-$HOME/.elanous}"/run-ledger/*.jsonl; do
  [ -f "$ledger" ] || continue
  found=1
  run_id=\${ledger##*/}; run_id=\${run_id%.jsonl}
  if encoded=$(gzip -c "$ledger" | base64 | tr -d '\\n'); then
    total=$(( (\${#encoded} + 7999) / 8000 ))
    for ((n=1; n<=total; n++)); do
      chunk=\${encoded:$(( (n-1)*8000 )):8000}
      printf 'ELANOUS_RUN_LEDGER %s %s/%s %s\\n' "$run_id" "$n" "$total" "$chunk"
    done
  else
    echo "[pod] ledger transfer failed: $run_id" >&2
  fi
done
if [ "$found" -eq 0 ]; then echo ELANOUS_RUN_LEDGER_NONE; fi`,
    'tail -n 1 /tmp/si.out',
    podSalvageScript(),
    'exit $rc',
  ].join('\n');
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: o.name, namespace: o.namespace, labels: { 'elanous.substrate': 'pod', 'elanous.job': o.name } },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: 7200,
      activeDeadlineSeconds: o.deadlineSeconds,
      template: {
        // ⭐ Pod 라벨 — local 팔만 `elanous.egress/local-llm` 을 단다. docker/h1/policy-local-llm.yaml 이 그 라벨에만 호스트 LLM 포트 «하나»를 연다.
        metadata: { labels: { 'elanous.job': o.name, ...(o.armEnv?.ELANOUS_LLM_PROVIDER === 'local' ? { 'elanous.egress/local-llm': 'true' } : {}) } },
        spec: {
          restartPolicy: 'Never',
          securityContext: { runAsUser: 1000, fsGroup: 1000 },
          initContainers: [{ name: 'isolation-gate', image: o.image, imagePullPolicy: o.imagePullPolicy ?? 'Never', command: ['bash', '-c'], args: [GATE] }],
          containers: [{
            name: 'child', image: o.image, imagePullPolicy: o.imagePullPolicy ?? 'Never',
            // 📏 09-25: 6Gi 는 빠듯했다 — 자식이 6,127Mi 에 붙어 OOMKilled(137). 기본 12Gi · ELANOUS_POD_MEMORY 로 조정.
            resources: { requests: { ...POD_CHILD_REQUESTS }, limits: { memory: o.memoryLimit ?? '12Gi', cpu: '4' } },
            command: ['bash', '-c'], args: [script],
            env: [
              ...(o.runId ? [{ name: 'ELANOUS_RUN_ID', value: o.runId }] : []),
              ...(o.parentRunId ? [{ name: 'ELANOUS_PARENT_RUN_ID', value: o.parentRunId }] : []),
              { name: 'ELANOUS_SUBSTRATE', value: 'pod' },
              ...Object.entries(controlInboxEnv(POD_CONTROL_INBOX_DIR)).map(([name, value]) => ({ name, value })),
              // ⭐ 런 출처(🅣 RFC run-origin §A3 · #20457/#20468 칸 이름) — Pod 는 자기 elanous_id 를 쓰지 않고 «띄운 감독기»의 hostId 를 물려받는다.
              { name: 'ELANOUS_POD_NAME', valueFrom: { fieldRef: { fieldPath: 'metadata.name' } } },
              { name: 'ELANOUS_NODE_NAME', valueFrom: { fieldRef: { fieldPath: 'spec.nodeName' } } },
              { name: 'ELANOUS_POD_NAMESPACE', valueFrom: { fieldRef: { fieldPath: 'metadata.namespace' } } },
              ...(o.hostId ? [{ name: 'ELANOUS_HOST_ID', value: o.hostId }] : []),
              ...(o.imageCommit ? [{ name: 'ELANOUS_IMAGE_COMMIT', value: o.imageCommit }] : []),
              // ⭐ 런 계약(graph-run-contract.ts) — 이 칸이 «실제로» Pod 이고, 부모가 정한 계약도 Pod 다. 안의 그래프가 노드마다 대조한다.
              { name: ACTUAL_SUBSTRATE_ENV, value: 'pod' }, { name: RUN_CONTRACT_ENV, value: carryRunContract({ substrate: 'pod' }) },
              ...Object.entries(o.armEnv ?? {}).map(([name, value]) => ({ name, value })),
              ...o.passEnv.map((key) => ({ name: key, valueFrom: { secretKeyRef: { name: `${o.name}-creds`, key: `env-${key}` } } })),
            ],
            volumeMounts: [{ name: 'creds', mountPath: '/creds', readOnly: true }],
          }],
          volumes: [{ name: 'creds', secret: { secretName: `${o.name}-creds`, defaultMode: 0o400 } }],
        },
      },
    },
  };
}

async function waitForRunningPod(kubectl: Kubectl, namespace: string, job: string, sleep: (ms: number) => Promise<void>): Promise<string | null> {
  for (let i = 0; i < 60; i++) {
    const listed = kubectl(['-n', namespace, 'get', 'pods', '-l', `job-name=${job}`, '-o', 'jsonpath={range .items[*]}{.metadata.name} {.status.phase}{"\\n"}{end}']);
    const running = listed.stdout.split('\n').map((line) => line.trim().split(/\s+/)).find((parts) => parts[1] === 'Running');
    if (running?.[0]) return running[0];
    await sleep(250);
  }
  return null;
}

export function podSelfImplementSpawn(options: PodSpawnOptions = {}): SelfImplementJobSpawn {
  const baseKubectl = options.kubectl ?? defaultKubectl;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const namespace = options.namespace ?? 'elanous-test';
  const image = options.image ?? 'elanous-harness:local';
  const repoUrl = options.repoUrl ?? 'https://github.com/ElanvitalAI/elanous';
  const env = options.env ?? process.env;
  const memoryLimit = env.ELANOUS_POD_MEMORY?.trim() || '12Gi';
  return (input) => {
    const name = podJobName(input.spaceId);
    const childRunId = mintRunId();
    const parentRunId = env.ELANOUS_RUN_ID?.trim();
    const address = `self-impl:${input.spaceId}`;
    const ledgerDir = runLedgerDir(env.ELANOUS_STATE_DIR);
    const args = [
      ...(input.base ? ['--base', input.base] : []),
      ...(input.autoMerge ? ['--auto-merge'] : []),
      ...(input.autoReview ? ['--auto-review'] : []),
      // ⭐ 계약이 미래 노드를 바꾼다(첫 규칙): Pod 는 끝나면 사라지므로 완료 하한 = PR. 작업 트리로만 끝나면 결과가 Pod 와 함께 없어진다.
      //   ⚠️ 임시 안전망(🅢 2026-09-26) — 🅣 의 «종결 하한 오버레이»(그래프 쪽)가 서면 이 줄을 지우고 그것으로 바꾼다(채널 합의).
      ...(input.openPr || (!input.autoMerge && completionFloorFor({ substrate: 'pod' }) === 'pr') ? ['--open-pr'] : []),
      ...(input.draft === false ? ['--no-draft'] : []),
      ...(options.extraArgs ?? []),
      ...(options.provider === 'grok' ? ['--child-llm-provider', 'grok', '--child-llm-model', defaultGrokModel().id] : []),
    ];
    const done = (async (): Promise<SelfImplementJobDone> => {
      // ☸️ 풀이면 자리를 잡는다(우선순위 순 · 다 차면 기다린다) — 그 노드의 컨텍스트로 모든 호출을 묶는다.
      let member: PodPoolMember | null = null;
      if (options.pool) {
        for (;;) {
          if (input.signal?.aborted) return { exitCode: null, output: '', error: { code: 'aborted', message: 'aborted before a pool slot opened' } };
          member = options.pool.tryAcquire();
          if (member) break;
          await sleep(options.pollMs ?? 15_000);
        }
        debug.log('self-implement.pod', 'pool-slot', { spaceId: input.spaceId, context: member.context, inflight: options.pool.snapshot() });
      }
      const currentContext = member ? null : baseKubectl(['config', 'current-context']);
      const context = member?.context ?? (currentContext?.status === 0 ? currentContext.stdout.trim() : '');
      const kubectl: Kubectl = (args, stdin) => baseKubectl(['--context', context, ...args], stdin);
      let recorded = false;
      let groundingMinted: string | null = null;
      try {
      if (!context) return { exitCode: 1, output: '', error: { code: 'pod-context', message: 'Pod Job context를 확인할 수 없다' } };
      const cleanupSecret = () => { kubectl(['-n', namespace, 'delete', 'secret', `${name}-creds`, '--ignore-not-found']); };
      const collectFullLogs = (unavailableEvent: string, replace?: ReadonlySet<string>, onEvent?: (event: string, data: Record<string, unknown>) => void, childId?: string): { status: 'ok' | 'unavailable' | 'incomplete'; childLedgerIncomplete: boolean } => {
        let full: ReturnType<Kubectl>;
        try {
          full = kubectl(['-n', namespace, 'logs', `job/${name}`, '-c', 'child']);
          if (full.status !== 0) throw new Error(full.stderr || `kubectl logs exited ${full.status}`);
          if (!full.stdout && unavailableEvent === 'failed-job-logs-unavailable') throw new Error('empty child logs');
        } catch (error) {
          debug.log('self-implement.pod', unavailableEvent, { job: name, reason: error instanceof Error ? error.message : String(error) });
          return { status: 'unavailable', childLedgerIncomplete: false };
        }
        let ledgerIncomplete = false;
        let childLedgerIncomplete = false;
        let artifactIncomplete = false;
        const record = (category: string, event: string, data: Record<string, unknown>) => {
          if (event === 'ledger-collect-incomplete' || event === 'ledger-collect-skipped') {
            ledgerIncomplete = true;
            if (childId && (data.runId === childId || !data.runId)) childLedgerIncomplete = true;
          }
          if (event === 'artifact-collect-incomplete' || event === 'artifact-collect-skipped') artifactIncomplete = true;
          debug.log(category, event, data);
          onEvent?.(event, data);
        };
        try { collectPodLedgers(full.stdout, { dir: ledgerDir, ...(replace ? { replace } : {}), log: record }); }
        catch (error) { record('self-implement.pod', 'ledger-collect-incomplete', { job: name, reason: error instanceof Error ? error.message : String(error) }); }
        try {
          collectPodArtifacts(full.stdout, { dir: join(effectiveInstanceRoot(), 'pod-artifacts'), job: name, log: record });
        }
        catch (error) { record('self-implement.pod', 'artifact-collect-incomplete', { job: name, reason: error instanceof Error ? error.message : String(error) }); }
        return { status: ledgerIncomplete || artifactIncomplete ? 'incomplete' : 'ok', childLedgerIncomplete };
      };
      try {
        const grok = options.provider === 'grok';
        const account = grok ? 'grok' : options.accountBroker?.() ?? options.account ?? 'team';
        debug.log('self-implement.pod', 'account', { spaceId: input.spaceId, account, brokered: Boolean(options.accountBroker) });
        const creds = grok
          ? (options.grokCredentials ?? (() => hostGrokCredentials({ env, apiKeyOptIn: options.grokApiKeyOptIn })))()
          : (options.credentials ?? (() => hostCredentials(account)))();
        if (grok && !('grokAuth' in creds && creds.grokAuth) && !('grokApiKey' in creds && creds.grokApiKey && options.grokApiKeyOptIn === true)) {
          throw new Error('grok: 구독 자격 없음 · API 키 opt-in 꺼짐 또는 키 없음');
        }
        if (grok && 'grokAuth' in creds && creds.grokAuth) {
          let parsed: unknown;
          try { parsed = JSON.parse(creds.grokAuth); } catch { throw new Error('grok: Pod 구독 자격 JSON 이 아니다'); }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Object.values(parsed).some((scope) => scope && typeof scope === 'object' && typeof (scope as { key?: unknown }).key === 'string') || /"[^\"]*refresh[^\"]*"\s*:/i.test(creds.grokAuth)) {
            throw new Error('grok: Pod 구독 자격에 access 토큰이 없거나 refresh 필드가 있다');
          }
        }
        // Grok 자격은 전용 Secret 키 하나로만 보낸다 — passEnv 의 API 키 중복 전달은 막는다.
        const passKeys = grok
          ? (options.passEnv ?? []).filter((key) => !['XAI_API_KEY', 'GROK_API_KEY', 'GROK_CODE_XAI_API_KEY'].includes(key))
          : options.passEnv ?? [];
        const skillEnvs: Record<string, string> = options.skillEnv
          ? (options.readSkillEnv ?? (() => readSkillEnvFiles(resolvePodSkills(env).skills)))()
          : {};
        if (options.skillEnv) debug.log('self-implement.pod', 'skill-env', { job: name, skills: Object.keys(skillEnvs) });   // ⛔ 이름만 — 값은 안 싣는다
        // ⭐ 원격 그라운딩(P13): 주소가 설정돼 있으면 이 런 전용·짧은 수명 토큰을 발급해 Secret 으로만 싣는다(값은 로그에 안 싣는다).
        const groundingUrl = (options.groundingUrl ?? env[GROUNDING_URL_ENV] ?? (options.kubectl ? undefined : configGroundingUrl()))?.trim() || undefined;   // kubectl 주입(=시험)이면 사용자 설정을 읽지 않는다
        const groundingRunId = env.ELANOUS_RUN_ID?.trim() || input.spaceId;
        const groundingTtlMs = (options.deadlineSeconds ?? POD_JOB_DEADLINE_SECONDS) * 1000;
        const mint = options.mintGrounding ?? mintGroundingToken;
        const grounding = groundingUrl
          ? await mint({ runId: groundingRunId, job: name, ttlMs: groundingTtlMs })
          : null;
        groundingMinted = grounding ? groundingRunId : null;
        debug.log('self-implement.pod', grounding ? 'grounding-token-issued' : 'grounding-token-skipped', { job: name, ...(grounding ? { runId: groundingRunId, exp: grounding.exp } : { reason: 'no-grounding-url' }) });
        // grok 구독 access(~2시간) < Job 수명. 중계 토큰은 그라운딩과 같은 runId 로만 발급하고, 회수는 아래 finally 의 revokeGroundingRun 한 경로가 닫는다.
        const grokSubscription = grok && 'grokAuth' in creds && Boolean(creds.grokAuth);
        const credentialRelay = grokSubscription && groundingUrl
          ? await mint({ runId: groundingRunId, job: name, ttlMs: groundingTtlMs, scope: 'llm-credential' })
          : null;
        if (credentialRelay) {
          groundingMinted = groundingRunId;
          debug.log('self-implement.pod', 'credential-relay', { job: name, runId: groundingRunId, exp: credentialRelay.exp });
        } else if (grokSubscription && !groundingUrl) {
          debug.log('self-implement.pod', 'credential-relay-skipped', { reason: 'no-host-url' });
        }
        const requestedGoalDoc = env.ELANOUS_POD_GOAL_DOC;
        const goalDoc = requestedGoalDoc ? normalize(requestedGoalDoc) : undefined;
        if (goalDoc && (isAbsolute(goalDoc) || goalDoc === '..' || goalDoc.startsWith(`..${sep}`) || goalDoc === '.')) {
          throw new Error(`ELANOUS_POD_GOAL_DOC must be a repository-relative file: ${requestedGoalDoc}`);
        }
        const repoRoot = goalDoc ? findGitDir(process.cwd())?.root : undefined;
        if (goalDoc && !repoRoot) throw new Error('ELANOUS_POD_GOAL_DOC requires a Git repository');
        const goalFile = goalDoc ? realpathSync(resolve(repoRoot!, goalDoc)) : undefined;
        const relativeGoalFile = goalFile ? relative(realpathSync(repoRoot!), goalFile) : undefined;
        if (relativeGoalFile && (relativeGoalFile === '..' || relativeGoalFile.startsWith(`..${sep}`) || isAbsolute(relativeGoalFile))) throw new Error('ELANOUS_POD_GOAL_DOC outside repository');
        const goalDocument = goalFile ? readFileSync(goalFile, 'utf8') : undefined;
        const secret = {
          apiVersion: 'v1', kind: 'Secret', type: 'Opaque',
          metadata: { name: `${name}-creds`, namespace, labels: { 'elanous.job': name } },
          stringData: {
            ...(grok
              ? ('grokAuth' in creds && creds.grokAuth
                ? { 'grok-auth.json': creds.grokAuth }
                : { 'grok-api-key': (creds as { grokApiKey: string }).grokApiKey })
              : { 'elanous-auth.json': (creds as ReturnType<typeof hostCredentials>).elanousAuth, 'codex-auth.json': (creds as ReturnType<typeof hostCredentials>).codexAuth }),
            'gh-token': creds.ghToken, feature: input.feature,
            ...(goalDocument !== undefined ? { 'goal-doc': goalDocument } : {}),
            ...Object.fromEntries(Object.entries(skillEnvs).map(([n, text]) => [`skillenv-${n}`, text])),
            ...(grounding ? { [`env-${GROUNDING_TOKEN_ENV}`]: grounding.token } : {}),
            ...(credentialRelay ? { [`env-${POD_CREDENTIAL_TOKEN_ENV}`]: credentialRelay.token } : {}),
            ...Object.fromEntries(passKeys.map((k) => [k, env[k] ?? (options.readKeyCache ?? defaultReadKeyCache)(k)] as const).filter(([, v]) => v).map(([k, v]) => [`env-${k}`, v!])),
          },
        };
        const hostKey = (k: string): string | undefined => env[k] ?? (options.readKeyCache ?? defaultReadKeyCache)(k);
        const passEnv = passKeys.filter((k) => hostKey(k));
        const missing = passKeys.filter((k) => !hostKey(k));
        if (missing.length) debug.log('self-implement.pod', 'pass-env-missing', { job: name, missing }, { level: 'warn' });
        // ☸️ 재개(P3 · 2026-09-26): 같은 이름의 Job 이 이미 있으면 «지우지 않고» 붙는다 — 호스트가 끊긴 동안에도 원격은 계속 돌았다.
        //   🩸 종전엔 여기서 delete 부터 해서, 재개가 원격에서 멀쩡히 돌던 Job 을 죽였다. 실패로 끝난 Job 만 지우고 다시 만든다.
        // ☸️ 노드 레지스트리에 이 판이 있으면 그것을 pull 한다(델타 · 대표 2026-09-26) — 라벨 판정은 로컬 이미지 이름으로 한다.
        const jobImage = member?.imageRef ?? image;
        let liveChildRunId = childRunId;
        const existing = kubectl(['-n', namespace, 'get', 'job', name, '-o', 'jsonpath={.metadata.uid} {.status.conditions[*].type}']);
        const [existingUid = '', ...existingConditions] = existing.status === 0 ? existing.stdout.trim().split(/\s+/u) : [];
        const reattach = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(existingUid) &&   // k8s uid 는 UUID — 다른 산출을 «있음»으로 읽지 않는다
          !/Failed|FailureTarget/.test(existingConditions.join(' '));
        if (reattach) {
          const existingJob = kubectl(['-n', namespace, 'get', 'job', name, '-o', 'json']);
          if (existingJob.status === 0) {
            try {
              const job = JSON.parse(existingJob.stdout) as { spec?: { template?: { spec?: { containers?: Array<{ name?: string; env?: Array<{ name: string; value?: string }> }> } } } };
              const inherited = job.spec?.template?.spec?.containers?.find((c) => c.name === 'child')?.env?.find((e) => e.name === 'ELANOUS_RUN_ID')?.value;
              if (inherited && inherited !== parentRunId && inherited === normalizeRunId(inherited)) liveChildRunId = inherited;
            } catch { /* The existing Job's identity must be verified before following it. */ }
          }
          if (liveChildRunId === childRunId) {
            debug.log('self-implement.pod', 'job-reattach-id-unavailable', { job: name });
            return { exitCode: 1, output: '', error: { code: 'pod-child-run-id', message: `Job ${name} child runId를 확인할 수 없다` } };
          }
        }
        if (reattach) debug.log('self-implement.pod', 'job-reattach', { job: name, conditions: existingConditions.join(' ') || 'running', spaceId: input.spaceId });
        if (!reattach) {
        if (/Failed|FailureTarget/.test(existingConditions.join(' ')) && collectFullLogs('failed-job-logs-unavailable').status === 'incomplete') {
          return { exitCode: 1, output: '', error: { code: 'pod-collection-incomplete', message: `Job ${name} recovery incomplete — old Job retained` } };
        }
        const s = kubectl(['apply', '-f', '-'], JSON.stringify(secret));
        if (s.status !== 0) return { exitCode: 1, output: s.stderr, error: { code: 'pod-secret', message: s.stderr.trim() } };
        kubectl(['-n', namespace, 'delete', 'job', name, '--ignore-not-found']);
        const jobPassEnv = [
          ...passEnv,
          ...(grounding ? [GROUNDING_TOKEN_ENV] : []),
          ...(credentialRelay ? [POD_CREDENTIAL_TOKEN_ENV] : []),
        ];
        const jobArmEnv = grounding || credentialRelay
          ? {
              ...(options.armEnv ?? {}),
              ...(grounding ? { [GROUNDING_URL_ENV]: groundingUrl! } : {}),
              ...(credentialRelay ? { [POD_CREDENTIAL_URL_ENV]: `${new URL(groundingUrl!).origin}${POD_CREDENTIAL_GROK_PATH}` } : {}),
            }
          : options.armEnv;
        const job = podJobManifest({ name, namespace, image: jobImage, ...(member?.imageRef ? { imagePullPolicy: 'IfNotPresent' as const } : {}), repoUrl, ...(options.source ? { source: options.source } : {}), args, passEnv: jobPassEnv, deadlineSeconds: options.deadlineSeconds ?? POD_JOB_DEADLINE_SECONDS, ...(goalDoc ? { goalDoc } : {}), runId: childRunId, ...(parentRunId ? { parentRunId } : {}), ...(jobArmEnv ? { armEnv: jobArmEnv } : {}), hostId: resolveHostId(env), skillEnvs: Object.keys(skillEnvs), memoryLimit, imageCommit: options.imageCommit !== undefined ? options.imageCommit : options.kubectl ? null : podImageFreshness({ image }).imageCommit, ...(grok ? { grokCredential: 'grokAuth' in creds && creds.grokAuth ? 'subscription' as const : 'api_key' as const } : {}) });   // kubectl 주입(=시험)이면 docker 를 부르지 않는다
        const a = kubectl(['apply', '-f', '-'], JSON.stringify(job));
        if (a.status !== 0) { cleanupSecret(); return { exitCode: 1, output: a.stderr, error: { code: 'pod-apply', message: a.stderr.trim() } }; }
        if (options.source?.kind === 'bundle') {
          const podName = await waitForRunningPod(kubectl, namespace, name, sleep);
          if (!podName) {
            debug.log('self-implement.pod', 'source-mismatch', { job: name, kind: 'bundle', headCommit: options.source.headCommit });
            cleanupSecret();
            return { exitCode: 1, output: '', error: { code: 'pod-source', message: `Pod for ${name} did not become Running` } };
          }
          const copied = kubectl(['cp', options.source.bundlePath, `${podName}:/tmp/source.bundle`, '-c', 'child', '-n', namespace]);
          if (copied.status !== 0) {
            debug.log('self-implement.pod', 'source-mismatch', { job: name, kind: 'bundle', headCommit: options.source.headCommit });
            cleanupSecret();
            return { exitCode: 1, output: copied.stderr, error: { code: 'pod-source', message: copied.stderr.trim() || 'kubectl cp failed' } };
          }
          const ready = kubectl(['-n', namespace, 'exec', podName, '-c', 'child', '--', 'touch', '/tmp/source.ready']);
          if (ready.status !== 0) {
            debug.log('self-implement.pod', 'source-mismatch', { job: name, kind: 'bundle', headCommit: options.source.headCommit });
            cleanupSecret();
            return { exitCode: 1, output: ready.stderr, error: { code: 'pod-source', message: ready.stderr.trim() || 'kubectl exec touch failed' } };
          }
          debug.log('self-implement.pod', 'source-delivered', { job: name, kind: 'bundle', headCommit: options.source.headCommit });
        }
        // ☸️ P2: 비밀의 소유자 = Job — 호스트가 죽어도 Job 의 TTL 삭제와 함께 k8s 가 비밀을 거둔다(자격 사본이 클러스터에 남지 않는다).
        const uid = kubectl(['-n', namespace, 'get', 'job', name, '-o', 'jsonpath={.metadata.uid}']).stdout.trim();
        if (uid) {
          const owned = kubectl(['-n', namespace, 'patch', 'secret', `${name}-creds`, '--type=merge', '-p', JSON.stringify({ metadata: { ownerReferences: [{ apiVersion: 'batch/v1', kind: 'Job', name, uid }] } })]);
          if (owned.status !== 0) debug.log('self-implement.pod', 'secret-owner-failed', { job: name, stderr: owned.stderr.trim() }, { level: 'warn' });
        }
        }
        if (parentRunId) {
          try { appendRunLedgerEntry({ runId: parentRunId, event: 'pod-child-run', data: { childRunId: liveChildRunId, job: name, ...(goalFile ? { goalFile } : {}) } }, ledgerDir); }
          catch (error) { debug.log('self-implement.pod', 'parent-ledger-unavailable', { job: name, reason: error instanceof Error ? error.message : String(error) }); }
        }
        writePodFragment({ spaceId: input.spaceId, context, namespace, job: name, inboxDir: POD_CONTROL_INBOX_DIR }, env);
        recorded = true;
        debug.log('self-implement.pod', 'job-applied', { job: name, namespace, ...(member ? { context: member.context } : {}), image: jobImage, spaceId: input.spaceId, passEnv, extraArgs: options.extraArgs ?? [], ...(options.armEnv?.ELANOUS_ARM_ID ? { armId: options.armEnv.ELANOUS_ARM_ID } : {}) });
        let state: 'complete' | 'failed' | 'aborted' = 'failed';
        let failedReason = '';
        let containerReason: string | null = null;
        let containerExitCode: number | null = null;
        // ⭐ 런 «도중» 원장 증분 회수 — 호스트 슈퍼바이저가 Pod 걸음을 실시간으로 본다(🅣 요청 · 힐 루프 runtime 성형의 전제).
        const follower = createPodLedgerFollower({ runId: liveChildRunId, dir: ledgerDir, exec: (script) => kubectl(['-n', namespace, 'exec', `job/${name}`, '-c', 'child', '--', 'sh', '-c', script]) });
        for (;;) {
          if (input.signal?.aborted) {
            kubectl(['-n', namespace, 'delete', 'job', name, '--ignore-not-found', '--wait=false']);
            state = 'aborted';
            break;
          }
          const g = kubectl(['-n', namespace, 'get', 'job', name, '-o', 'jsonpath={.status.conditions[*].type}']);
          const types = g.stdout;
          if (/Complete|SuccessCriteriaMet/.test(types)) { state = 'complete'; break; }
          if (/Failed|FailureTarget/.test(types)) {
            state = 'failed';
            const reason = kubectl(['-n', namespace, 'get', 'job', name, '-o', 'jsonpath={.status.conditions[?(@.type=="Failed")].reason}']);
            failedReason = reason.status === 0 ? reason.stdout.trim() : '';
            try {
              const pods = kubectl(['-n', namespace, 'get', 'pods', '-l', `job-name=${name}`, '-o', 'jsonpath={range .items[*]}{.metadata.creationTimestamp}{"\\t"}{range .status.containerStatuses[?(@.name=="child")]}{.state.terminated.reason}{"\\t"}{.state.terminated.exitCode}{end}{"\\n"}{end}']);
              if (pods.status === 0 && pods.stdout) {
                const rows = pods.stdout.trimEnd().split('\n').map((line) => line.split('\t'));
                const latest = rows.filter(([created]) => created && !Number.isNaN(Date.parse(created)))
                  .sort((a, b) => Date.parse(b[0]!) - Date.parse(a[0]!))[0];
                if (latest) {
                  const [, reasonText, exitText] = latest;
                  containerReason = reasonText?.trim() || null;
                  containerExitCode = exitText?.trim() && /^\d+$/.test(exitText.trim()) ? Number(exitText.trim()) : null;
                }
              }
            } catch { /* Pod 가 사라졌거나 조회 불가 — 종료 사유는 미상. */ }
            debug.log('self-implement.pod', 'container-terminated', { job: name, container: 'child', reason: containerReason, exitCode: containerExitCode, jobReason: failedReason || null, memoryLimit });
            break;
          }
          try { follower?.poll(); } catch (e) { debug.log('self-implement.pod', 'ledger-live-unavailable', { job: name, reason: e instanceof Error ? e.message : String(e) }); }
          await sleep(options.pollMs ?? 15_000);
        }
        const logs = kubectl(['-n', namespace, 'logs', `job/${name}`, '-c', 'child', '--tail=400']).stdout;
        let ledgerReason = '';
        let ledgerCollected = false;
        const collection = collectFullLogs('ledger-collect-incomplete', follower.owned ? new Set([liveChildRunId]) : undefined, (event, data) => {
          if ((event === 'ledger-collect-incomplete' || event === 'ledger-collect-skipped') && (data.runId === liveChildRunId || !data.runId)) ledgerReason = String(data.reason);
          if ((event === 'ledger-collected' || event === 'ledger-collect-already-complete') && data.runId === liveChildRunId) ledgerCollected = true;
        }, liveChildRunId);
        const ledgerExists = existsSync(runLedgerPath(liveChildRunId, ledgerDir));
        const ledgerCompleteness = collection.childLedgerIncomplete || (follower.owned && !ledgerCollected) ? 'incomplete' : ledgerCollected ? 'complete' : 'missing';
        if (ledgerCompleteness === 'incomplete' || (state !== 'complete' && !ledgerExists)) {
          try { appendRunLedgerEntry({ runId: liveChildRunId, event: 'pod-ledger-incomplete', data: { job: name, reason: ledgerReason || (collection.status === 'unavailable' ? 'logs-unavailable' : ledgerExists ? 'collection-incomplete' : 'child-ledger-missing') } }, ledgerDir); }
          catch (error) { debug.log('self-implement.pod', 'ledger-marker-unavailable', { job: name, childRunId: liveChildRunId, reason: error instanceof Error ? error.message : String(error) }); }
        }
        const salvage = recordPodSalvage(logs, name);
        cleanupSecret();
        // ⭐ 호스트 단가로 다시 매긴다(BACKLOG C1b) — Pod 엔 레지스트리 스냅숏이 없다.
        const { estimateLlmCost } = await import('../../budget/llm-cost.js');
        reemitPodUsage(logs, name, undefined, (u) => estimateLlmCost(u) as { kind: string; usd?: number });
        const parsed = parseSelfImplementJson(logs);
        // Pod 안 경로는 호스트에서 쓸 수 없다.
        const disposition = parsed ? { ...parsed, worktreePath: undefined } : undefined;
        if (goalFile) {
          const record: GoalExecutionRecord = {
            runId: liveChildRunId,
            stage: (state === 'aborted' || !disposition ? 'aborted' : disposition.stage) as GoalExecutionRecord['stage'],
            outcome: (!disposition ? 'pod-no-result' : state === 'complete' && disposition.merged ? 'merged' : state === 'complete' && disposition.ok ? 'completed' : 'abandoned') as GoalExecutionRecord['outcome'],
            ok: state === 'complete' && (disposition?.ok ?? false),
            ...(disposition?.prNumber !== undefined ? { prNumber: disposition.prNumber } : {}),
            completedAt: new Date().toISOString(),
          };
          try { const { appendGoalExecutionRecord } = await import('../../self-implement/orchestrator.js'); appendGoalExecutionRecord(goalFile, record); }
          catch (error) { debug.log('self-implement.pod', 'goal-record-unavailable', { job: name, childRunId: liveChildRunId, reason: error instanceof Error ? error.message : String(error) }); }
        }
        debug.log('self-implement.pod', 'job-finished', { job: name, ...(member ? { context: member.context } : {}), state, containerReason, stage: disposition?.stage ?? null, prUrl: disposition?.prUrl ?? null, childRunId: liveChildRunId, ledgerCompleteness });
        const tail = podRunResultLine(logs.slice(-4000), salvage);
        if (state === 'aborted') return { exitCode: null, output: tail, error: { code: 'aborted', message: 'aborted — Job deleted' }, ...(disposition ? { disposition } : {}) };
        const deadlineExceeded = state === 'failed' && failedReason === 'DeadlineExceeded';
        const deadlineSeconds = options.deadlineSeconds ?? POD_JOB_DEADLINE_SECONDS;
        if (deadlineExceeded) {
          debug.log('self-implement.pod', 'deadline-exceeded', {
            job: name,
            deadlineSeconds,
            childClassification: disposition?.failureClassification ?? null,
            prUrl: disposition?.prUrl ?? null,
            branch: disposition?.branch ?? null,
          });
        }
        const finishedDisposition = deadlineExceeded && disposition
          ? { ...disposition, failureClassification: 'run-deadline-exceeded' as const }
          : disposition;
        return {
          exitCode: state === 'complete' ? 0 : 1,
          output: tail,
          ...(deadlineExceeded
            ? { error: { code: 'pod-deadline-exceeded', message: `Job ${name} 이 수명 상한 ${deadlineSeconds}초에 닿았다` } }
            : state === 'failed'
              ? containerReason === 'OOMKilled'
                ? { error: { code: 'pod-oom-killed', message: `Job ${name} failed (OOMKilled/${containerExitCode ?? 'unknown'}, memoryLimit=${memoryLimit})` } }
                : { error: { code: 'pod-job-failed', message: `Job ${name} failed${failedReason || containerReason ? ` (${[failedReason, containerReason ? `container=${containerReason}/${containerExitCode ?? 'unknown'}` : ''].filter(Boolean).join(', ')})` : ''}` } }
              : {}),
          ...(finishedDisposition ? { disposition: finishedDisposition } : {}),
        };
      } catch (err) {
        cleanupSecret();
        const message = err instanceof Error ? err.message : String(err);
        debug.log('self-implement.pod', 'job-error', { job: name, message }, { level: 'error' });
        return { exitCode: 1, output: message, error: { code: 'pod-error', message } };
      }
      } finally {
        if (recorded) finishPodFragment(input.spaceId, env);
        if (groundingMinted) { try { (options.revokeGrounding ?? revokeGroundingRun)(groundingMinted); } catch (e) { debug.log('self-implement.pod', 'grounding-revoke-failed', { job: name, reason: e instanceof Error ? e.message : String(e) }, { level: 'warn' }); } }
        if (member) options.pool!.release(member);
      }
    })();
    return { address, done };
  };
}

/** Pod 가 낸 `ELANOUS_USAGE_ROLLUP` 한 줄 → 호스트 logs.db 에 `llm-usage`(site=`pod-rollup:<site>`)로 재방출(RFC F2).
 *  Pod 의 logs.db 는 Pod 와 함께 사라지므로 이것이 그 칸의 토큰·비용이 남는 유일한 자리다. */
/** Pod 롤업 한 행의 비용 칸 (BACKLOG C5 · C1b).
 *  ⛔ «모름»을 0 으로 보이지 않는다 — 전부 모르면 `kind:'unknown', usd:null`.
 *  ⭐ Pod 엔 단가 스냅숏이 없어 «모름»이 나기 쉽다. 호스트는 레지스트리(OpenRouter `/models` 폴드)를 알므로
 *    «토큰 합계»로 다시 매긴다(단가는 선형이라 합계로 매겨도 같다) → `source:'host-reprice'`. */
export type PodRowReprice = (u: { model: string; inputTokens: number; outputTokens: number; cacheReadInputTokens: number }) => { kind: string; usd?: number } | null;
export function podRowCost(r: Record<string, unknown>, reprice?: PodRowReprice): Record<string, unknown> {
  const calls = Number(r.calls ?? 0);
  const unknown = Number(r.unknownCostCalls ?? 0);
  const usdKnown = typeof r.usdKnown === 'number' ? r.usdKnown : 0;
  const included = Number(r.includedCalls ?? 0);
  // ⭐ 전부 구독·local(C6) — 청구 0 · API 환산가는 따로.
  if (calls > 0 && included >= calls) return { kind: 'included', usd: 0, includedCalls: included, ...(typeof r.apiEquivalentUsd === 'number' ? { apiEquivalentUsd: r.apiEquivalentUsd } : {}) };
  if (unknown === 0) return { kind: 'known', usd: usdKnown, unknownCostCalls: 0, ...(included ? { includedCalls: included } : {}) };
  const host = reprice?.({ model: String(r.model ?? ''), inputTokens: Number(r.inputTokens ?? 0), outputTokens: Number(r.outputTokens ?? 0), cacheReadInputTokens: Number(r.cacheReadInputTokens ?? 0) });
  if (host && host.kind === 'known' && typeof host.usd === 'number') return { kind: 'known', usd: host.usd, source: 'host-reprice', podUnknownCostCalls: unknown };
  if (calls > 0 && unknown >= calls) return { kind: 'unknown', usd: null, unknownCostCalls: unknown };
  return { kind: 'partial', usd: usdKnown, unknownCostCalls: unknown };
}

const SALVAGE_LINE = /^ELANOUS_POD_SALVAGE (\S+) (\S+)$/;

/** Job 로그의 `ELANOUS_POD_SALVAGE <branch> <commit>` — 호스트가 거둘 브랜치. 접두가 salvage/ 가 아니면 버린다. */
export function parsePodSalvageLines(logs: string): Array<{ branch: string; commit: string }> {
  const out: Array<{ branch: string; commit: string }> = [];
  for (const line of logs.split('\n')) {
    const m = SALVAGE_LINE.exec(line.trim());
    if (!m || !m[1]!.startsWith('salvage/')) continue;
    out.push({ branch: m[1]!, commit: m[2]! });
  }
  return out;
}

/** 기존 Job 로그 소비 경로가 부르는 salvage 기록. 사람용 런 결과 줄에 붙일 브랜치 목록을 돌려준다. */
export function recordPodSalvage(logs: string, job: string, log: (category: string, event: string, data: Record<string, unknown>) => void = (c, e, d) => debug.log(c, e, d)): string[] {
  const rows = parsePodSalvageLines(logs);
  for (const row of rows) log('self-implement.pod', 'salvage-pushed', { job, branch: row.branch, commit: row.commit });
  return rows.map((row) => row.branch);
}

/** 사람용 런 결과 한 줄 — 수확 브랜치가 있으면 «수확할 브랜치: …» 를 붙인다. */
export function podRunResultLine(tail: string, branches: readonly string[]): string {
  if (!branches.length) return tail;
  const note = branches.map((branch) => `수확할 브랜치: ${branch}`).join('\n');
  return tail ? `${tail}\n${note}` : note;
}

export function reemitPodUsage(logs: string, job: string, log: (category: string, event: string, data: Record<string, unknown>) => void = (c, e, d) => debug.log(c, e, d), reprice?: PodRowReprice): number {
  const line = logs.split('\n').reverse().find((l) => l.startsWith('ELANOUS_USAGE_ROLLUP '));
  if (!line) { log('self-implement.pod', 'usage-rollup-missing', { job }); return 0; }
  let parsed: { measured?: boolean; truncated?: boolean; runId?: string | null; armId?: string | null; podName?: string | null; nodeName?: string | null; hostId?: string | null; rows?: Array<Record<string, unknown>> };
  try { parsed = JSON.parse(line.slice('ELANOUS_USAGE_ROLLUP '.length)); } catch { log('self-implement.pod', 'usage-rollup-unparsable', { job }); return 0; }
  const rows = parsed.rows ?? [];
  for (const r of rows) {
    const cost = podRowCost(r, reprice);
    log('llm.usage', 'llm-usage', {
      site: `pod-rollup:${String(r.site)}`, provider: r.provider, model: r.model, calls: r.calls,
      inputTokens: r.inputTokens, outputTokens: r.outputTokens, cacheReadInputTokens: r.cacheReadInputTokens,
      cost,
      substrate: 'pod', job, ...(parsed.runId ? { podRunId: parsed.runId } : {}), ...(parsed.armId ? { armId: parsed.armId } : {}),
      ...(parsed.podName ? { podName: parsed.podName } : {}), ...(parsed.nodeName ? { nodeName: parsed.nodeName } : {}), ...(parsed.hostId ? { podHostId: parsed.hostId } : {}),
    });
  }
  log('self-implement.pod', 'usage-rollup', { job, rows: rows.length, measured: parsed.measured ?? null, truncated: parsed.truncated ?? null });
  return rows.length;
}

/** 이 기계가 Pod 칸을 쓸 수 있나(클러스터 · 이미지) — 발사 전 한 번. */
export function podSubstrateReady(kubectl: Kubectl = defaultKubectl, image = 'elanous-harness:local'): { ok: boolean; reason: string } {
  const ctx = kubectl(['config', 'current-context']);
  if (ctx.status !== 0) return { ok: false, reason: 'kubectl context 없음 — k3d cluster create elanous-h1 --no-lb' };
  const ns = kubectl(['get', 'ns', 'elanous-test']);
  if (ns.status !== 0) return { ok: false, reason: 'elanous-test 네임스페이스 없음 — kubectl apply -f docker/h1/base.yaml -f docker/h1/policy-internet.yaml' };
  void image;
  return { ok: true, reason: `context ${ctx.stdout.trim()}` };
}


// ── 벤치 팔 (RFC fleet 슈퍼바이저 §A3·F4) ─────────────────────────────────────────────
export interface BenchArm {
  id: string; provider: string; model?: string; passEnv: string[];
  /** 모델을 누가 정했나 — `explicit`(스펙에 적었다) · `ladder`(그 provider 사다리 `better` 칸에서 채웠다). */
  modelSource?: 'explicit' | 'ladder';
}

/** ⛔ 벤치 팔의 모델은 «비워 두지 않는다» — 비우면 provider 마다 옛 상수로 떨어진다.
 *  🩸 09-25 실측: codex 팔이 `gpt-4o-mini`(400 · #20425) · claude 팔이 `claude-haiku-4-5` 로 돌았다.
 *  ⇒ 사다리가 있는 provider 는 `better` 칸으로 채우고 그 사실을 `modelSource` 로 남긴다. */
function ladderModelFor(provider: string): string | undefined {
  if (!(provider in LLM_TIER_MAP_BY_PROVIDER)) return undefined;
  return lookupLlmTierSpec(provider as LlmTierProvider, 'better').model;
}

/** `id=provider[:model][@KEY+KEY]` 를 `;` 로 잇는다 — 예 `codex=openai-codex; or-kimi=openrouter:openrouter/moonshotai/kimi-k3@OPENROUTER_API_KEY`. */
export function parseBenchArms(spec: string): BenchArm[] {
  const arms = spec.split(';').map((x) => x.trim()).filter(Boolean).map((part) => {
    const m = /^([a-z0-9][a-z0-9-]*)=([a-z0-9-]+)(?::([^@]+))?(?:@([A-Z0-9_+]+))?$/i.exec(part);
    if (!m) throw new Error(`--bench-arms: 못 읽는 팔 「${part}」 — 형식 id=provider[:model][@KEY+KEY]`);
    const provider = m[2]!;
    const explicit = m[3]?.trim();
    const model = explicit || ladderModelFor(provider);
    return {
      id: m[1]!.toLowerCase(), provider,
      ...(model ? { model, modelSource: explicit ? 'explicit' as const : 'ladder' as const } : {}),
      passEnv: m[4] ? m[4].split('+') : [],
    };
  });
  const ids = new Set(arms.map((a) => a.id));
  if (ids.size !== arms.length) throw new Error('--bench-arms: 팔 id 가 겹친다');
  if (arms.length < 2) throw new Error('--bench-arms: 팔은 둘 이상');
  return arms;
}

export const BENCH_ARM_LABEL = /\[bench-arm: ([a-z0-9-]+)\]/;

/** 골 하나 → 팔마다 «라벨 한 줄만» 다른 골(A/B 매뉴얼 규칙 ②). */
export function benchGoals(goal: string, arms: readonly BenchArm[]): string[] {
  return arms.map((a) => `${goal.trim()}\n[bench-arm: ${a.id}]`);
}

/** 라벨로 팔을 찾아 그 팔의 provider·model·과금 키로 Pod 를 띄운다. */
export function benchPodSpawn(arms: readonly BenchArm[], base: PodSpawnOptions = {}): SelfImplementJobSpawn {
  const byId = new Map(arms.map((a) => [a.id, a]));
  return (input) => {
    const id = BENCH_ARM_LABEL.exec(input.feature)?.[1];
    const arm = id ? byId.get(id) : undefined;
    if (!arm) return { address: `self-impl:${input.spaceId}`, done: Promise.resolve({ exitCode: 1, output: 'no bench arm label', error: { code: 'bench-arm-missing', message: `골에 [bench-arm: <id>] 라벨이 없다(팔: ${[...byId.keys()].join(', ')})` } }) };
    return podSelfImplementSpawn({ ...base, armEnv: benchArmEnv(arm), passEnv: [...(base.passEnv ?? []), ...arm.passEnv] })(input);
  };
}

/** 팔 하나의 Pod env. ⛔⭐ 재작업 «승급»도 팔 안에 가둔다.
 *  🩸 09-25 실측: anthropic 팔의 호출 40건 중 22건(입력 123만 토큰)이 codex `gpt-6-sol` 이었다 —
 *    gate/감독 재작업 라운드가 명시 자식 LLM 이 없으면 `resolveEscalateTarget`(codex sol · anthropic opus)으로
 *    승급하고, 그 env 가 `ELANOUS_LLM_PROVIDER` 를 이긴다(`user-config.ts` escalate → runtime → config).
 *  ⇒ 두 승급 칸(`sol`·`opus`)의 provider·model 을 팔의 값으로 덮는다. 팔 = «한 모델»이 벤치의 불변식이다. */
export function benchArmEnv(arm: BenchArm): Record<string, string> {
  const env: Record<string, string> = { ELANOUS_ARM_ID: `pod/${arm.id}`, ELANOUS_LLM_PROVIDER: arm.provider };
  if (arm.model) env.ELANOUS_LLM_MODEL = arm.model;
  // 🖥️ local 팔 — 호스트의 OpenAI 호환 서버(LM Studio 기본 1234). Pod 에서 호스트는 `host.orb.internal`(OrbStack).
  //   ⛔ 사설망 차단 정책이 기본이라 라벨(`elanous.egress/local-llm`) ⊕ policy-local-llm.yaml 이 그 포트 하나만 연다.
  if (arm.provider === 'local') env.LOCAL_LLM_URL = process.env.ELANOUS_BENCH_LOCAL_LLM_URL?.trim() || 'http://host.orb.internal:1234/v1';
  for (const tier of ['SOL', 'OPUS']) {
    env[`ELANOUS_SELFDEV_${tier}_PROVIDER`] = arm.provider;
    if (arm.model) env[`ELANOUS_SELFDEV_${tier}_MODEL`] = arm.model;
  }
  return env;
}

// ── 이미지 판 (BACKLOG E6) ────────────────────────────────────────────────────────────
/** Pod 안의 `elanous` 는 이미지에 구운 설치본이다 — clone 한 main 이 아니다.
 *  🩸 09-25: 11:08 이미지가 그 뒤 착지한 수리 넷(#20425·#20428·#20429·#20433)을 몰라, anthropic 팔이
 *    main 에서 고쳐진 400 으로 세 판 연속 죽었다. 벤치가 «main» 이 아니라 «이미지 판»을 쟀다.
 *  ⇒ 라벨 `elanous.commit`(docker/harness/build.sh)과 이 트리 HEAD 를 대조한다. */
export interface PodImageFreshness { imageCommit: string | null; headCommit: string | null; fresh: boolean; reason: string }

export function podImageFreshness(deps: {
  run?: (cmd: string, args: readonly string[]) => { status: number | null; stdout: string };
  image?: string;
  cwd?: string;
  /** 지금 설정의 Pod 스킬 세트 해시(pod-skills.ts). 생략 시 — run 을 주입한 시험이면 대조하지 않고, 아니면 실제로 잰다. */
  skillsDigest?: () => string;
} = {}): PodImageFreshness {
  const run = deps.run ?? ((cmd, args) => { const r = spawnSync(cmd, [...args], { encoding: 'utf8', timeout: 20_000, ...(deps.cwd ? { cwd: deps.cwd } : {}) }); return { status: r.status, stdout: r.stdout ?? '' }; });
  const image = deps.image ?? 'elanous-harness:local';
  const head = run('git', ['rev-parse', 'HEAD']);
  const headCommit = head.status === 0 ? head.stdout.trim() || null : null;
  const img = run('docker', ['image', 'inspect', image, '--format', '{{index .Config.Labels "elanous.commit"}}']);
  const label = img.status === 0 ? img.stdout.trim() : '';
  const imageCommit = label && label !== '<no value>' ? label : null;
  if (!headCommit) return { imageCommit, headCommit, fresh: false, reason: 'HEAD 를 못 읽었다 — 판정 불가(낡음으로 본다)' };
  if (img.status !== 0) return { imageCommit, headCommit, fresh: false, reason: `이미지 ${image} 없음` };
  if (!imageCommit) return { imageCommit, headCommit, fresh: false, reason: '이미지에 elanous.commit 라벨이 없다(build.sh 전 판)' };
  // ☸️ 스킬 세트가 바뀌었으면(설정 목록·스킬 내용) 코드가 같아도 낡았다.
  const digestOf = deps.skillsDigest ?? (deps.run ? undefined : () => podSkillsDigest(resolvePodSkills().skills).digest);
  if (digestOf && imageCommit === headCommit) {
    const want = digestOf();
    const lab = run('docker', ['image', 'inspect', image, '--format', '{{index .Config.Labels "elanous.pod-skills"}}']);
    const have = lab.status === 0 ? lab.stdout.trim() : '';
    if (have !== want) return { imageCommit, headCommit, fresh: false, reason: `Pod 스킬 세트가 바뀌었다(이미지 ${have && have !== '<no value>' ? have : '없음'} ≠ 지금 ${want})` };
  }
  return imageCommit === headCommit
    ? { imageCommit, headCommit, fresh: true, reason: 'HEAD 와 같다' }
    : { imageCommit, headCommit, fresh: false, reason: `이미지 ${imageCommit.slice(0, 12)} ≠ HEAD ${headCommit.slice(0, 12)}` };
}

function configGroundingUrl(): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getUserConfig } = require('../../user-config.js') as typeof import('../../user-config.js');
    return getUserConfig().pod?.groundingUrl;
  } catch { return undefined; }
}
