import type { Command } from 'commander';
import { dirname as _dirname, join as _joinPath } from 'node:path';
import * as ui from '../ui.js';
import { debug } from '../debug/log.js';
import { shellQuoteRemote } from '../ssh/ssh-fs.js';
import { writeStdoutJson } from './stdout-json.js';
import {
  getUserConfig, reloadUserConfig, userConfigPath, saveUserConfig,
  backupUserConfig, restoreUserConfig, backupConfigPath,
  rotateNextProvider, jumpToRotationEntry, addRotationEntry,
  removeRotationEntry, rotationEntryLabel, currentRotationIndex,
  type RotationEntry,
  PROVIDER_DEFAULT_MODEL as USER_CONFIG_PROVIDER_DEFAULT_MODEL,
} from '../user-config.js';
import { renderProviderStatus } from '../provider-summary.js';
import { getCatalog } from '../registry/loader.js';
import { defaultModelFor } from '../registry/resolver.js';

/**
 * Import succeeds through the account store, but its two immediate follow-up
 * commands use different entrances: usage resolves the stored home from
 * --account, while one-run execution resolves the per-run account env.
 */
export function buildCodexAccountImportGuidance(name: string, home: string): readonly [quota: string, execution: string] {
  // POSIX quoting stays centralized in shellQuoteRemote; do not recreate it here.
  return [
    `쿼터를 재려면: bun bin/elanous.mjs provider codex usage --account ${shellQuoteRemote(name)}`,
    `이 계정으로 «한 런만» 쓰려면: ELANOUS_CODEX_ACCOUNT=${shellQuoteRemote(name)} ELANOUS_CODEX_ACCOUNT_HOME=${shellQuoteRemote(home)} bun bin/elanous.mjs <명령>`,
  ];
}

const CODEX_ACCOUNT_CLI_SINK_SURFACE = 'codex-account-cli';
type CodexAccountLogSinkModule = Pick<typeof import('../domains/standalone-log-sink.js'), 'registerStandaloneLogSink'>;
let codexAccountLogSinkModuleForTesting: CodexAccountLogSinkModule | undefined;

export function setCodexAccountLogSinkModuleForTesting(module: CodexAccountLogSinkModule | undefined): void {
  codexAccountLogSinkModuleForTesting = module;
}

/** Per-provider sensible-default model when --model is omitted. These
 *  are what a user running "elanous provider set <name>" expects to get
 *  without thinking — the flagship or recommended-for-agent model.
 *
 *  ⛔⭐⭐ 2026-09-23 — ***fallback 을 여기 «적지 않는다».*** `user-config.ts` 의
 *  `PROVIDER_DEFAULT_MODEL` 에서 «파생»한다.
 *  🩸 왜 — 이 표는 그 표의 ***사본***이었고 ***5주간 갈라져 있었다***. 2026-08-18 에 그쪽에서
 *  「기본값이 실물을 안 가리킨다」며 고친 셋이 ***여기엔 그대로 남아 있었다***:
 *    grok `grok-4-1-fast` — xAI 실호출 대조 결과 «200 OK 인데 실제로는 grok-4.3 이 돈다»
 *    gemini `gemini-2.0-flash` — 카탈로그의 «가장 낡은» 항목
 *    local `llama-3` — LM Studio 실물 목록에 «없다»
 *  ⛔ 그리고 이것은 `elanous provider:set <name>` 이라 ***사람이 직접 치는 명령***이다.
 *  ⇒ 사본을 지우고 «환경변수 이름»만 여기 남긴다(그건 이 축의 고유 정보다). */
const PROVIDER_MODEL_ENV: Record<string, string> = {
  anthropic:      'ANTHROPIC_MODEL',
  openai:         'OPENAI_MODEL',
  'openai-codex': 'OPENAI_MODEL',
  grok:           'GROK_MODEL',
  gemini:         'GEMINI_MODEL',
  local:          'LOCAL_LLM_MODEL',
};
const PROVIDER_DEFAULT_MODEL: Record<string, { env: string; fallback: string }> =
  Object.fromEntries(Object.entries(PROVIDER_MODEL_ENV).map(([provider, env]) => [
    provider,
    { env, fallback: USER_CONFIG_PROVIDER_DEFAULT_MODEL[provider as never] ?? '' },
  ]));

/** Env var holding the API key for each provider. When `elanous provider
 *  set` runs without --api-key, we pull from this env as a convenience
 *  (anthropic/openai users typically have ANTHROPIC_API_KEY /
 *  OPENAI_API_KEY exported already). */
const PROVIDER_KEY_ENV: Record<string, string> = {
  anthropic:      'ANTHROPIC_API_KEY',
  openai:         'OPENAI_API_KEY',
  'openai-codex': 'OPENAI_API_KEY',
  grok:           'XAI_API_KEY',
  gemini:         'GEMINI_API_KEY',
};

// ── provider:rotate — multi-provider cycling ──
//
// The user maintains an ordered list of (provider, model, label)
// entries in `llm.rotation`. `rotate` advances one step, `rotate
// reset` jumps back to the first, `rotate list` prints the list
// with the current entry highlighted, and `rotate add/remove`
// edit membership. A separate `use` verb jumps to a specific
// entry by label / provider name / model substring. Works for
// any N providers — 2, 3, 5, 10 — no hardcoded size.

// RFC #2161 Phase 8 FU A5 (2026-05-11) — `provider:rotate add <name>`
// now resolves both the supported-provider list AND the default model
// straight from the registry catalog. New providers / models in
// catalog/providers/*.yaml + catalog/models/<provider>/*.yaml
// automatically thread through here without touching this file.

/** RFC #2161 Phase 8 FU A5 (2026-05-11) — supported provider names
 *  for `provider:rotate add` validation. Pulled from the registry
 *  catalog plus the legacy `'openai-codex'` adapter alias (the
 *  catalog stores it as an alias of `'openai'`; see
 *  `catalog/providers/openai.yaml`). Kept as a `Set<string>` for
 *  `O(1)` membership checks. */
export function supportedProviderNames(): Set<string> {
  const catalogIds = [...getCatalog().providers.keys()];
  return new Set([...catalogIds, 'openai-codex']);
}

/** Default model id for a provider name, sourced from the registry
 *  catalog. Returns `undefined` when the provider has no registered
 *  models (e.g. `local`) or when the name is unknown. The CLI falls
 *  back to a `<NAME>_MODEL` env var or omits the model field entirely
 *  in that case (the rotation entry stays useful — `provider` alone
 *  is enough; the LLM call later uses the provider's own default). */
export function defaultModelIdFor(providerName: string): string | undefined {
  // 'openai-codex' shares OpenAI's catalog defaults (the codex adapter
  // is just a different wire path; same model family).
  const lookupName = providerName === 'openai-codex' ? 'openai' : providerName;
  return defaultModelFor(lookupName)?.id;
}

/** API-key env var name for a provider, sourced from the registry
 *  catalog's `apiKeyEnv` field. `local` doesn't surface an env name
 *  here (LOCAL_LLM_API_KEY is rarely set; users wire local hosts via
 *  ELANOUS_LLM_HOSTS instead). */
export function apiKeyEnvFor(providerName: string): string | undefined {
  const lookupName = providerName === 'openai-codex' ? 'openai' : providerName;
  const provider = getCatalog().providers.get(lookupName);
  if (!provider) return undefined;
  if (provider.id === 'local') return undefined;
  return provider.apiKeyEnv || undefined;
}

/** Format a rotation-list table for the CLI. Marks the current
 *  entry with a ▸ arrow so users can see which one is active. */
export function formatRotationList(cfg: ReturnType<typeof getUserConfig>, highlightIdx: number): string {
  const rot = cfg.llm.rotation;
  if (!rot || rot.length === 0) return '  (rotation list is empty — `elanous provider:rotate add <name>` to start)';
  const lines: string[] = [];
  const labelW = Math.max(...rot.map(e => rotationEntryLabel(e).length));
  const provW = Math.max(...rot.map(e => e.provider.length));
  for (let i = 0; i < rot.length; i++) {
    const e = rot[i]!;
    const marker = i === highlightIdx ? '▸' : ' ';
    const label = rotationEntryLabel(e).padEnd(labelW);
    const prov  = e.provider.padEnd(provW);
    const model = e.model ?? '(provider default)';
    lines.push(`  ${marker} ${label}  ${prov}  ${model}`);
  }
  return lines.join('\n');
}

/** Persist rotation mutation + reload in-memory cache. Shared tail
 *  of the add/remove/rotate CLI paths — keeps them one-liners. */
function saveAndReload(path: string, cfg: ReturnType<typeof getUserConfig>): void {
  saveUserConfig(cfg, path);
  reloadUserConfig();
}

export function registerProviderCommands(program: Command): void {
  // ── provider (active LLM status + one-shot switcher) ──
  const providerCmd = program
    .command('provider')
    .alias('providers')
    .description('Show the currently active LLM provider + model + auth status')
    .action(() => {
      ui.header('Active LLM provider');
      console.log(renderProviderStatus());
    });

  // ── provider codex (계정·쿼터·리셋 크레딧 · READ 는 안전 · redeem 은 «소비»한다) ──
  //   canonical = 내부 문서 `MANUAL-llm-provider-operations-2026-08-05` · 규칙 = .rules/70-llm-provider/
  //   ⛔⭐ 이름이 최상위 `codex` 가 «아니다» — 그 이름은 이미 `agent-mission` 의 «별칭»이고,
  //     최상위 `provider` 도 이미 있다(둘 다 commander 가 «실행 시점»에 거부해서 알았다).
  //     ⇒ 그래서 기존 `provider` 명령의 «하위»로 붙인다. `elanous provider` 는 종전대로 상태를 보여준다.
  const codexCmd = providerCmd.command('codex').description('Codex — 사용량·리밋·리셋 크레딧 조회와 사용');

  codexCmd
    .command('usage')
    .description('현재 Codex 쿼터·리밋을 provider 응답 그대로 읽어 보여준다 (READ-ONLY)')
    .option('--json', 'JSON 으로 출력')
    .option('--account <name>', '그 계정의 홈으로 잰다 (정본이 아는 계정 이름 · 생략하면 지금 환경의 홈)')
    .action(async (opts: { json?: boolean; account?: string }) => {
      const { createCodexFetcher } = await import('../budget/fetchers/codex.js');
      // ⛔⭐ 계정을 이름으로 주면 «그 계정의 홈»을 정본 기록에서 찾아 잰다.
      //   env 를 바꾸지 않는다 — 자식 env 로만 내려간다(전역 오염 금지).
      let codexHome: string | undefined;
      if (opts.account) {
        const { codexStoreKey } = await import('../oauth/codex-account.js');
        const { loadTokens } = await import('../oauth/store.js');
        const stored = loadTokens(codexStoreKey(opts.account));
        codexHome = stored?.codexHome;
        if (!codexHome) {
          console.error(`계정 '${opts.account}' 의 홈을 정본이 모른다 — 먼저 account import 하라 (⛔ 다른 계정을 대신 재지 않는다)`);
          process.exitCode = 1; return;
        }
      }
      try {
        const snap = await createCodexFetcher(codexHome ? { codexHome } : {}).fetch();
        if (opts.json) { await writeStdoutJson(JSON.stringify(snap, null, 2) + '\n'); return; }
        console.log(`provider   ${snap.provider}${snap.plan ? ` · plan=${snap.plan}` : ''}`);
        // ⛔ 「찼다」는 공급자가 «말한 것»만 적는다 — used 로 추론하지 않는다(R-LLM1).
        console.log(`리밋 도달   ${snap.rateLimitReached ?? '(provider 가 말하지 않음)'}`);
        if (snap.credits) console.log(`크레딧     balance=${snap.credits.balance} hasCredits=${snap.credits.hasCredits} unlimited=${snap.credits.unlimited}`);
        for (const w of snap.windows) {
          const resets = w.resetsAt ? new Date(w.resetsAt).toLocaleString() : '(모름)';
          console.log(`  ${w.kind.padEnd(7)} ${String(w.windowMinutes).padStart(6)}분  used=${String(w.used).padStart(3)}%  리셋=${resets}${w.model ? `  [${w.model}]` : ''}`);
        }
        if (snap.windows.length === 0) console.log('  (창 없음 — provider 가 아무 창도 주지 않았다)');
      } catch (error) {
        console.error(`codex usage 실패: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    });

  // ⛔⭐⭐⭐⭐ **한 화면** — 이 축의 진단 시간 대부분이 「어느 우주에서 무엇을 보고 있나」를
  //   손으로 맞추는 데 갔다(2026-08-07). 그 셋(우주·신호 나이·회전 dry-run)이 여기 같이 뜬다.
  // 릴리스 노트: `elanous provider codex status` 가 한도 정책과 계정별 크레딧 잔액을 보여 준다 — 회전이 왜 그 계정으로 갔는지 화면에서 읽힌다.
  // ⛔ READ-ONLY 이고 «네트워크를 안 친다» — 디스크 신호만 읽는다. 사용량을 «새로 재려면»
  //   `provider codex usage --account <이름>` 를 따로 부른다(그건 자식을 띄운다).
  codexCmd
    .command('status')
    .description('회전·신호·우주를 «한 화면»으로 본다 (READ-ONLY · 네트워크 안 침 · 관측 안 남김)')
    .option('--json', 'JSON 으로 출력')
    .action(async (opts: { json?: boolean }) => {
      const { inspectCodexRotation } = await import('../oauth/codex-account-store.js');
      const { CODEX_QUOTA_POLICY_LABEL } = await import('../oauth/codex-quota-policy.js');
      const { authStorePath } = await import('../oauth/store.js');
      // ⛔⭐⭐⭐ 우주는 «정식 resolver»로 잡는다(리뷰 must-fix) — env 로 재구성하면 `--test`·
      //   `--test-state-dir`(setTestStateRoot 경유) 격리를 «놓친다». 표면이 런타임과 다른 자를
      //   쓰면 안 된다는 이 축의 규칙이 여기에도 그대로 걸린다.
      const { elanousStateRoot } = await import('../autopilot/state-paths.js');
      // 쿼터 신호는 계정 자격에서 파생된 공유 사실이므로 인스턴스 격리 축이 아니라 자격 뿌리를 따른다.
      const { quotaSignalDir } = await import('../budget/codex-reset-credit-state.js');
      const now = Date.now();
      const s = inspectCodexRotation(process.env, { now });
      const instanceRoot = elanousStateRoot();
      const signalDir = quotaSignalDir();
      const { findOrphanQuotaSignals } = await import('../budget/orphan-quota-signals.js');
      const { codexCredentialRoot } = await import('../budget/codex-reset-credit-state.js');
      const orphans = findOrphanQuotaSignals(instanceRoot, codexCredentialRoot(), now);
      // ⛔⭐ 「후보」는 판정기가 «자기 자신을 뺀» 것이다 — 표면이 현재 계정을 후보로 보여 주면
      //   ***있지도 않은 선택지를 말한다***(리뷰 must-fix). 판정기와 같은 기준(storeKey)으로 거른다.
      const shownCandidates = s.candidates.filter((c) => c.storeKey !== s.current.storeKey);
      const { codexCreditPlanFromDisk } = await import('./codex-credit-plan-view.js');
      const { formatCodexCreditPlan } = await import('../budget/codex-credit-plan.js');
      const creditPlan = codexCreditPlanFromDisk(now);
      const ageMinOf = (home: string | undefined): number | null => {
        if (!home) return null;
        const at = home === s.currentHome ? s.currentObservedAt : s.observedAtByHome[home];
        return at === undefined ? null : Math.round((now - at) / 60000);
      };
      // ⛔⭐⭐ 「만료」와 「없음」을 «가른다»(리뷰 must-fix) — 만료면 «나이를 보여 준다».
      //   「65분 전(곧 갱신)」과 「3일 전(갱신이 죽었다)」은 완전히 다른 진단이다.
      const freshOf = (home: string | undefined): boolean =>
        home === undefined ? false : (home === s.currentHome ? s.currentSignalFresh : (s.freshByHome[home] ?? false));
      const ageOf = (home: string | undefined): string => {
        const m = ageMinOf(home);
        if (m === null) return '⛔ 없음 (신호 파일이 아예 없다 ⇒ 판정은 「모른다」)';
        return freshOf(home) ? `${m}분 전` : `⛔ ${m}분 전 — «만료»(⇒ 판정은 「모른다」 ⇒ 회전 안 섬)`;
      };
      const creditText = (balance: number | undefined, hasCredits: boolean | undefined): string =>
        hasCredits === false ? '없음' : balance === undefined ? '?' : String(Math.round(balance));
      if (opts.json) {
        await writeStdoutJson(JSON.stringify({
          policy: { value: s.policy.policy, source: s.policy.source },
          creditPlan,
          universe: {
            instanceRoot, signalDir, authStore: authStorePath(),
            // ⭐ JSON 에도 싣는다 — 화면만 알면 스크립트가 못 센다
            ...(orphans.dir ? { orphanQuotaSignals: orphans } : {}),
          },
          // ⛔ 임계는 «판정기가 실제로 쓴» 정규화 값이다 — raw config 가 아니다(리뷰 must-fix)
          rotation: { reason: s.reason, to: s.to ?? null, explicit: s.explicit, enabled: s.enabled, thresholdPercent: s.thresholdPercent },
          // ⭐ 신호 «나이»가 핵심 진단 항목이다 — JSON 에도 반드시 싣는다(리뷰 must-fix)
          current: {
            name: s.current.name, source: s.current.source, home: s.currentHome ?? null,
            reached: s.currentReached ?? null, usedPercent: s.currentUsedPercent ?? null,
            creditBalance: s.currentCreditBalance ?? null, hasCredits: s.currentHasCredits ?? null,
            signalObservedAt: s.currentObservedAt ?? null, signalAgeMinutes: ageMinOf(s.currentHome),
            // ⭐ 나이와 «유효성»은 다른 값이다 — 만료돼도 나이는 낸다
            signalFresh: freshOf(s.currentHome),
          },
          candidates: shownCandidates.map((c) => ({
            name: c.name, home: c.home, reached: c.reached ?? null, usedPercent: c.usedPercent ?? null,
            creditBalance: c.creditBalance ?? null, hasCredits: c.hasCredits ?? null,
            signalObservedAt: s.observedAtByHome[c.home] ?? null, signalAgeMinutes: ageMinOf(c.home),
            signalFresh: freshOf(c.home),
          })),
        }, null, 2) + '\n');
        return;
      }
      console.log('━━ codex 멀티 계정 상태 ━━');
      console.log(`우주      인스턴스  : ${instanceRoot}`);
      // ⛔⭐⭐ **라벨이 «참»일 때만 그렇게 말한다**(2026-08-19 · `OBS-T114` 재현이 이 거짓말을 드러냈다).
      //   종전엔 신호가 파생 우주를 가리켜도 ***"자격과 같은 공유 뿌리"*** 라고 찍었다 —
      //   같은 화면 두 줄이 «서로 다른 말»을 했다(`F14` — 표면이 광고한 계약 ↔ 그 표면이 재는 것).
      const authRoot = _dirname(authStorePath());
      console.log(signalDir === _joinPath(authRoot, 'budget')
        ? `          신호      : ${signalDir}  자격과 같은 공유 뿌리`
        : `          신호      : ${signalDir}  ⛔ 자격 뿌리(${authRoot})와 «다르다** — 이 우주만의 값이다`);
      // ⛔⭐ 「도구가 말하게」 — 파생 우주에 옛 신호가 남아 있으면 ***누가 그것을 현재 상태로 읽는다***.
      //   (이 사건이 정확히 그렇게 났다: 19시간 낡은 파일을 보고 진단했다 · `OBS-T110`)
      if (orphans.dir) {
        console.log(`          ⚠️ 고아 신호 : ${orphans.dir}  ${orphans.count}개 · 가장 새 것 ${orphans.newestAgeMinutes ?? '?'}분 전`);
        console.log('             ⛔ 이 파일들은 «아무도 안 읽는다». 열어서 「현재 상태」로 읽지 마라(OBS-T110)');
      }
      console.log(`          auth      : ${authStorePath()}  ⚠️ 자격은 «격리되지 않는다»(의도된 결정)`);
      console.log(`회전      ${s.reason}${s.to ? ` → ${s.to}` : ''}   (enabled=${s.enabled} · explicit=${s.explicit} · 임계=${s.thresholdPercent}%)`);
      const policySource = s.policy.source === 'legacy-credits' ? ' · 옛 codexCreditsAllowed 에서'
        : s.policy.source === 'default' ? ' · 기본값' : '';
      console.log(`정책      ${s.policy.policy} (${CODEX_QUOTA_POLICY_LABEL[s.policy.policy]} · llm.codexQuotaPolicy)${policySource}`);
      for (const line of formatCodexCreditPlan(creditPlan)) console.log(line);
      console.log(`지금 계정 ${s.current.name}  (source=${s.current.source})`);
      console.log(`          홈=${s.currentHome ?? '(모름)'}  사용=${s.currentUsedPercent ?? '?'}%  찼나=${s.currentReached ?? '모름'}  신호=${ageOf(s.currentHome)}  크레딧=${creditText(s.currentCreditBalance, s.currentHasCredits)}`);
      console.log('후보');
      if (shownCandidates.length === 0) console.log('  (없음 — 홈을 아는 «다른» 계정이 없다 ⇒ 찼을 때 갈 곳이 없다)');
      for (const c of shownCandidates) {
        console.log(`  ${c.name.padEnd(10)} 사용=${String(c.usedPercent ?? '?').padStart(3)}%  찼나=${String(c.reached ?? '모름').padEnd(5)}  신호=${ageOf(c.home)}  크레딧=${creditText(c.creditBalance, c.hasCredits)}`);
      }
      if (s.reason === 'not-reached') {
        // ⛔⭐ 「신선하다」와 「쓸 값이 있다」는 다른 말이다(리뷰 must-fix) — 신호가 신선해도
        //   찼는지·몇 %인지가 «둘 다 없으면» 판정은 여전히 「모른다」다. 그때 「정상이다」라고
        //   말하면 ***없는 안심을 준다.*** 셋으로 가른다.
        const noUsable = s.currentReached === undefined && s.currentUsedPercent === undefined;
        console.log(!freshOf(s.currentHome)
          ? '💡 안 넘어가는 중 — 신호가 «없거나 만료»다. 그것이 원인이다 ⇒ 런이 돌면 자동 갱신되고, 급하면 `provider codex usage --account <이름>`.'
          : noUsable
            ? '⛔ 안 넘어가는 중 — 신호는 «신선한데 내용이 비었다»(찼는지도 사용률도 없다) ⇒ 판정은 「모른다」다.'
              + '\n   🩹 `provider codex usage --account <이름> --json` 으로 provider 응답을 직접 보라 — 창이 안 실렸을 수 있다.'
            : '💡 안 넘어가는 중 — 신호가 «신선»하고 지금 계정이 아직 임계 아래다. 정상이다.');
      } else if (s.reason === 'no-candidate') {
        // ⛔⭐ 「갈 곳이 없다」의 이유가 «셋»인데 한 문장으로 뭉개면 오진한다(리뷰 must-fix).
        //   계정이 하나뿐인 것은 «정상 구성»이지 고장이 아니다 — 그때 필요한 것은 진단이 아니라 «다음 수»다.
        if (shownCandidates.length === 0) {
          // ⛔ 계정 수는 «스토어»에 묻는다 — `candidates` 는 홈 아는 것만 남은 목록이라
          //   그것으로 세면 홈 없는 계정이 안 세어져 «거짓 원인»을 낸다(리뷰 must-fix).
          const known = s.knownAccountCount;
          console.log(known <= 1
            ? '⛔ 찼는데 «갈 곳이 없다» — 정본이 아는 계정이 «이것 하나»다(고장이 아니라 구성이다).'
              + '\n   🩹 둘째 계정을 들인다: 그 홈으로 `codex login` 한 뒤 `elanous provider codex account import <이름> --home <홈>`'
            : '⛔ 찼는데 «갈 곳이 없다» — 다른 계정은 있는데 «홈을 몰라» 후보가 못 됐다.'
              + '\n   🩹 `elanous provider codex account list` 로 홈을 확인하고, 없으면 그 계정을 다시 import 한다.');
        } else {
          console.log('⛔ 찼는데 «갈 곳이 없다» — 후보는 있는데 «그들도 찼다»(위 후보 목록의 사용률을 보라).');
        }
      }
    });

  const accountCmd = codexCmd.command('account').description('Codex 계정 — 조회 · 정본 스토어로 들여오기 (⭐ 자동 회전은 «기본 ON» — llm.codexAccountRotation:false 로만 끈다)');

  accountCmd.hook('preAction', async () => {
    try {
      const { registerStandaloneLogSink } = codexAccountLogSinkModuleForTesting
        ?? await import('../domains/standalone-log-sink.js');
      await registerStandaloneLogSink(CODEX_ACCOUNT_CLI_SINK_SURFACE);
    } catch { /* fail-open — observation wiring must not block Codex account commands */ }
  });

  accountCmd
    .command('list')
    .description('elanous 정본 스토어가 아는 codex 계정을 보여준다 (READ-ONLY · ⛔ 토큰 값은 안 찍는다)')
    .action(async () => {
      const { listCodexAccountsInStore, activeCodexAccountView } = await import('../oauth/codex-account-store.js');
      // ⛔⭐⭐ 「홈」은 «실효» 홈이어야 한다 — env 해석을 그대로 찍으면 정본 기록이 이기는 경우에
      //   ***CLI 가 거짓 상태를 보고한다***(4R must-fix). 뷰가 런타임과 «같은 자»를 쓴다.
      const active = activeCodexAccountView();
      console.log(`활성  ${active.name}  (storeKey=${active.storeKey} · source=${active.source})`);
      console.log(`홈    ${active.home ?? '(없음 — 정본이 이 계정의 홈을 모른다 · 어느 미러도 안 쓴다)'}  (source=${active.homeSource})`);
      if (active.declaredHome) {
        console.log(`⚠️ 선언된 홈은 ${active.declaredHome} 지만 «정본 기록»이 이긴다 — 실제로 쓰이는 것은 위의 홈이다`);
      }
      const rows = listCodexAccountsInStore();
      if (rows.length === 0) { console.log('  (정본 스토어에 codex 계정 없음)'); return; }
      for (const r of rows) console.log(`  ${r.name.padEnd(12)} storeKey=${r.storeKey}  authMode=${r.authMode ?? '-'}`);
    });

  accountCmd
    .command('import <name>')
    .description('그 홈의 codex 로그인을 elanous 정본 스토어로 들여온다 — 그래야 elanous 가 그 계정으로 «실행»한다')
    .requiredOption('--home <path>', '그 계정의 CODEX_HOME (예: ~/.codex-new)')
    .action(async (name: string, opts: { home: string }) => {
      const { importCodexAccountFromHome } = await import('../oauth/codex-account-store.js');
      const r = await importCodexAccountFromHome(name, opts.home);
      if (!r.ok) { console.error(`들여오기 실패(${r.kind}): ${r.message}`); process.exitCode = 1; return; }
      console.log(`✅ ${name} 을 정본 스토어에 들였다 — storeKey=${r.storeKey} · accountId=${r.accountIdPrefix}`);
      // Usage resolves its home from --account; one-run execution resolves it from per-run env.
      // Keep these entrances separate so every printed command can be pasted and run as shown.
      for (const guidance of buildCodexAccountImportGuidance(name, opts.home)) console.log(`  ${guidance}`);
      // ⛔⭐ 2026-08-17 정정 — 옛 문면은 *"지속 설정과 자동 회전은 «아직 없다» — S4 다"* 였고 «거짓»이었다.
      //   회전은 착지했고 기본 ON 이다(codex-account-rotation.ts: `llm.codexAccountRotation !== false`).
      //   실측 근거: `account list` 가 `source=rotated` 를 찍고 있었다. ⇒ 기능이 늙은 문면을 앞질렀다.
      console.log('⭐ 이 계정은 «자동 회전 후보»가 됐다 — 별도 설정 불필요. 현재 계정이 임계(기본 95%)에 닿으면 이름 사전순으로 넘어간다.');
      console.log('   끄려면 config `llm.codexAccountRotation: false` · 임계는 `llm.codexAccountRotationThresholdPercent`.');
      console.log('   확인:  bun bin/elanous.mjs provider codex account list   ·   bun bin/elanous.mjs usage');
    });

  // POD-TOKEN-PREREFRESH (10-06): 사람이 두 번 손으로 한 «백업 → refresh → 원자적 0600 쓰기 → import» 를 한 명령으로.
  // ⛔ 토큰 값은 안 찍는다 — 남은 시간 전→후만. ⛔ default(~/.codex · 대표 기본 계정)는 거부.
  accountCmd
    .command('refresh <name>')
    .description('그 계정의 codex 토큰을 호스트에서 갱신해 정본 스토어로 반영한다 (⛔ default 거부 · 토큰 값은 안 찍는다 · ⚠️ refresh 토큰은 갱신마다 회전 — 본부 한 곳에서만)')
    .action(async (name: string) => {
      const { refreshCodexAccountHome } = await import('../oauth/codex.js');
      const r = await refreshCodexAccountHome(name);
      if (!r.ok) { console.error(`갱신 실패(${r.kind}): ${r.message}`); process.exitCode = 1; return; }
      const h = (v: number | null) => (v === null ? '?' : `${v}h`);
      console.log(`✅ ${name} 갱신 — 남은 시간 ${h(r.beforeH)} → ${h(r.afterH)} · storeKey=${r.storeKey}`);
      console.log(`   백업: ${r.backupPath}`);
    });

  const resetCreditsCmd = codexCmd.command('reset-credits').description('리셋 크레딧 — 조회 · 관측 · 사용(⛔ 사용은 되돌릴 수 없다)');

  resetCreditsCmd
    .command('list')
    .description('사용 가능한 리셋 크레딧을 조회한다 (READ-ONLY)')
    .option('--json', 'JSON 으로 출력')
    .action(async (opts: { json?: boolean }) => {
      const { listCodexResetCredits } = await import('../budget/codex-reset-credits.js');
      const r = await listCodexResetCredits({});
      if (opts.json) { await writeStdoutJson(JSON.stringify(r, null, 2) + '\n'); process.exitCode = r.ok ? 0 : 1; return; }
      if (!r.ok) { console.error(`조회 실패(${r.kind}): ${r.message}`); process.exitCode = 1; return; }
      console.log(`available=${r.value.availableCount} · totalEarned=${r.value.totalEarnedCount}`);
      for (const c of r.value.credits) {
        console.log(`  ${c.id}  status=${c.status}  title=${c.title ?? '-'}  expires=${c.expires_at ?? '-'}`);
      }
      if (r.value.credits.length === 0) console.log('  (없음)');
    });

  resetCreditsCmd
    .command('observe')
    .description('가용 수의 «전이»를 한 번 관측해 기록한다 — 부여 주기의 표본을 모은다 (READ-ONLY)')
    .action(async () => {
      const { observeResetCreditAvailability } = await import('../budget/codex-reset-credits.js');
      const { readAvailabilityState, writeAvailabilityState } = await import('../budget/codex-reset-credit-state.js');
      const { resolveCodexAccount, effectiveCodexHome } = await import('../oauth/codex-account.js');
      const { authStorePath, loadTokens } = await import('../oauth/store.js');
      // ⛔ 관측하는 auth.json과 가용 수를 기록하는 홈은 정본이 아는 «같은 계정 홈»이어야 한다.
      // 이름 계정은 env 해석만으로는 홈을 잃어 default로 떨어질 수 있으므로, resolver와 같은 storedHome 심을 준다.
      const storePath = authStorePath();
      const current = resolveCodexAccount(process.env, { storedHome: (key) => loadTokens(key, storePath)?.codexHome });
      const currentHome = effectiveCodexHome(current, loadTokens(current.storeKey, storePath), process.env).home;
      const r = await observeResetCreditAvailability({
        ...(currentHome ? { authFilePath: _joinPath(currentHome, 'auth.json') } : {}),
        readPrevious: () => readAvailabilityState(currentHome),
        writeCurrent: (count) => writeAvailabilityState(count, currentHome),
      });
      if (!r.ok) { console.error(`관측 실패(${r.kind}): ${r.message}`); process.exitCode = 1; return; }
      const { transition, from, to, isGrantSample } = r.change;
      console.log(`transition=${transition}  from=${from ?? '(모름)'} → to=${to}  부여표본=${isGrantSample ? 'yes' : 'no'}`);
      if (isGrantSample) console.log('⭐ 부여 전이를 «처음» 잡았다 — 매뉴얼 §2c 의 「모른다」를 이 표본으로 갱신할 수 있다.');
    });

  resetCreditsCmd
    .command('redeem')
    .description('⛔ 리셋 크레딧을 «사용»한다 — 되돌릴 수 없다. --yes 없이는 실행하지 않는다')
    .option('--yes', '되돌릴 수 없음을 확인했다')
    .option('--request-id <id>', '멱등키를 직접 준다(재시도 시 같은 값을 주면 중복 소비를 막는다)')
    .action(async (opts: { yes?: boolean; requestId?: string }) => {
      if (!opts.yes) {
        console.error('⛔ 이 명령은 크레딧을 «소비»하고 되돌릴 수 없다. 확인했으면 --yes 를 붙여라.');
        process.exitCode = 2;
        return;
      }
      const { consumeCodexResetCredits } = await import('../budget/codex-reset-credits.js');
      const r = await consumeCodexResetCredits(opts.requestId ? { redeemRequestId: opts.requestId } : {});
      if (!r.ok) { console.error(`사용 실패(${r.kind}): ${r.message}`); process.exitCode = 1; return; }
      try {
        const { activeCodexAccountView, notifyCodexResetCreditConsumed } = await import('../oauth/codex-account-store.js');
        const { listCodexResetCredits } = await import('../budget/codex-reset-credits.js');
        const account = activeCodexAccountView();
        const remaining = await listCodexResetCredits();
        notifyCodexResetCreditConsumed(account, remaining.ok ? remaining.value.availableCount : undefined);
      } catch (error) {
        debug.log('oauth.codex-account', 'outbound-prepare-failed', {
          event: 'reset-credit-consumed',
          message: error instanceof Error ? error.message : String(error),
        }, { level: 'warn' });
      }
      await writeStdoutJson(JSON.stringify(r.value, null, 2) + '\n');
      console.log('⭐ 효과 확인은 `elanous provider codex usage` 로 — usedPercent 가 떨어졌는지 본다.');
    });

  program
    .command('provider:set <name>')
    .description(
      'Swap active LLM provider in config.json (auto-backs-up the previous config ' +
      'to its `.bak` sibling — ⛔ the path is the ACTIVE config, not a fixed one: run `elanous where` to see it). ' +
      'Useful for A/B testing model behaviour ' +
      '— e.g. `elanous provider:set anthropic` to force-switch to Claude, then ' +
      '`elanous provider:set restore` (or `elanous provider:restore`) to roll back.',
    )
    .option('-m, --model <model>', 'Model id. Default: $<PROVIDER>_MODEL env or a sensible fallback')
    .option('-k, --api-key <key>', 'API key. Default: pulled from the provider-specific env (ANTHROPIC_API_KEY, etc.)')
    .option('--base-url <url>', 'Custom base URL (OpenAI-compatible proxies, local).')
    .option('--no-backup', "Don't write config.json.bak before overwriting.")
    .action((name: string, opts: { model?: string; apiKey?: string; baseUrl?: string; backup?: boolean }) => {
      const provider = name.toLowerCase();
      const known = Object.keys(PROVIDER_DEFAULT_MODEL);
      if (!known.includes(provider) && provider !== 'auto') {
        ui.error(`unknown provider "${name}". Known: ${known.join(', ')}, auto`);
        process.exit(1);
      }

      const path = userConfigPath();
      const bakPath = backupConfigPath(path);

      // Auto-backup unless --no-backup explicitly set.
      let backedUp = false;
      if (opts.backup !== false) {
        try {
          backedUp = backupUserConfig(path, bakPath);
        } catch (err: any) {
          ui.error(`backup failed: ${err?.message ?? err}`);
          process.exit(1);
        }
      }

      // Resolve model: --model > env > provider fallback.
      const providerInfo = PROVIDER_DEFAULT_MODEL[provider];
      const model = opts.model
        ?? (providerInfo && process.env[providerInfo.env])
        ?? providerInfo?.fallback;

      // Resolve api key: --api-key > env (only for providers that have one).
      const keyEnv = PROVIDER_KEY_ENV[provider];
      const apiKey = opts.apiKey
        ?? (keyEnv && process.env[keyEnv])
        ?? undefined;

      // Build the next config. Keep all non-llm sections untouched.
      const cfg = getUserConfig();
      cfg.llm = {
        ...cfg.llm,
        provider: provider as typeof cfg.llm.provider,
        ...(model  ? { model }  : {}),
        ...(apiKey ? { apiKey } : {}),
        ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
      };

      try {
        saveUserConfig(cfg, path);
      } catch (err: any) {
        ui.error(`save failed: ${err?.message ?? err}`);
        if (backedUp) ui.info(`backup remains at ${bakPath} — restore with \`elanous provider:restore\``);
        process.exit(1);
      }
      reloadUserConfig();

      ui.header(`Provider switched → ${provider}`);
      console.log(`  model:  ${model ?? '(provider default)'}`);
      if (apiKey) {
        const mask = apiKey.length > 10 ? `${apiKey.slice(0, 4)}…${apiKey.slice(-4)}` : '****';
        console.log(`  apiKey: ${mask} (from ${opts.apiKey ? '--api-key' : keyEnv + ' env'})`);
      } else if (keyEnv) {
        console.log(`  apiKey: (unset — set $${keyEnv} or pass --api-key)`);
      }
      if (opts.baseUrl) console.log(`  baseUrl: ${opts.baseUrl}`);
      if (backedUp)     console.log(`\n  backup: ${bakPath}`);
      console.log('');
      console.log(renderProviderStatus());
      process.exit(0);
    });

  program
    .command('provider:restore')
    .description('Restore config.json from the automatic backup written by `elanous provider:set`.')
    .action(() => {
      const path = userConfigPath();
      const bakPath = backupConfigPath(path);
      const restored = restoreUserConfig(path, bakPath);
      if (!restored) {
        ui.error(`no backup found at ${bakPath}`);
        process.exit(1);
      }
      reloadUserConfig();
      ui.header(`Restored from ${bakPath}`);
      console.log('');
      console.log(renderProviderStatus());
      process.exit(0);
    });

  program
    .command('provider:rotate [sub] [target]')
    .description(
      'Cycle through the rotation list. With no argument: advance one step. ' +
      'Sub-commands: `list` (print list), `reset` (jump to first entry), ' +
      '`add <provider> [-m model] [-l label]` (append), `remove <label>`, ' +
      '`clear` (wipe rotation).',
    )
    .option('-m, --model <model>', 'Model id (used with `add`)')
    .option('-l, --label <label>', 'Short name for `use` shortcut (used with `add`)')
    .option('-k, --api-key <key>', 'API key override (used with `add`)')
    .action((sub: string | undefined, target: string | undefined, opts: { model?: string; label?: string; apiKey?: string }) => {
      const path = userConfigPath();
      let cfg = getUserConfig();

      // ── sub-command dispatch ─────────────────────────────────
      const verb = (sub ?? '').toLowerCase();

      if (verb === 'list' || verb === 'ls') {
        const idx = currentRotationIndex(cfg);
        ui.header('Provider rotation');
        console.log('');
        console.log(formatRotationList(cfg, idx));
        console.log('');
        console.log(renderProviderStatus());
        process.exit(0);
      }

      if (verb === 'reset') {
        const rot = cfg.llm.rotation;
        if (!rot || rot.length === 0) {
          ui.error('rotation is empty — nothing to reset to');
          process.exit(1);
        }
        backupUserConfig(path).valueOf();  // silent best-effort
        const { cfg: next, entry } = jumpToRotationEntry(cfg, rotationEntryLabel(rot[0]!));
        if (!entry) { ui.error('reset failed'); process.exit(1); }
        saveAndReload(path, next);
        ui.header(`Reset → ${rotationEntryLabel(entry)}`);
        console.log('');
        console.log(renderProviderStatus());
        process.exit(0);
      }

      if (verb === 'add') {
        // `target` is the second positional — the provider name.
        const providerName = (target ?? '').toLowerCase();
        const known = supportedProviderNames();
        if (!providerName || !known.has(providerName)) {
          const sortedKnown = [...known].sort().join(', ');
          ui.error(
            `usage: elanous provider:rotate add <provider> [-m model] [-l label]\n`
            + `Known providers: ${sortedKnown}`,
          );
          process.exit(1);
        }
        const model = opts.model
          ?? process.env[`${providerName.toUpperCase().replace('-', '_')}_MODEL`]
          ?? defaultModelIdFor(providerName);
        const keyEnv = apiKeyEnvFor(providerName);
        const apiKey = opts.apiKey ?? (keyEnv && process.env[keyEnv]) ?? undefined;
        const label = opts.label ?? undefined;
        const entry: RotationEntry = {
          provider: providerName as RotationEntry['provider'],
          ...(model  ? { model }  : {}),
          ...(apiKey ? { apiKey } : {}),
          ...(label  ? { label }  : {}),
        };
        backupUserConfig(path).valueOf();
        const next = addRotationEntry(cfg, entry);
        saveAndReload(path, next);
        ui.header(`Added → ${rotationEntryLabel(entry)}`);
        console.log('');
        console.log(formatRotationList(getUserConfig(), currentRotationIndex(getUserConfig())));
        process.exit(0);
      }

      if (verb === 'remove' || verb === 'rm' || verb === 'del') {
        if (!target) {
          ui.error('usage: elanous provider:rotate remove <label>');
          process.exit(1);
        }
        backupUserConfig(path).valueOf();
        const { cfg: next, removed } = removeRotationEntry(cfg, target);
        if (!removed) {
          ui.error(`no rotation entry matching "${target}"`);
          process.exit(1);
        }
        saveAndReload(path, next);
        ui.header(`Removed → ${rotationEntryLabel(removed)}`);
        console.log('');
        console.log(formatRotationList(getUserConfig(), currentRotationIndex(getUserConfig())));
        process.exit(0);
      }

      if (verb === 'clear') {
        backupUserConfig(path).valueOf();
        cfg = { ...cfg, llm: { ...cfg.llm, rotation: undefined } };
        saveAndReload(path, cfg);
        ui.header('Rotation cleared');
        process.exit(0);
      }

      // ── default: advance one step ────────────────────────────
      const rot = cfg.llm.rotation;
      if (!rot || rot.length === 0) {
        ui.error(
          'rotation is empty — add entries first:\n' +
          '  elanous provider:rotate add anthropic    -m claude-opus-4-8    -l opus\n' +
          '  elanous provider:rotate add openai-codex -m gpt-5.5            -l codex\n' +
          '  elanous provider:rotate add grok         -m grok-4.20          -l grok\n' +
          '  elanous provider:rotate          # advance\n' +
          '  elanous provider:rotate list     # show list',
        );
        process.exit(1);
      }
      backupUserConfig(path).valueOf();
      const { cfg: next, entry } = rotateNextProvider(cfg);
      if (!entry) { ui.error('rotate failed'); process.exit(1); }
      saveAndReload(path, next);
      ui.header(`Rotated → ${rotationEntryLabel(entry)}`);
      console.log('');
      console.log(formatRotationList(getUserConfig(), currentRotationIndex(getUserConfig())));
      console.log('');
      console.log(renderProviderStatus());
      process.exit(0);
    });

  program
    .command('provider:use <needle>')
    .description(
      'Jump to a specific rotation entry by label / provider name / model substring. ' +
      'Auto-backs-up config.json before the switch (restore with `elanous provider:restore`). ' +
      'Example: `elanous provider:use opus`, `elanous provider:use grok`, `elanous provider:use gpt-5`.',
    )
    .action((needle: string) => {
      const path = userConfigPath();
      const cfg = getUserConfig();
      const rot = cfg.llm.rotation;
      if (!rot || rot.length === 0) {
        ui.error(
          'rotation is empty — add entries first with `elanous provider:rotate add <provider>`',
        );
        process.exit(1);
      }
      backupUserConfig(path).valueOf();
      const { cfg: next, entry } = jumpToRotationEntry(cfg, needle);
      if (!entry) {
        ui.error(
          `no rotation entry matching "${needle}". Known entries:\n${formatRotationList(cfg, -1)}`,
        );
        process.exit(1);
      }
      saveAndReload(path, next);
      ui.header(`Switched → ${rotationEntryLabel(entry)}`);
      console.log('');
      console.log(renderProviderStatus());
      process.exit(0);
    });
}
