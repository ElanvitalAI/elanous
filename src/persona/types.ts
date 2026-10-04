// Persona profile — light 5-tuple (Sprint 21 M2).
//
// PLAN: 내부 문서 `PLAN-discord-rich-light-persona-2026-05-01` §7.1 (단기)
// Future:  PLAN-group-chat-persona-mesh-2026-05-01.md §4 (Sprint 22 G2 full)
//
// 본 type 은 G2 풀 PersonaProfile 의 minimum subset. 추가 field
// (memoryScope · tools · reportsTo · companyId · discord
// channelAllowList · budget) 는 sprint 22+ 에 incremental 추가.
// 단기 yaml = 풀 yaml 의 subset · loader 가 누락 field 에 default
// 채움 → throw-away 0 보장.

/** Brand identifier — corresponds to LLM provider family. Mirrors
 *  agent-room/types `AgentBrand` but kept independent here so persona
 *  loading doesn't pull the whole agent-room subsystem. */
export type PersonaBrand =
  | 'claude' | 'codex' | 'gemini' | 'elanous-as-child' | 'local-llm' | 'auto';

/** Light persona profile loaded from yaml. */
export interface PersonaProfile {
  readonly personaId: string;
  readonly displayName: string;
  /** Seat address (title, id or alias) represented by this persona. */
  readonly seat?: string;
  /** Per-persona JSONL todo filename in the state persona directory. */
  readonly todo?: string;
  readonly description?: string;

  /** System prompt to prepend in LLM calls. Markdown text. May
   *  reference fragments via `{{fragment-id}}` (assembler resolves —
   *  v1 = no resolution, raw passthrough). */
  readonly systemPrompt?: string;

  /**
   * 🚧 **이 봇이 «손을 쓸 수 있는» 호스트들** — 되돌릴 수 없는 브라우저 조작의 «경계».
   *
   * ⛔⭐ 대표 이 「쓴다」를 승인했지만 ***되돌리기 장치가 «없다»***. 그리고 2026-08-28 측정이
   *    「이동만 누르면 어디로 갈지 안다」를 ***반증***했다(11건 중 8건이 다른 데 착지).
   *    ⇒ 되돌릴 수 없으면 남는 것은 «경계»이고, 우리는 ***누르기 «전»에 링크 목적지를 안다***.
   *
   * ```
   *   example.com    그 호스트 하나(www. 는 같은 것)
   *  .example.com    그 호스트 ⊕ ***하위 도메인***  ⛔ 점을 «명시»해야 열린다
   * ```
   * ⚠️ **안 적으면 «막지 않는다»** — 대신 관측이 「경계가 선언되지 않았다」고 말한다.
   *    ⛔ 기본을 거부로 두면 도는 루틴이 전부 멎는다. 먼저 «세고» 그 수를 보고 조인다.
   */
  readonly actionHosts?: readonly string[];

  /**
   * 🆕 **목적지를 «미리 못 적는» 봇의 정직한 칸** (2026-08-29 · RFC §23b-2 · 36차).
   *
   * 🚨 `newsbot` 의 「그날 첫 기사로 들어간다」는 ***`actionHosts` 로 «원리상» 못 좁힌다*** —
   *    목적지가 매일 바뀐다. 좁히면 매일 막히고, 넓히면 경계가 «사라진다».
   * ```
   *   blocked (기본)  지금까지와 «똑같다» — 목적지도 경계 안이어야 한다
   *   allowed         ***이동(<a href>)에 한해*** 목적지가 밖이어도 누른다.
   *                   ⛔ 대신 관측 verdict 가 `offsite-navigation` 으로 남아 ***셀 수 있다***
   * ```
   * ⛔⭐ **제출·버튼·「모르는 것」에는 «안 먹는다»** — 넓어지는 것은 「읽으러 나가는 것」 하나뿐이다.
   * ⚠️ 이것이 「안전」을 뜻하지 않는다 — 이동조차 부작용을 낼 수 있다(GET 으로 지우는 사이트).
   *    이 값은 ***「그 위험을 이 봇이 떠안겠다고 «적었다»」***는 기록이다.
   */
  readonly offsiteNavigation?: 'blocked' | 'allowed';

  /** Brand selection. Maps to provider in showroom lane spec. */
  readonly brand?: PersonaBrand;

  /** Model selection. */
  readonly models?: PersonaModels;

  /** Mention patterns — strings matched as case-insensitive
   *  substrings or escaped regex (when wrapped in `/.../`). Default
   *  if undefined: `['@<personaId>']`. */
  readonly mentionPatterns?: readonly string[];

  /** Discord webhook display fields. Used by webhook-persona-adapter
   *  to render the persona on Discord. */
  readonly avatarUrl?: string;
  /** Hex color (e.g., '#6d28d9'). Embed accent color. */
  readonly brandColor?: string;

  /** CDP port of the remote machine where this persona resides. */
  readonly browserPort?: number;

  /**
   * 🏠 **이 봇이 «사는» 곳** — RFC §25e `P⑤-r`.
   *
   * ⛔ 이것이 없으면 「맥이 죽으면 무엇이 남나」를 ***아무도 말할 수 없다***.
   *    📏 2026-08-28 실측: 루틴은 «맥»에서 돌고 VM 은 브라우저·화면을 준다
   *       (본체가 머리, VM 이 손). 그래서 맥이 죽으면 루틴이 «전부» 멎는다.
   */
  readonly residence?: PersonaResidence;

  /**
   * 🧰 **능력을 «두 층»으로 선언한다** — RFC §25d.
   *
   * ⛔⭐ 이 구분이 이 필드의 «전부»다:
   * ```
   *   core       그 거처에서 «혼자» 되는 것      ⇐ 다른 거처가 죽어도 돈다
   *   extended   다른 거처가 살아야 되는 것       ⇐ 죽으면 ***「못 했다」로 «크게» 실패해야 한다***
   * ```
   * ⛔ `extended` 가 «조용히 건너뛰면» 「돌았는데 안 했다」가 된다 —
   *    자격 결손이 `rc=0` · 빈 결과로 조용했던 것과 «같은 꼴»이다.
   *
   * ⚠️ **안 적으면 «막지 않는다»** — `actionHosts` 와 같은 규율이다. 대신 관측이 「선언이 없다」고 말한다.
   *    ⛔ 기본을 거부로 두면 도는 루틴이 전부 멎는다.
   */
  readonly capabilities?: PersonaCapabilities;
}

/** 거처 — 「어느 기계에 사는 봇인가」. ⛔ `browserPort` 는 «어느 화면»이고 이것은 «어느 기계»다. */
export type PersonaResidence = 'vm' | 'local';

/**
 * 능력 두 층 ⊕ ***그 값을 무엇으로 알았나***.
 *
 * ⛔⭐ `evidence` 가 이 타입의 값이다 — 「파일을 봤다」와 「돌려 봤다」는 «다른 값»이고,
 *    RFC §25c 의 표는 스스로 ***"파일을 본 것이지 돌려 본 것이 아니다"*** 라고 말한다(H6 이 그것을 잰다).
 *    ⇒ 그 차이를 지우고 적으면, 다음 창이 «추정»을 «실측»으로 읽는다.
 */
export interface PersonaCapabilities {
  /** 그 거처에서 «혼자» 되는 것. 선언했으면 비울 수 없다(빈 목록은 「없다」가 아니라 「안 적었다」로 읽힌다). */
  readonly core: readonly string[];
  /** 다른 거처가 살아야 되는 것. ⛔ 조용히 건너뛰면 안 되는 쪽이다. */
  readonly extended?: readonly string[];
  /** ⛔ 기본은 `declared` — 「돌려 보지 않았다」가 기본값이어야 안전하다. */
  readonly evidence?: PersonaCapabilityEvidence;
}

/** `declared` = 파일·설정을 보고 «적은» 것 · `measured` = 그 거처에서 «실제로 돌려» 본 것. */
export type PersonaCapabilityEvidence = 'declared' | 'measured';

export interface PersonaModels {
  readonly primary: string;
  readonly fallback?: readonly string[];
  readonly providers?: {
    readonly ollama?: { readonly model: string };
    readonly openai?: { readonly model: string };
  };
}

/** Validation error returned by loader. Thin so callers can pattern
 *  match on `.code`. */
export interface PersonaLoadError {
  readonly code:
    | 'parse'           // yaml parse failed
    | 'invalid-shape'   // missing required field or wrong type
    | 'duplicate-id'    // same personaId in 2 yaml files
    | 'io';             // fs error
  readonly path: string;        // file path
  readonly message: string;
}
