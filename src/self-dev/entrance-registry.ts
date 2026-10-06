import { findNativeTool, isNativeToolModelExposed } from '../native-tool-catalog.js';

export type EntranceStatus = 'live' | 'retired' | 'closed';

export type EntranceStampability = 'stampable' | 'structurally-unstampable' | 'unknown';

export type EntranceVerificationStatus = 'verified' | 'unknown';

export interface EntranceVerificationState {
  readonly actualMission: EntranceVerificationStatus;
  readonly legacyParity: EntranceVerificationStatus;
}

const UNKNOWN_ENTRANCE_VERIFICATION_STATE: EntranceVerificationState = {
  actualMission: 'unknown',
  legacyParity: 'unknown',
};

export interface EntranceDeclaration {
  /** ⛔⭐ `string` 이 아니라 «등기부 식별자»다 — 부르는 쪽이 `.id` 를 그대로 각인에 넘길 수 있어야
   *  「이 입구를 안 쓴다」와 「이 입구를 «못 잰다»」가 갈린다(2026-08-22). */
  readonly id: EntranceId;
  readonly surface: EntranceSurface;
  readonly status: EntranceStatus;
  /** Whether this entrance can stamp its registry identity into launch observation. */
  readonly stampability: EntranceStampability;
  /** Repository-relative file that substantiates the stampability decision, when file-backed. */
  readonly stampabilityEvidenceFilePath: ExportIdentifierEvidenceSourceFilePath;
  /** Manual entrance live-verification declaration. Unknown means the registry has no human-written verdict yet. */
  readonly verification: EntranceVerificationState;
}

export type NonEmptyExportedIdentifiers = readonly [string, ...string[]];

export type ExportIdentifierEvidenceSource = 'entrance-registry' | 'self-implement-tool-names' | 'structural-absence' | 'unverified';
export type ExportIdentifierEvidenceSourceFilePath = 'src/self-dev/entrance-registry.ts' | 'src/boot/daemon-tools/self-implement-names.ts' | undefined;

export type ExportIdentifierEvidence =
  | {
    readonly kind: 'present';
    readonly exportedIdentifiers: NonEmptyExportedIdentifiers;
    readonly source: ExportIdentifierEvidenceSource;
    readonly sourceFilePath: ExportIdentifierEvidenceSourceFilePath;
  }
  | { readonly kind: 'absent'; readonly source: ExportIdentifierEvidenceSource; readonly sourceFilePath: ExportIdentifierEvidenceSourceFilePath }
  | { readonly kind: 'unverified'; readonly source: ExportIdentifierEvidenceSource; readonly sourceFilePath: ExportIdentifierEvidenceSourceFilePath };

interface EntranceDraft {
  readonly id: EntranceId;
  readonly surface: EntranceSurface;
  readonly status: EntranceStatus;
  readonly verification?: EntranceVerificationState;
}

/** Returns the human-facing warning only for a retired launch entrance. */
export function retiredEntranceNotice(entrance: EntranceDeclaration): string | undefined {
  return entrance.status === 'retired'
    ? `[ask] ⚠️ 이 발사 입구는 은퇴했다: ${entrance.id}`
    : undefined;
}

/** 명령 «설명»에 붙일 은퇴 표시 — ⛔ 붙이는 쪽이 문면을 «지어내지» 않게 한 곳에서 낸다.
 *
 *  ⛔⭐ **이것이 필요한 이유**(RFC-one-door-many-entrances P2 · 2026-08-17 사고의 처방):
 *  ***은퇴한 입구가 「열려 있고 아무 말도 안 하면」 사람이 그 문으로 들어간다.***
 *  📏 2026-08-20 실측 — 레지스트리가 은퇴로 선언한 입구 셋 중 `--help` 가 그 사실을 말한 것은
 *  ***하나뿐이었고***, 그 하나조차 문면을 «손으로» 들고 있었다(레지스트리와 무관).
 *  ⇒ 선언과 표면이 갈리면 «선언은 늙고 표면은 거짓말한다».
 *
 *  ⛔ `replacement` 를 «요구»한다 — 이 저장소가 반복해 배운 것이 「금지만 주고 길을 안 주면 멈춘다」이다.
 *  은퇴를 알리면서 갈 곳을 안 주면 그 경고는 사람을 막기만 한다. */
export function retiredEntranceDescriptionPrefix(
  entrance: EntranceDeclaration,
  replacement: string,
): string | undefined {
  if (entrance.status !== 'retired') return undefined;
  return `⚠️ DEPRECATED(${entrance.id}) — 대신 \`${replacement}\` 를 쓰세요. `;
}

/** 설명 앞에 은퇴 표시를 «붙인다». live 면 원문 그대로 — 호출자가 분기하지 않게 한다. */
export function describeEntranceCommand(
  entrance: EntranceDeclaration,
  replacement: string,
  description: string,
): string {
  return `${retiredEntranceDescriptionPrefix(entrance, replacement) ?? ''}${description}`;
}

/** 입구가 «어느 표면»에서 오나. ⛔ 표면은 능력을 «뜻하지 않는다» — 그것은 P3 의 몫이다. */
export type EntranceSurface = 'nl' | 'slash' | 'cli' | 'daemon';

const sourceFilePathByEvidenceSource = {
  'entrance-registry': 'src/self-dev/entrance-registry.ts',
  'self-implement-tool-names': 'src/boot/daemon-tools/self-implement-names.ts',
  'structural-absence': undefined,
  unverified: undefined,
} as const satisfies Readonly<Record<ExportIdentifierEvidenceSource, ExportIdentifierEvidenceSourceFilePath>>;

const declaredExportIdentifiers = (
  exportedIdentifiers: NonEmptyExportedIdentifiers,
  source: ExportIdentifierEvidenceSource = 'entrance-registry',
): ExportIdentifierEvidence => ({
  kind: 'present',
  exportedIdentifiers,
  source,
  sourceFilePath: sourceFilePathByEvidenceSource[source],
});

const selfImplementToolNamesEvidence = declaredExportIdentifiers(
  ['SELF_IMPLEMENT_TOOL_NAMES'],
  'self-implement-tool-names',
);
const structurallyAbsentEvidence = { kind: 'absent', source: 'structural-absence', sourceFilePath: sourceFilePathByEvidenceSource['structural-absence'] } as const;
const unverifiedEvidence = { kind: 'unverified', source: 'unverified', sourceFilePath: sourceFilePathByEvidenceSource.unverified } as const;

/** 각 입구 id 의 export 식별자 상수 근거. `absent` 와 `unverified` 를 일부러 분리한다. */
export const ENTRANCE_EXPORT_IDENTIFIER_EVIDENCE = {
  'cli-dev-ask': declaredExportIdentifiers(['CLI_DEV_ASK_ENTRANCE']),
  'cli-drive': structurallyAbsentEvidence,
  'cli-self-implement': unverifiedEvidence,
  'cli-self-orchestrate': unverifiedEvidence,
  'cli-harness-ask': declaredExportIdentifiers(['CLI_HARNESS_ASK_ENTRANCE']),
  'cli-harness-say': declaredExportIdentifiers(['CLI_HARNESS_SAY_ENTRANCE']),
  'cli-harness-orchestrate': declaredExportIdentifiers(['CLI_HARNESS_ORCHESTRATE_ENTRANCE']),
  'cli-harness-plan': declaredExportIdentifiers(['CLI_HARNESS_PLAN_ENTRANCE']),
  'cli-harness-run': declaredExportIdentifiers(['CLI_HARNESS_RUN_ENTRANCE']),
  'cli-harness-dogfood': declaredExportIdentifiers(['CLI_HARNESS_DOGFOOD_ENTRANCE']),
  'tui-slash-ask': declaredExportIdentifiers(['TUI_SLASH_ASK_ENTRANCE']),
  'tui-slash-implement': structurallyAbsentEvidence,
  'tui-slash-dev': structurallyAbsentEvidence,
  'nl-self-implement': selfImplementToolNamesEvidence,
  'nl-self-orchestrate': unverifiedEvidence,
  'nl-solve-mission': structurallyAbsentEvidence,
  'nl-run-dev-harness': structurallyAbsentEvidence,
  'daemon-self-implement': selfImplementToolNamesEvidence,
  'daemon-harness-ask': declaredExportIdentifiers(['DAEMON_HARNESS_ASK_ENTRANCE']),
} as const satisfies Readonly<Record<string, ExportIdentifierEvidence>>;

export type EntranceId = keyof typeof ENTRANCE_EXPORT_IDENTIFIER_EVIDENCE;

export function deriveEntranceStampability(evidence: ExportIdentifierEvidence): EntranceStampability {
  if (evidence.kind === 'present') {
    return evidence.exportedIdentifiers.length > 0 ? 'stampable' : 'unknown';
  }
  if (evidence.kind === 'absent') return 'structurally-unstampable';
  return 'unknown';
}

function stampableEntrance(draft: EntranceDraft): EntranceDeclaration {
  const evidence = ENTRANCE_EXPORT_IDENTIFIER_EVIDENCE[draft.id as EntranceId];
  return {
    ...draft,
    stampability: evidence === undefined ? 'unknown' : deriveEntranceStampability(evidence),
    stampabilityEvidenceFilePath: evidence?.sourceFilePath,
    verification: draft.verification ?? UNKNOWN_ENTRANCE_VERIFICATION_STATE,
  };
}

/** 발사 «입구» 선언 — RFC-one-door-many-entrances §1 의 전수를 «값»으로 옮긴 것.
 *
 *  ⛔⭐ **이 목록이 있는 이유**: 그 RFC 가 입구를 표로 적었는데 ***표는 늙는다***.
 *  실제로 2026-08-17 조사에서 「입구가 넷인 줄 알았는데 열셋」이었다.
 *  ⇒ 그래서 표를 «코드»에 두고 문서가 그것을 «읽게» 한다.
 *
 *  ⛔ 각 항목의 `code` 는 «그때» 확인하라는 좌표이지 보증이 아니다 — 파일이 옮겨지면 늙는다.
 *  ⭐ 늙었는지 «자동으로» 드러나게 하는 것은 P4 의 기준선 대조이고, 능력 축은 P5 다.
 */
const ENTRANCE_DECLARATIONS = [
  // ── CLI ──────────────────────────────────────────────
  // ⭐ 2026-08-24 · 🅣 — ***사람이 «돌려 보고» 적은 판정***이다(⛔ 도구가 추측한 값이 아니다).
  //   actualMission: 이 입구로 실제 골을 «끝까지» 돌린 표본이 압도적이다 —
  //     📏 한 창(🅣 125차)에서만 `[dev] self 완료 … merged-into=main` 산출 ***65건***.
  //     📏 같은 12시간 원장 축(dev-pipeline/selection)의 `cli-dev-ask` 행 ***112***.
  //   ⚠️ 종전에 이 칸이 `unknown` 이었던 것은 「안 된다」가 아니라 ***「아무도 «선언»하지 않았다」***다 —
  //     이 문은 «기준선»이라 매일 도는데도 적는 사람이 없었다. 그 상태가 ④ 집계를 «읽을 수 없게» 만들었다.
  //   legacyParity: ⛔ ***구조적으로 잴 것이 없다.*** 이 문 «자신»이 옛 입구라, 대조할 「그 앞의 문」이 없다.
  //     🩸 2026-09-02 정정(🅣 136차): 종전 문면은 *"`harness dogfood` 가 은퇴하며 «이 문»을 지목했다"*
  //       였는데 ***사실이 아니다*** — `HARNESS_DOGFOOD_REPLACEMENT` 는 `elanous harness ask <골문서>`,
  //       즉 `cli-harness-ask` 를 지목한다(`src/harness/dogfood.ts`). ⇒ 근거는 틀렸고 결론은 선다.
  //     ⭐ 그리고 그 갈림은 «작다» — `harness ask` 는 `runDefaultAskFileLaunchFlow`(`index.ts:274`)로
  //       `dev --ask` 와 ***같은*** `runAskLaunchFlow` 를 탄다. 두 문의 차이는 `entrance` 태그뿐이다.
  //     ⇒ 판정값이 `'verified' | 'unknown'` 둘뿐이라 「구조적 부재」를 적을 칸이 없다. `unknown` 으로 둔다.
  //     ⛔ 그러니 이 `unknown` 을 「미완」으로 읽지 마라 — 그 구분은 이 주석이 canonical 이다.
  // OLD-DOOR-CLOSE — a direct `dev --ask` from a terminal or seat session refuses.
  // Harness-internal calls still pass, marked with the ONEDOOR-1 entrance stamp.
  { id: 'cli-dev-ask', surface: 'cli', status: 'closed', verification: { actualMission: 'verified', legacyParity: 'unknown' } },
  // `elanous drive` 는 `elanous dev` 의 Commander alias 로 살아 있고, buildDriveAliasDevSpec 이 entrance 를
  // `cli-drive` 로 넘기며 completion 을 `worktree-only` 로 못 박는다. 그래서 별도 무인 권한 축이 아니다.
  { id: 'cli-drive', surface: 'cli', status: 'live' },
  { id: 'cli-self-implement', surface: 'cli', status: 'closed' },
  { id: 'cli-self-orchestrate', surface: 'cli', status: 'closed' },
  // ⭐ 2026-08-22 · 🅣 — ***사람이 «돌려 보고» 적은 판정***이다(⛔ 도구가 추측한 값이 아니다).
  //   actualMission: 그 입구로 실제 골을 «끝까지» 돌렸다 — 17발 · 자동 병합 5 · 회수 착지 7.
  //     📏 원장 각인이 그것을 말한다: `"entrance":"cli-harness-ask"` (아침엔 0건이었다).
  //   legacyParity: 옛 입구(`dev --ask`)와 «나란히» 놓고 대조했다 —
  //     ⑴ 오류 문면이 «글자까지» 같다(`❌ ENOENT: …`) ⑵ 완료 요약 줄이 «나온다»(#11470)
  //     ⑶ 발사 전 검사가 «돈다»(#11449 · [preflight] 0 → 9).
  //   ⭐ 2026-08-23 갱신 — `say` 도 ***actualMission: verified*** 가 됐다.
  //     📏 근거: 그 입구로 실제 골(harness orchestrate 옵션 파리티)을 쏘아 ***자동 병합까지*** 갔다
  //       (`#11552` · run-7c3d2a78 · `[dev] self 완료 · ok=true · merged-into=main`).
  //       ⊕ 원장 각인 `"entrance":"cli-harness-say"` 2건 ⊕ 그 착지가 실물을 바꿨다(옵션 5 → 8).
  //     ⛔ 하루 전엔 「모른다」였다 — ***쟀기 때문에 바뀐 것이지 시간이 지나서가 아니다.***
  { id: 'cli-harness-ask', surface: 'cli', status: 'live', verification: { actualMission: 'verified', legacyParity: 'verified' } },
  { id: 'cli-harness-say', surface: 'cli', status: 'live', verification: { actualMission: 'verified', legacyParity: 'verified' } },
  { id: 'cli-harness-orchestrate', surface: 'cli', status: 'live', verification: { actualMission: 'verified', legacyParity: 'unknown' } },
  // ⭐ 2026-08-24 · 🅣 — ***사람이 «돌려 보고» 적은 판정***이다(⛔ 도구가 추측한 값이 아니다).
  //   actualMission: `elanous harness plan --no-auto-merge --role-llm planning=grok "<문장>"` 로
  //     실제 골을 «끝까지» 돌렸다 — rounds=2 · autoDrive=on · draft PR #12065 · exit 0.
  //     📏 원장 각인이 그것을 말한다: `"entrance":"cli-harness-plan"` (2026-08-23T20:04:19Z · 2건).
  //     📌 산출물은 `내부 문서 `DECISION-elanous-dev-elanous-stays-dev-live-tui-lane-2026-08-24``(#12066 착지).
  //   legacyParity: ⛔ «안 쟀다» — 옛 입구(`dev --plan`)와 나란히 놓고 대조하지 않았다.
  //     ⚠️ `unknown` 은 「실패」가 아니라 「안 쟀다」다. 둘을 섞지 마라.
  { id: 'cli-harness-plan', surface: 'cli', status: 'live', verification: { actualMission: 'verified', legacyParity: 'unknown' } },
  { id: 'cli-harness-run', surface: 'cli', status: 'retired' },
  { id: 'cli-harness-dogfood', surface: 'cli', status: 'retired' },
  // ── 슬래시(TUI) ───────────────────────────────────────
  { id: 'tui-slash-ask', surface: 'slash', status: 'live', verification: { actualMission: 'verified', legacyParity: 'verified' } },
  { id: 'tui-slash-implement', surface: 'slash', status: 'retired' },
  { id: 'tui-slash-dev', surface: 'slash', status: 'live', verification: { actualMission: 'verified', legacyParity: 'unknown' } },
  // ── 자연어(툴 표면) ────────────────────────────────────
  { id: 'nl-self-implement', surface: 'nl', status: 'live', verification: { actualMission: 'verified', legacyParity: 'verified' } },
  { id: 'nl-self-orchestrate', surface: 'nl', status: 'retired' },
  { id: 'nl-solve-mission', surface: 'nl', status: 'live' },
  { id: 'nl-run-dev-harness', surface: 'nl', status: 'retired' },
  // ── 데몬/ACP ─────────────────────────────────────────
  { id: 'daemon-self-implement', surface: 'daemon', status: 'live' },
  { id: 'daemon-harness-ask', surface: 'daemon', status: 'live' },
] as const satisfies readonly EntranceDraft[];

/** Surface-level recommendations deliberately remain separate from lifecycle status.
 *
 *  ⛔⭐⭐ **CLI 표면의 권장 문은 `cli-dev-ask` 가 «아니다»** — 2026-09-12 정정.
 *  이 표가 처음 섰을 때 `cli` 칸이 `cli-dev-ask` 였고, 그래서 이 축 전체가 «반대로» 돌았다:
 *    · `harness ask` 로 들어온 사람에게 *"권장 입구: cli-dev-ask"* 라고 말했다
 *    · 정작 `dev --ask` 로 들어온 사람에게는 **아무 말도 안 했다**(자기 자신이 권장이므로)
 *  🩸 원인은 코드가 아니라 **골 문면**이다 — 그 골은 *"표면별 권장 입구를 값으로 둬라"* 라고만 했고
 *     ***「그 값이 무엇인가」를 안 적었다***. 그래서 자식이 그럴듯한 쪽을 골랐다.
 *  📌 canonical 은 `CLAUDE.md` 의 *"터미널이면 `harness say`"* 다. */
export const RECOMMENDED_ENTRANCE_ID_BY_SURFACE = {
  cli: 'cli-harness-say',
  slash: 'tui-slash-ask',
  nl: 'nl-self-implement',
  daemon: 'daemon-self-implement',
} as const satisfies Readonly<Record<EntranceSurface, EntranceId>>;

export const ENTRANCE_REGISTRY = ENTRANCE_DECLARATIONS.map(stampableEntrance) as readonly EntranceDeclaration[];

/** Returns a redirect only for a live entrance that differs from its surface's preferred destination. */
export function recommendedEntranceNotice(
  entrance: EntranceDeclaration,
  destination: EntranceDeclaration | undefined,
): string | undefined {
  if (destination === undefined || entrance.status !== 'live' || entrance.id === destination.id) return undefined;
  return `[ask] ℹ️ 권장 발사 입구: ${destination.id}`;
}

/** The native model tool that owns exposure policy for each NL entrance. */
export const NATIVE_TOOL_BY_ENTRANCE_ID: Readonly<Partial<Record<EntranceId, string>>> = {
  'nl-self-implement': 'SelfImplement',
  'nl-self-orchestrate': 'SelfOrchestrate',
  'nl-solve-mission': 'SolveMission',
};

export interface EntranceWithModelExposure extends EntranceDeclaration {
  /** Export identifier that substantiates stampability, or a distinct absence/unverified state. */
  readonly imprintEvidence: string;
  /** Source of the export-identifier evidence used to derive stampability. */
  readonly stampabilityEvidenceSource: ExportIdentifierEvidenceSource;
  /** File path that contains the export-identifier evidence when that evidence is file-backed. */
  readonly stampabilityEvidenceSourceFilePath: ExportIdentifierEvidenceSourceFilePath;
  /** Same file-path column under the entrance-list evidence vocabulary used by JSON consumers. */
  readonly evidenceSourceFilePath: ExportIdentifierEvidenceSourceFilePath;
  /** `undefined` means this entrance has no matching native-tool catalog entry. */
  readonly modelExposed: boolean | undefined;
}

/** Resolves exposure through the native tool catalog; missing entries stay distinct from false. */
export function listEntrancesWithModelExposure(
  registry: readonly EntranceDeclaration[] = ENTRANCE_REGISTRY,
): readonly EntranceWithModelExposure[] {
  return registry.map((entrance) => {
    const evidence = ENTRANCE_EXPORT_IDENTIFIER_EVIDENCE[entrance.id as EntranceId];
    const evidenceSourceFilePath = evidence?.sourceFilePath;
    const nativeToolName = NATIVE_TOOL_BY_ENTRANCE_ID[entrance.id as EntranceId];
    const nativeTool = nativeToolName === undefined ? undefined : findNativeTool(nativeToolName);
    return {
      ...entrance,
      imprintEvidence: evidence?.kind === 'present'
        ? evidence.exportedIdentifiers.join(',')
        : evidence?.kind === 'absent'
          ? 'none'
          : 'unknown',
      stampabilityEvidenceSource: evidence?.source ?? 'unverified',
      stampabilityEvidenceSourceFilePath: evidenceSourceFilePath,
      evidenceSourceFilePath,
      modelExposed: nativeTool === undefined ? undefined : isNativeToolModelExposed(nativeTool),
    };
  });
}

const byId = (id: string): EntranceDeclaration => {
  const found = ENTRANCE_REGISTRY.find((entrance) => entrance.id === id);
  // ⛔ 「없다」를 조용히 undefined 로 흘리지 않는다 — 오타가 런타임까지 살아 내려간다.
  if (found === undefined) throw new Error(`entrance-registry: 알 수 없는 입구 id — ${id}`);
  return found;
};

/** Fail-closed lookup — 등록되지 않은 id 는 레지스트리 거부 규칙을 그대로 쓴다. */
export function lookupEntrance(id: string): EntranceDeclaration {
  return byId(id);
}

export const CLI_DEV_ASK_ENTRANCE = byId('cli-dev-ask');
export const TUI_SLASH_ASK_ENTRANCE = byId('tui-slash-ask');
export const DAEMON_HARNESS_ASK_ENTRANCE = byId('daemon-harness-ask');
/** `elanous harness ask <골 문서>`: 이미 저작된 골을 «저작 없이» 파이프라인으로 보내는 입구.
 *  ⛔⭐ 이 상수가 «있어야» 각인 가능성이 `stampable` 로 파생된다 — 그리고 그 각인이
 *  「이 입구를 안 쓴다」와 「이 입구를 «못 잰다»」를 가른다(은퇴 판단의 전제 · 2026-08-22). */
export const CLI_HARNESS_ASK_ENTRANCE = byId('cli-harness-ask');
/** `elanous harness say <문장>`: 문장을 저작해 발사하는 입구. `ask` 와 «다른 계약»이다(저작을 «한다»). */
export const CLI_HARNESS_SAY_ENTRANCE = byId('cli-harness-say');
/** `elanous harness orchestrate <goal...>`: 여러 골을 CLI에서 직접 self-dev orchestrator로 보내는 발사 입구. */
export const CLI_HARNESS_ORCHESTRATE_ENTRANCE = byId('cli-harness-orchestrate');
/** `elanous harness plan <문장>`: say 저작 흐름을 재사용해 plan-staged dispatch로 보내는 발사 입구. */
export const CLI_HARNESS_PLAN_ENTRANCE = byId('cli-harness-plan');
/** `elanous harness run`: RFC-one-door-many-entrances의 실제 은퇴 CLI 입구. */
export const CLI_HARNESS_RUN_ENTRANCE = byId('cli-harness-run');
/** `elanous harness dogfood`: temp 하위 전용 헤드리스 입구 — RFC 상 은퇴. */
export const CLI_HARNESS_DOGFOOD_ENTRANCE = byId('cli-harness-dogfood');

/** 표면별 집계 — ⛔ 문서가 이 함수를 «부르게» 하고 표를 손으로 적지 않는다. */
export function summarizeEntrances(registry: readonly EntranceDeclaration[] = ENTRANCE_REGISTRY): {
  readonly total: number;
  readonly live: number;
  readonly retired: number;
  readonly closed: number;
  readonly bySurface: ReadonlyArray<{ surface: EntranceSurface; total: number; retired: number }>;
} {
  const surfaces = [...new Set(registry.map((e) => e.surface))];
  return {
    total: registry.length,
    live: registry.filter((e) => e.status === 'live').length,
    retired: registry.filter((e) => e.status === 'retired').length,
    closed: registry.filter((e) => e.status === 'closed').length,
    bySurface: surfaces.map((surface) => ({
      surface,
      total: registry.filter((e) => e.surface === surface).length,
      retired: registry.filter((e) => e.surface === surface && e.status === 'retired').length,
    })),
  };
}

/** 사람이 읽는 한 화면. ⛔ 은퇴를 «조용히» 섞지 않는다 — 그것이 2026-08-17 사고의 원인이었다. */
export function renderLaunchEntrances(registry: readonly EntranceDeclaration[] = ENTRANCE_REGISTRY): string {
  const summary = summarizeEntrances(registry);
  const rows = listEntrancesWithModelExposure(registry)
    .map((e) => `  ${e.status === 'retired' ? '🪦' : e.status === 'closed' ? '닫힘' : '✅'} ${e.surface.padEnd(7)} ${e.id} (${e.stampability}) verification=actualMission:${e.verification.actualMission},legacyParity:${e.verification.legacyParity} imprintEvidence=${e.imprintEvidence} evidenceSource=${e.stampabilityEvidenceSource} evidenceSourceFilePath=${e.evidenceSourceFilePath ?? 'missing'} modelExposed=${e.modelExposed ?? 'missing'}`);
  const surfaces = summary.bySurface
    .map((s) => `${s.surface}=${s.total}${s.retired > 0 ? `(은퇴 ${s.retired})` : ''}`)
    .join(' · ');
  return [
    `launch entrances: ${summary.total} (live ${summary.live} · retired ${summary.retired} · closed ${summary.closed})`,
    `  표면별: ${surfaces}`,
    ...rows,
  ].join('\n');
}
