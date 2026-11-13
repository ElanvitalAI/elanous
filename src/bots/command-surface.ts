import { debug } from '../debug/log.js';
import { globalTeamMailbox, type TeamMailbox } from '../agent-team/mailbox.js';
import { appendMessage, getOrCreatePersonaSession } from '../session/index.js';
import { awaitGlobalPersonaLoad, getGlobalPersonaRegistry } from '../persona/global-registry.js';
import type { PersonaProfile } from '../persona/types.js';
import type { TgSlashCommand } from '../telegram-commands.js';
import { captureBotScreen, defaultTailnetProbe, botlabHostAlias, readCrontab, readHostTzOffsetMinutes, runChartSymbol } from './screen-probe.js';
import { krTickerTable, resolveKoreanName, looksKorean } from './kr-tickers.js';
import { formatRoutines, parseBotlabCron, describeBotsayReach } from './routines.js';
import {
  formatAllScreens,
  parseScreenArgs,
  formatOneScreen,
  formatUnmeasuredHost,
  resolveTailnetHost,
  screenSlotFor,
  type TailnetProbe,
} from './screen-url.js';

export interface BotCommandArgument {
  readonly name: string;
  readonly description: string;
  readonly required: boolean;
}

/**
 * 🖼️ 표면이 «할 수 있는 것». ⛔ 표면마다 «다르다» — 그래서 전부 optional 이고,
 *    없으면 핸들러가 「이 표면은 그림을 «못 낸다»」고 ***말한다***(조용히 글로 떨어지지 «않는다»).
 */
export interface BotCommandSurface {
  /** 그림 한 장을 채팅에 «건다». 텔레그램은 `sendPhoto` 로 낸다. 불꽃놀이(fire-and-forget). */
  readonly sendImage?: (png: Buffer, opts?: { caption?: string }) => void;
}

export interface BotCommandDeclaration {
  readonly name: string;
  readonly description: string;
  readonly arguments: readonly BotCommandArgument[];
  readonly handler: (args: readonly string[], surface?: BotCommandSurface) => Promise<string>;
}

/** JSON-serializable metadata derived from a bot command declaration. */
export interface BotCommandCatalogEntry {
  readonly name: string;
  readonly description: string;
  readonly arguments: readonly BotCommandArgument[];
}

export type BotPersonaSource = () => Promise<readonly PersonaProfile[]>;

/**
 * ⛔ 표면 이름은 «닫힌 집합»이다 — 오타가 로그 계약을 조용히 깬다.
 * ⛔ PWA 는 여기 «없다» — 그 표면은 봇 명령을 아직 «안 받는다»(🅣 소유 · 인계 §3e-2).
 *    ⇒ 이 목록에 이름을 더하는 것은 「그 표면이 이 문을 지난다」는 뜻이어야 한다.
 */
export type BotCommandDispatchSurface = 'telegram' | 'discord';

/**
 * 🔭⛔⭐⭐ **표면과 무관한 디스패치 경계 — `canSendImage` 가 «일부러» 선택적이다.**
 *
 * 🔑 텔레그램은 그 능력을 «재서» 싣고, 디스코드는 «모르므로 안 싣는다».
 *    ⛔ `false` 로 접지 않는다 — 「없다」와 「안 쟀다」는 다른 값이다.
 */
interface BotCommandDispatchCommon {
  /** ⛔ 이 표면이 opts 를 주는가 — 「없다」가 사실일 때만 false 다. */
  readonly hasOpts: boolean;
  readonly handlerSurface?: BotCommandSurface;
}

/**
 * ⛔⭐⭐ **「안 쟀다」를 «타입»으로 막는다** (2026-09-02 · 43차 자기 리뷰 WATCH)
 *
 * 🚨 첫 판은 `canSendImage?: boolean` 하나였다 ⇒ ***디스코드 호출자가 그 값을 «실을 수» 있었다***.
 *    그러면 안 잰 능력이 로그에 «사실처럼» 남는다 — 이 파일이 막으려는 바로 그 꼴이다.
 * 🔑 ⇒ 규율을 «주석»이 아니라 ***갈래 타입***으로 건다:
 *    ***그 능력을 «재는» 표면만 그 필드를 «가진다».***
 * ⛔ 새 표면을 더할 때 이 union 이 「너는 그것을 쟀나」를 «강제로» 묻는다.
 */
export type BotCommandDispatchOptions =
  | (BotCommandDispatchCommon & {
      readonly surface: 'telegram';
      /** 🖼️ 텔레그램은 이 능력을 «재서» 싣는다 — `/chart` 가 사진을 보낼지 가르는 값이다. */
      readonly canSendImage: boolean;
    })
  | (BotCommandDispatchCommon & {
      readonly surface: 'discord';
      /** ⛔ 이 표면의 그림 능력은 «안 쟀다» — 그래서 이 갈래엔 그 필드가 «없다». */
      readonly canSendImage?: never;
    });

/**
 * 🔭⛔⭐⭐⭐ **이 경계에 관측이 «0건»이었다** (2026-09-01 · 42차 · 대표 제1원칙)
 *
 * 🚨 계기 — `/chart` 가 폰에서 «무응답»인데 ***이유를 아무 데서도 못 봤다***:
 * ```
 * 📏 elanous logs --since 5m --limit 400 --json --json-data | (chart|slash) 일치  ⇒ ***0건***
 * 📏 telegram 카테고리는 ***lifecycle 만*** 찍는다(bot starting · published)
 * ```
 * ⛔ 그래서 45분을 «가설과 반증»으로만 좁혔고 원인에 못 닿았다.
 * 🔑 ⇒ ***조회에 안 뜨면 관측 db 문제가 아니라 계측 누락이다.***
 *
 * ⛔ **진입 ⊕ 이탈 ⊕ 던짐을 «셋 다» 남긴다** — 진입만 남기면
 *    「들어갔는데 안 나왔다」와 「아예 안 들어갔다」를 못 가른다(그 둘은 처방이 다르다).
 *
 * 🩸🆕⭐⭐ **그런데 42차가 그것을 `botCommandsToTelegram` «안»에 심었다** (2026-09-02 · 43차 실측):
 * ```
 * 📏 디스코드는 «살아 있다» — @elanous_agent · gateway READY 9회 · 길드 등록 11개 × 7회
 * 📏 그 11 = 봇 명령 «여섯»(bots·bot·screen·chart·routines·botsay) ⊕ 다른 다섯
 * ⛔ 그런데 botCommandsToDiscord 는 command.handler 를 «직접» 불렀다
 *    ⇒ 사람이 디스코드에서 /screen 이나 /chart 를 부르면 ***그 사건이 어디에도 안 남는다***
 * ```
 * 🔑 ⇒ ***규율을 «세우는» 것과 «걸어 두는» 것은 다르다.*** 그래서 그 감싸개를 여기로 옮기고
 *    두 표면이 «둘 다» 이 문을 지나게 했다. ⊕ 어느 표면인지를 `surface` 로 «같이» 낸다.
 *
 * 🔒⛔⭐⭐ **비밀 규율 — 인자 «내용»도 예외 «메시지»도 안 남긴다** (자기 리뷰 `#15088` must-fix)
 *
 * 🩸 첫 판은 `e.message` 를 200자 실었다. 그런데 ***핸들러가 던지는 오류에는 사용자 인자가
 *    «그대로» 섞인다***(예: `「삼성전자」를 못 찾았습니다`, 파일 경로, URL).
 * 🔑 42차가 바로 위 `dispatch-enter` 에 「인자 «내용»은 안 싣는다」고 적어 놓고
 *    ***같은 함수의 다른 문으로 그것을 흘렸다.*** ⛔ 한 문을 잠그고 다른 문을 열어 두면 잠근 것이 아니다.
 * ⭐ 진단에 필요한 것은 「무엇이 던졌나」이지 「무엇이 들어 있었나」가 아니다 ⇒ 오류 «종류» ⊕ 메시지 «길이»만.
 * ⛔ 삼키지 않는다 — 남기고 «다시 던진다»(부르는 쪽의 처리를 바꾸지 않는다).
 */
export async function dispatchBotCommand(
  command: BotCommandDeclaration,
  args: readonly string[],
  options: BotCommandDispatchOptions,
): Promise<string> {
  const t0 = Date.now();
  debug.log('bots.command', 'dispatch-enter', {
    name: command.name,
    argCount: args.length,
    hasOpts: options.hasOpts,
    // ⛔ 안 잰 표면은 이 필드를 «아예 안 낸다» — `false` 로 접으면 「없다」가 된다.
    ...(options.surface === 'telegram' ? { canSendImage: options.canSendImage } : {}),
    surface: options.surface,
  });
  try {
    const out = await command.handler(args, options.handlerSurface);
    debug.log('bots.command', 'dispatch-exit', {
      name: command.name,
      ms: Date.now() - t0,
      replyChars: typeof out === 'string' ? out.length : -1,
      surface: options.surface,
    });
    return out;
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    debug.log('bots.command', 'dispatch-threw', {
      name: command.name,
      ms: Date.now() - t0,
      errorName: e instanceof Error ? e.constructor.name : typeof e,
      whyChars: raw.length,
      surface: options.surface,
    });
    throw e;
  }
}

async function globalPersonas(): Promise<readonly PersonaProfile[]> {
  await awaitGlobalPersonaLoad();
  return getGlobalPersonaRegistry().list();
}

/** ⛔⭐ 사람이 채팅에서 «답을 기다리는» 자리다 — 여기서 던지면 사용자는
 *  침묵이나 스택 트레이스를 본다. 「봇이 없다」는 잘 답했지만(2026-08-27 실측)
 *  ***「레지스트리가 던진다」는 그대로 터졌다.***
 *  ⇒ 🔑 「없다」와 「못 읽었다」를 «다른 문장»으로, 그리고 «둘 다 사람 말»로 답한다. */
type PersonaLoad =
  | { kind: 'ok'; personas: readonly PersonaProfile[] }
  | { kind: 'error'; why: string };

/**
 * 🔢 「봇 N대 중 M대가 VM 에 산다」의 «분자와 분모를 같은 술어로» 센다.
 * 🩸 3차 리뷰가 잡았다: 분자는 `residence==='vm'` «전부»를 세고 분모는 `browserPort` 있는 것만 세서
 *    ***화면 없는 페르소나가 `residence: vm` 을 달면 「4대 중 5대」가 나올 수 있었다.***
 * ⛔ 「봇」의 정의는 이 축에서 하나뿐이다 — ***거처(browserPort)를 선언한 것***(`bot.sh roster` 와 같다).
 */
export function countBotResidence(
  personas: readonly { readonly browserPort?: number; readonly residence?: string }[],
): { botsLiveOnVm: number; botsResidenceUnknown: number; botsTotal: number } {
  const bots = personas.filter((p) => p.browserPort !== undefined);
  return {
    botsLiveOnVm: bots.filter((p) => p.residence === 'vm').length,
    // ⛔ 「선언 안 함」을 「다른 데 산다」로 접지 않는다 — 봇으로 세되 «따로» 센다.
    botsResidenceUnknown: bots.filter((p) => !p.residence).length,
    botsTotal: bots.length,
  };
}

/**
 * 📈 `/chart` 인자를 «본다». 순수.
 *
 * 🚨 계기(대표 2026-09-01): *"말로 하거나 메뉴를 클릭하거나 슬래시 커맨드 하거나 «쉬운 접근»"*
 *    ⇒ 그리기 축이 «터미널에만» 있었다. 슬래시를 세우면 텔레그램 «명령 메뉴»에도 자동으로 뜬다.
 * ⛔ 모르는 낱말을 «삼키지» 않는다 — 삼키면 `/chart AAPL --shto` 가 조용히 다른 일을 한다.
 */
export interface ChartArgs {
  readonly symbol: string | null;
  readonly from: string;
  readonly botId: string | null;
  readonly unknown: readonly string[];
}

/** ⛔ 기본 기간. 「기본이 무엇인가」를 사람이 물어야 하면 그 자체가 UX 결함이므로 답에 «말한다». */
export const DEFAULT_CHART_FROM = '-2m';
/**
 * ⛔ 기본 봇은 ***예비 봇***이다 — `chart` 는 그 페이지의 문서를 «통째로 덮으므로»
 *    운영 봇(assistant·investor·newsbot) 화면을 말없이 지우면 안 된다.
 */
export const DEFAULT_CHART_BOT = 'botlab-4';

/**
 * 🏷️⭐ **티커를 «관대하게» 받는다** — 순수.
 * 🚨 계기(대표): 사람이 왜 `.US`·`.KO` 를 외워야 하나. ⇒ ***꼴을 보고 붙여 준다.***
 * ⛔ 다만 «지어내지» 않는다 — 이미 접미가 있으면 그대로 두고, 모르는 꼴이면 그대로 넘긴다
 *    (그 뒤 `omni-market` 이 「그런 심볼 없다」고 말하는 것이 «내가 틀리게 고치는 것»보다 낫다).
 */
export function normalizeTicker(raw: string): string {
  const t = raw.trim().toUpperCase();
  if (t === '') return t;
  if (t.includes('.')) return t;              // 이미 `.US` · `.KO` · `.INDX` 등
  if (/^\d{6}$/.test(t)) return `${t}.KO`;    // 한국 6자리
  if (/^[A-Z]{1,5}$/.test(t)) return `${t}.US`;
  return t;                                   // ⛔ 모르는 꼴은 «건드리지 않는다»
}

/**
 * 🗣️⭐⭐ **자연어에서 「차트 요청」을 «패턴 워드»로 집는다** — 순수. (대표 2026-09-01 지시)
 *
 * 🚨 *"말로 하거나 메뉴를 클릭하거나 슬래시 커맨드 하거나 «쉬운 접근»"* ⊕ *"어떠한 패턴 워드가 들어가야 트리거"*
 *
 * ⛔⭐ **패턴 워드 «만»으로는 안 잡는다** — 「차트 라이브러리 어떻게 넣지?」 같은 글이 오탐된다.
 *    ⇒ ***패턴 워드 ⊕ 티커가 «둘 다»*** 있어야 «슬래시로» 옮긴다. 아니면 그냥 LLM 으로 흘려보낸다.
 * 🔑 그리고 이 자는 «지시»가 아니라 «번역»이다 — 집으면 `/chart <티커>` 문자열을 낸다.
 *    ⇒ 그 뒤 판정·안내는 «슬래시 핸들러 하나»가 진다(두 자리에 같은 말을 두지 않는다).
 */
export const CHART_INTENT_WORDS = ['차트', 'chart', '캔들', 'candle', '봉차트', '주가', '시세'] as const;

/**
 * 🩸⛔ **접미 «없는» 영문 대문자 중 «티커가 아닐 가능성이 큰» 흔한 약어** (자기 리뷰 `#15030`).
 *
 * 🚨 계기: 「AI 로 차트 라이브러리 넣는 법」이 ***`/chart AI.US`*** 로 오라우팅됐다.
 * ⛔⭐ **그런데 `AI` 는 «실제 티커»다**(C3.ai). ⇒ ***차단만 하면 진짜 요청을 막는다.***
 * 🔑 그래서 «탈출구»를 같이 둔다 — `$AI` 또는 `AI.US` 로 쓰면 «확실한 신호»로 보고 잡는다.
 *    ⇒ 「모호하면 안 잡고, 사람이 «분명히» 말할 길을 준다」.
 * ⚠️ 이 목록은 ***원리상 불완전하다*** — 늘리는 것이 답이 아니라, 위 탈출구가 답이다.
 */
const COMMON_NON_TICKER_ACRONYMS: ReadonlySet<string> = new Set([
  'AI', 'API', 'ETF', 'CEO', 'CTO', 'CFO', 'UI', 'UX', 'PR', 'QA', 'LLM', 'CLI', 'SDK', 'IDE',
  'URL', 'JSON', 'HTML', 'CSS', 'SQL', 'GPU', 'CPU', 'RAM', 'SSD', 'VM', 'OS', 'PDF', 'CSV',
  'XML', 'HTTP', 'HTTPS', 'TCP', 'DNS', 'SSH', 'VPN', 'USB', 'PC', 'IT', 'OK', 'TODO', 'FAQ',
]);

/**
 * 🇰🇷 한글 후보를 뽑는다. 순수. ⛔ 「무엇이 종목인가」를 «이 자가 정하지 않는다» —
 *    후보를 넉넉히 내고 ***조회가 필터***가 된다(「보여줘」는 조회에 실패하므로 무해하다).
 */
export function koreanCandidates(text: string): readonly string[] {
  const banned = new Set(CHART_INTENT_WORDS.map((w) => w.toLowerCase()));
  return (text.match(/[가-힣A-Za-z0-9]{2,}/g) ?? [])
    .filter((w) => looksKorean(w) && !banned.has(w.toLowerCase()));
}

/**
 * ⏳⭐ **말에서 «기간»을 집는다** — 순수. (대표 「말로 하거나」의 다음 층)
 *
 * 🚨 지금까지는 기간을 바꾸려면 `--from -6m` 을 «쳐야» 했다 — 한국어로는 「6개월 차트」가 자연스럽다.
 * ⛔ 못 찾으면 `null` — 그러면 부르는 쪽이 «기본»을 쓴다. ***없는 것을 지어내지 않는다.***
 * ⛔ 그리고 이 자는 «기간»만 본다 — 「무엇을 그릴까」는 티커 축이 정한다(두 축을 섞지 않는다).
 */
/**
 * ⛔ 이 자가 «받아들이는» 최대 기간(일). 임계를 «지어낸» 것이 아니라 ***이름을 붙여 한 자리에 둔다.***
 * 🔑 근거: EOD 히스토리컬을 캔들로 보는 실용 범위 — 그 너머는 「차트로 볼 것」이 아니다.
 * ⛔ 넘으면 «거절»이 아니라 ***「기간을 못 읽었다」(null)*** — 그러면 부르는 쪽이 기본을 쓴다.
 *    (사람이 「100년 차트」라 했다고 그 요청을 «죽이지» 않는다)
 */
export const MAX_CHART_PERIOD_DAYS = 3650;

const PERIOD_DAYS: Record<string, number> = { d: 1, w: 7, m: 31, y: 366 };

export function matchChartPeriod(text: string): string | null {
  const said = String(text ?? '');
  const take = (amount: string, unit: string): string | null => {
    const days = Number(amount) * (PERIOD_DAYS[unit] ?? 0);
    return days > 0 && days <= MAX_CHART_PERIOD_DAYS ? `-${Number(amount)}${unit}` : null;
  };

  // ⓐ 이미 크론/omni-market 꼴로 말한 경우 — `-6m` · `-1y`
  const direct = /(?:^|\s)-(\d{1,3})([dwmy])(?=\s|$)/i.exec(said);
  if (direct !== null) return take(direct[1]!, direct[2]!.toLowerCase());

  // ⓑ 한국어 — 「6개월」·「3주」·「2년」·「10일」
  //    🩸⛔ ***4자리 수 + 「년」은 «달력 연도»다***(자기 리뷰 `#15059`) —
  //       「2026년 3월 차트」가 `-2026y` 가 되던 것을 막는다. ⇒ 1~3자리«만» 본다.
  const ko = /(?<!\d)(\d{1,3})\s*(일|주|개월|달|년)/.exec(said);
  if (ko !== null) {
    const unit = { 일: 'd', 주: 'w', 개월: 'm', 달: 'm', 년: 'y' }[ko[2]!]!;
    return take(ko[1]!, unit);
  }

  // ⓒ 영어 — 「6 months」·「3 weeks」
  const en = /(?<!\d)(\d{1,3})\s*(day|week|month|year)s?\b/i.exec(said);
  if (en !== null) {
    const unit = { day: 'd', week: 'w', month: 'm', year: 'y' }[en[2]!.toLowerCase()]!;
    return take(en[1]!, unit);
  }
  return null;
}

/**
 * @param resolveKr 한글 이름 → 6자리 코드. ⛔ 안 주면 한글 축을 «안 본다»(순수 시험용).
 */
/**
 * 🌏⭐⭐ **흔한 자산의 «별칭»** (2026-09-01 · 42차)
 *
 * 🚨 계기 — 차트는 ***암호화폐·지수·ETF·미국주식을 «전부» 그릴 수 있는데***
 *    「말로」는 ***한국 상장사만*** 잡혔다(DART 표만 봤으므로).
 *    📏 실측: 「비트코인/코스피/나스닥/테슬라/엔비디아 차트」 ⇒ ***전부 «안 잡힘»***.
 * 🔑 ⇒ 「능력이 없다」가 아니라 ***「부를 이름이 없다」***였다.
 *
 * ⛔⭐ **여기 적은 심볼은 «전부 실측»했다** — 지어내지 않았다(2026-09-01 · 각각 실제로 그려 봤다):
 * ```
 * ^IXIC 20봉 · ^GSPC 20봉 · ^DJI 20봉 · ^KS11 20봉
 * BTC-USD.CC 32봉 · ETH-USD.CC 32봉 · GC=F 22봉 · TSLA/NVDA/AAPL.US 21봉
 * ```
 * ⛔ **작게 유지한다** — 별칭이 틀리면 사람이 «엉뚱한 차트»를 보고 그것을 안 알아챈다.
 *    ⇒ 애매한 것(「금」 하나만 같은 짧은 말)은 «안 넣는다». 확신이 없으면 안 잡는 쪽이 낫다.
 * ⛔ 그리고 ***DART 표보다 «먼저»*** 본다 — 안 그러면 「테슬라」가 상장사 표의 엉뚱한 이름에 걸린다.
 */
export const ASSET_ALIASES: ReadonlyMap<string, string> = new Map([
  // 🪙 암호화폐
  ['비트코인', 'BTC-USD.CC'], ['비트', 'BTC-USD.CC'], ['btc', 'BTC-USD.CC'],
  ['이더리움', 'ETH-USD.CC'], ['이더', 'ETH-USD.CC'], ['eth', 'ETH-USD.CC'],
  // 📊 지수
  ['코스피', '^KS11'], ['kospi', '^KS11'],
  ['나스닥', '^IXIC'], ['nasdaq', '^IXIC'],
  ['다우', '^DJI'], ['다우존스', '^DJI'],
  ['에스앤피', '^GSPC'], ['sp500', '^GSPC'], ['snp500', '^GSPC'],
  // 🥇 원자재 — ⛔ 「금」 «한 글자»는 «안 넣는다»(현금·기금·요금… 에 걸린다)
  ['금값', 'GC=F'], ['국제금값', 'GC=F'],
  // 🇺🇸 흔한 미국 주식
  ['테슬라', 'TSLA.US'], ['엔비디아', 'NVDA.US'], ['애플', 'AAPL.US'],
  ['구글', 'GOOGL.US'], ['마이크로소프트', 'MSFT.US'], ['아마존', 'AMZN.US'],
]);

/**
 * 🌏 말 속에서 «아는 별칭»을 찾는다 — ⛔ 모르면 `null`.
 * ⛔ **부분 문자열로 잡지 않는다** — 「비트」가 「비트맵」에 걸리면 안 된다.
 *    ⇒ 한글은 «경계»가 약하므로 ***앞뒤가 한글이 «아닌» 자리***만 인정한다.
 * ⛔ 영문 별칭은 «단어 경계»로 — `btc` 가 `btcusd` 에 걸리지 않게.
 */
export function resolveAssetAlias(said: string): string | null {
  const lower = said.toLowerCase();
  // ⛔ «긴 것부터» 본다 — 「다우존스」가 「다우」에 먼저 걸리면 안 된다.
  const keys = [...ASSET_ALIASES.keys()].sort((a, b) => b.length - a.length);
  const isWordChar = (ch: string | undefined): boolean =>
    ch !== undefined && /[0-9a-z가-힣]/.test(ch);
  for (const key of keys) {
    /**
     * 🩸⛔⭐ **첫 발생만 보면 «놓친다»** (사후 자기 리뷰 `#15120` should-fix)
     *
     * 📏 실측: 「btcusd 말고 btc 차트」 ⇒ ***안 잡혔다***.
     *    `btc` 의 «첫» 발생이 `btcusd` 안이라 경계 검사에 걸려 그 키를 통째로 버렸다.
     * 🔑 ⇒ ***한 자리가 「아니다」인 것과 그 낱말이 「없다」는 다른 값이다.***
     *    ⇒ 모든 발생 자리를 본다.
     */
    for (let at = lower.indexOf(key); at >= 0; at = lower.indexOf(key, at + 1)) {
      // 🔑 앞뒤가 «같은 종류의 글자»면 그 낱말의 «일부»다 — 그 «자리»만 건너뛴다.
      if (isWordChar(lower[at - 1]) || isWordChar(lower[at + key.length])) continue;
      return ASSET_ALIASES.get(key)!;
    }
  }
  return null;
}

/**
 * 🖥️🗣️⭐⭐ **자연어의 「봇 화면 요청」을 기존 `/screen` 으로 «옮긴다»** — 순수. (대표 2026-09-01 지시)
 *
 * 🚨 *"말로 하거나 메뉴를 클릭하거나 슬래시 커맨드 하거나 이런 «쉬운 접근»이 되도록"*
 *    📏 실측 2026-09-02: 봇 명령 «여섯» 중 그 「말로」 층이 있는 것은 `chart` ***하나뿐***이었다.
 *
 * ⛔⭐ **패턴 워드 «만»으로는 안 잡는다** — `matchChartIntent` 와 «같은 규율»이다.
 *    ***패턴 워드 ⊕ 봇 이름이 «둘 다»*** 있어야 옮긴다. 아니면 그냥 LLM 으로 흘려보낸다.
 *    🔑 이유가 `chart` 보다 «무겁다» — 오탐 하나가 ***사람 폰에 사진을 보낼 수*** 있다.
 * ⛔ 봇 이름 목록을 여기 «박지 않는다» — 명부가 정본이고, 이 자는 «주입된» 해석기에 묻는다.
 * ⛔ 사진 인자(`--shot`)는 ***요청이 있을 때만*** 붙인다 — 없는 것을 지어내지 않는다.
 * 🔑 그리고 이 자는 «지시»가 아니라 «번역»이다 — 집으면 문자열만 내고, 판정·안내는 슬래시 핸들러가 진다.
 */
export const SCREEN_INTENT_WORDS = ['화면', 'screen', '스크린'] as const;
/**
 * 🩸⛔⭐⭐ **사진 낱말은 «봇 이름을 뺀 나머지»에서, ASCII 는 «낱말 경계»로 찾는다** (자기 리뷰 must-fix)
 *
 * 🚨 첫 판은 `said` 전체에서 «부분 문자열»로 찾았다. 그런데 ***봇 이름이 그 안에 있다***:
 * ```
 * 봇 이름이 `shotbot` 이면  「shotbot 화면 보여줘」 ⇒ 「/screen shotbot --shot」
 * ⇒ 사람이 사진을 «말하지 않았는데» 폰으로 사진이 간다 — 이 판의 수용 기준을 정면으로 어긴다
 * ```
 * ⇒ ⓐ 이름을 «빼고» 찾고 ⓑ ASCII 낱말은 앞뒤가 글자가 «아닐 때»만 센다.
 * ⛔ 한국어는 낱말 경계가 «없다» — 그래서 한국어 낱말은 그대로 부분 문자열로 본다(그 대신 ⓐ 가 지킨다).
 * ⛔ `screenshot` 을 «따로» 넣는다 — 경계를 걸면 그 안의 `shot` 이 «안 잡히기» 때문이다(잃지 않으려고).
 */
export const SCREEN_SHOT_WORDS = ['사진', '캡처', '찍어', '스크린샷', 'shot', 'screenshot'] as const;

/** ⛔ 봇 이름을 «뺀» 나머지에서만 사진 낱말을 센다 — 순수. */
export function saysPhoto(text: string, botWord: string): boolean {
  const rest = botWord === '' ? String(text ?? '') : String(text ?? '').replace(new RegExp(botWord, 'gi'), ' ');
  const lower = rest.toLowerCase();
  return SCREEN_SHOT_WORDS.some((word) => /^[a-z]+$/.test(word)
    // ⛔ ASCII 는 «낱말 경계» — `shotbot`·`hotshot`·`shot_bot`·`shot2` 안의 `shot` 을 사진 요청으로 세지 않는다.
    //    🩸 첫 판은 `[^a-z]` 라 ***숫자와 밑줄을 «경계»로 봤다*** — 그것은 식별자 안이지 낱말 경계가 아니다.
    ? new RegExp(`(^|[^a-z0-9_])${word}([^a-z0-9_]|$)`, 'i').test(rest)
    : lower.includes(word.toLowerCase()));
}

/**
 * 🪶⛔⭐ **«싼 앞문»** — 부르는 쪽이 「명부를 불러올까」를 이 한 줄로 정한다.
 *
 * 🚨 첫 판은 `telegram.ts` 가 ***슬래시가 아닌 «모든» 글***에 대해 명부를 불러왔다.
 *    ⛔ 그것은 채팅의 99%(화면 얘기가 «아닌» 글)에 대해 명부 레지스트리를 세우고 파일 감시를 켠다.
 * 🔑 ⇒ 낱말 목록을 «두 자리»에 적지 않으려고 그 판정을 여기서 내보낸다 — 그 목록은 여기가 정본이다.
 * ⛔ 이것은 「집었다」가 «아니다» — 봇 이름은 아직 안 봤다(그것은 `matchScreenIntent` 의 몫).
 */
export function hasScreenIntentWord(text: string): boolean {
  const lower = String(text ?? '').toLowerCase();
  return SCREEN_INTENT_WORDS.some((word) => lower.includes(word.toLowerCase()));
}

export const BOTS_INTENT_WORDS = ['봇 목록', '봇들', '무슨 봇', 'bots'] as const;
export const ROUTINES_INTENT_WORDS = ['루틴', 'routines'] as const;
const ROUTINE_LIST_WORDS = ['목록', '리스트', '뭐', '보여', '알려', '조회', '상태', 'list'] as const;
const ROUTINE_WRITE_WORDS = ['만들', '추가', '수정', '취소', '삭제', '변경', '등록', '개발', '구현', '앱', '프로그램', '코드'] as const;
export const BOT_INTENT_WORDS = ['상태', '어때', 'status'] as const;

/** Return whether a natural-language request needs the persona registry. */
export function needsPersonaRegistry(text: string): boolean {
  return hasScreenIntentWord(text) || hasIntentWord(text, BOT_INTENT_WORDS);
}

function hasIntentWord(text: string, words: readonly string[]): boolean {
  const lower = String(text ?? '').toLowerCase();
  return words.some((word) => /^[a-z]+$/.test(word)
    ? new RegExp(`(^|[^a-z0-9_])${word}([^a-z0-9_]|$)`, 'i').test(text)
    : lower.includes(word.toLowerCase()));
}

function nonSlashIntentText(text: string): string | null {
  const said = String(text ?? '').trim();
  return said === '' || said.startsWith('/') ? null : said;
}

/** Translate a read-only bot-list request without treating bot IDs as trigger words. */
export function matchBotsIntent(text: string): string | null {
  const said = nonSlashIntentText(text);
  return said !== null && hasIntentWord(said, BOTS_INTENT_WORDS) ? '/bots' : null;
}

/** Translate a read-only routine-list request. */
export function matchRoutinesIntent(text: string): string | null {
  const said = nonSlashIntentText(text);
  if (said === null || !hasIntentWord(said, ROUTINES_INTENT_WORDS)) return null;
  if (!hasIntentWord(said, ROUTINE_LIST_WORDS) || hasIntentWord(said, ROUTINE_WRITE_WORDS)) return null;
  return '/routines';
}

/** Translate an unambiguous named-bot status request through the injected bot resolver. */
export function matchBotIntent(
  text: string,
  resolveBot: (word: string) => string | null,
): string | null {
  const said = nonSlashIntentText(text);
  if (said === null) return null;

  const hits: { botId: string; word: string }[] = [];
  for (const word of said.match(/[A-Za-z0-9_-]+/g) ?? []) {
    const botId = resolveBot(word);
    if (botId !== null) hits.push({ botId, word });
  }
  // ⛔ Alias tokens still make the request ambiguous even when they resolve to one bot ID.
  if (hits.length !== 1) return null;

  const [{ botId, word }] = hits;
  const rest = said.replace(new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), ' ');
  return hasIntentWord(rest, BOT_INTENT_WORDS) ? `/bot ${botId}` : null;
}

export function matchScreenIntent(
  text: string,
  resolveBot: (word: string) => string | null,
): string | null {
  const said = String(text ?? '').trim();
  if (said === '' || said.startsWith('/')) return null; // ⛔ 슬래시는 기존 명령 파서의 몫이다
  if (!hasScreenIntentWord(said)) return null;

  // ⛔ 봇 ID를 여기 목록으로 관리하지 않는다. 말의 후보만 나누고 런타임 명부에 묻는다.
  /**
   * 🩸⛔⭐⭐ **후보가 «둘 이상»이면 거절한다** (자기 리뷰 2차 must-fix ③)
   * 🚨 첫 판은 «첫 번째»를 골랐다 — 「newsbot 말고 investor 화면 사진」 같은 글에서 ***틀린 봇***에게 간다.
   * 🔑 이 축은 되돌릴 수 없다(사진이 폰으로 간다) ⇒ ***모호하면 «안 잡고» LLM 에 맡긴다.***
   */
  const hits = new Map<string, string>();   // botId → 그 이름을 낸 «말»
  for (const word of said.match(/[A-Za-z0-9_-]+/g) ?? []) {
    const botId = resolveBot(word);
    if (botId !== null && !hits.has(botId)) hits.set(botId, word);
  }
  if (hits.size !== 1) return null;         // ⛔ 0 이면 못 집었고, 2 이상이면 «모호»하다
  const [botId, word] = [...hits.entries()][0]!;
  /**
   * 🩸⛔⭐⭐ **화면 낱말도 «이름을 뺀 나머지»에서 다시 본다** (자기 리뷰 2차 must-fix ①)
   * 🚨 봇 이름이 `screenbot` 이면 「screenbot 사진 보내」가 ***화면 요청 «없이»*** 사진을 보냈다 —
   *    이름 자체가 패턴 워드(`screen`)를 품기 때문이다. ⇒ 위 «싼 앞문»은 통과시키되 «판정»은 여기서 한다.
   */
  const rest = said.replace(new RegExp(word, 'gi'), ' ');
  if (!hasScreenIntentWord(rest)) return null;
  // ⛔ 사진 판정도 ***봇 이름을 «뺀» 나머지***에서 한다 — 이름이 `shotbot` 이어도 사진을 안 보낸다.
  return `/screen ${botId}${saysPhoto(said, word) ? ' --shot' : ''}`;
}

export function matchChartIntent(text: string, resolveKr?: (name: string) => string | null): string | null {
  const said = String(text ?? '').trim();
  if (said === '' || said.startsWith('/')) return null;   // ⛔ 슬래시는 이 자의 몫이 아니다
  const lower = said.toLowerCase();
  if (!CHART_INTENT_WORDS.some((word) => lower.includes(word.toLowerCase()))) return null;

  // ⭐ ⑴ «확실한 신호»가 붙은 것 — 접미(`AAPL.US`) · 달러 표시(`$AAPL`) · 6자리 숫자.
  //    ⇒ 사람이 «분명히» 종목을 말한 것이므로 약어 차단을 통과시킨다.
  const strong = said.match(/(?:\$[A-Za-z]{1,5}|[A-Za-z]{1,5}\.[A-Za-z]{2,4}|\b\d{6}(?:\.[A-Za-z]{2,4})?\b)/g) ?? [];
  const strongTicker = strong.map((c) => c.toUpperCase().replace(/^\$/, ''))[0];
  if (strongTicker !== undefined) return withPeriod(`/chart ${normalizeTicker(strongTicker)}`, said);

  // ⭐ ⑴b 🌏 **아는 «별칭»** — ⛔ DART 표보다 «먼저»(「테슬라」가 상장사 표에 걸리지 않게).
  //    ⊕ 영문 축보다도 먼저 — `BTC` 가 `BTC.US` 가 되는 것을 막는다.
  const alias = resolveAssetAlias(said);
  if (alias !== null) return withPeriod(`/chart ${alias}`, said);

  // ⑵ 🇰🇷 한글 이름 — ⛔ ***영문 축보다 «먼저»*** 본다.
  //    🩸 42차 실물: 「SK하이닉스 캔들」이 ***`/chart SK.US`***가 됐다 —
  //       `[A-Z]{2,5}` 가 「SK」를 «먼저» 집었기 때문이다. ⇒ 한글이 섞였으면 그쪽이 «더 확실한» 신호다.
  //    🔑 그리고 ***조회가 «성공한» 것만*** 잡으므로 오탐이 원리상 적다 —
  //       「무엇이 종목인가」를 이 자가 정하지 않고 ***표에게 묻는다***(이름표를 코드에 안 박는다).
  if (resolveKr !== undefined) {
    for (const candidate of koreanCandidates(said)) {
      const code = resolveKr(candidate);
      if (code !== null) return withPeriod(`/chart ${code}.KO`, said);
    }
  }

  // ⑶ 접미 없는 순수 대문자 — ⛔ 흔한 약어는 «안 잡는다»(오라우팅이 LLM 답을 가로챈다).
  const banned = new Set([...CHART_INTENT_WORDS].map((w) => w.toUpperCase()));
  const ticker = (said.match(/\b[A-Z]{2,5}\b/g) ?? [])
    .find((c) => !banned.has(c) && !COMMON_NON_TICKER_ACRONYMS.has(c));
  if (ticker !== undefined) return withPeriod(`/chart ${normalizeTicker(ticker)}`, said);
  return null;
}

/** ⛔ 기간이 «있을 때만» 붙인다 — 없으면 슬래시 핸들러가 기본을 쓴다(한 자리에서 정한다). */
function withPeriod(slash: string, said: string): string {
  const period = matchChartPeriod(said);
  return period === null ? slash : `${slash} --from ${period}`;
}

/**
 * 🇰🇷 실제 표를 읽어 조회한다. ⛔ 표를 «못 읽으면» 조용히 null — 그때는 한글 축이 «없는 것처럼» 돈다
 *    (영문·숫자 축은 그대로 산다). 🔑 한 축의 부재가 다른 축을 죽이지 않는다.
 */
export function defaultKoreanResolver(name: string): string | null {
  const loaded = krTickerTable();   // ⛔ 프로세스 기억을 쓴다 — 후보가 여럿이어도 «한 번»만 읽는다
  return loaded.ok ? resolveKoreanName(name, loaded.table) : null;
}

/**
 * 🗣️ 표를 «왜 못 읽었나» — ⛔ 그 이유를 «버리지» 않는다(자기 리뷰 `#15052`).
 * 🚨 안 그러면 `CORPCODE.xml` 이 없는 기계에서 사람이 「정확한 이름을 쓰라」는 말만 듣고
 *    ***영영 「이름 자체를 못 읽는다」는 사실을 모른다.***
 */
export function koreanTableProblem(): string | null {
  const loaded = krTickerTable();
  return loaded.ok ? null : loaded.reason;
}

export function parseChartArgs(args: readonly string[]): ChartArgs {
  let symbol: string | null = null;
  let from = DEFAULT_CHART_FROM;
  let botId: string | null = null;
  const unknown: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i] ?? '').trim();
    if (arg === '') continue;
    if (arg === '--from' || arg === '--bot') {
      const value = String(args[i + 1] ?? '').trim();
      // ⛔ 값이 «없으면» 조용히 기본으로 돌아가지 않는다 — 사람이 준 것을 잃었다고 말한다.
      if (value === '' || value.startsWith('--')) { unknown.push(`${arg}(값 없음)`); continue; }
      if (arg === '--from') from = value; else botId = value;
      i += 1;
      continue;
    }
    if (arg.startsWith('--')) { unknown.push(arg); continue; }
    if (symbol === null) symbol = normalizeTicker(arg);
    else unknown.push(arg);
  }
  return { symbol, from, botId, unknown };
}

/**
 * 🕐 «보는 사람»의 시간대. ⛔ `KST` 를 박지 않는다 — 이 데몬이 딴 데서 돌 수 있다.
 *    ⚠️ `Intl` 이 약칭 대신 `GMT+9` 를 내는 판이 있어 그것도 그대로 쓴다(짧고 틀리지 않다).
 */
export function viewerZone(now: Date = new Date()): { viewerOffsetMinutes: number; viewerLabel: string } {
  // ⛔ JS 의 getTimezoneOffset 은 «부호가 반대»다(KST 가 -540).
  const viewerOffsetMinutes = -now.getTimezoneOffset();
  let viewerLabel = '';
  try {
    // ⛔ 로케일을 «박지» 않는다 — 이 데몬이 딴 데서 돌 수 있다. 시스템 로케일에 맡긴다.
    //    📏 실측(2026-09-01 · bun 1.3.12 · 이 맥): 시스템 로케일도 `KST` 가 아니라 ***`GMT+9`***를 냈다
    //       (ICU 데이터에 달렸다). ⛔ 그래서 「KST 가 나온다」고 «적지 않는다» — 짧고 틀리지 않으면 족하다.
    viewerLabel = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' })
      .formatToParts(now).find((part) => part.type === 'timeZoneName')?.value ?? '';
  } catch {
    viewerLabel = '';
  }
  if (viewerLabel === '') {
    const sign = viewerOffsetMinutes < 0 ? '-' : '+';
    const abs = Math.abs(viewerOffsetMinutes);
    viewerLabel = `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  }
  return { viewerOffsetMinutes, viewerLabel };
}

function createBotCommandDeclarations(
  personasFor: BotPersonaSource,
  mailbox: Pick<TeamMailbox, 'send'> = globalTeamMailbox,
  screenProbe: TailnetProbe = defaultTailnetProbe,
  screenAlias: string = botlabHostAlias(),
  screenCapture: typeof captureBotScreen = captureBotScreen,
  crontabReader: typeof readCrontab = readCrontab,
  // 🕐 그 기계의 UTC 오프셋. ⛔ crontab 은 «그 기계 시간대»로 해석된다 — 안 물으면 두 기계가 같아 보인다.
  tzReader: typeof readHostTzOffsetMinutes = readHostTzOffsetMinutes,
  // 📈 차트 사슬. ⛔ 시험이 실제 브라우저를 «안 건드리게» 주입 가능해야 한다.
  chartRunner: typeof runChartSymbol = runChartSymbol,
  // 🇰🇷 한글 이름 → 코드. ⛔ 시험이 29MB XML 을 «안 읽게» 주입 가능해야 한다.
  krResolver: (name: string) => string | null = defaultKoreanResolver,
  /** 🗣️ 표를 «왜 못 읽었나». ⛔ 「이름을 못 찾았다」와 갈라 말하기 위해 필요하다. */
  tableProblem: () => string | null = koreanTableProblem,
  getPersonaSession: typeof getOrCreatePersonaSession = getOrCreatePersonaSession,
  persistPersonaMessage: typeof appendMessage = appendMessage,
): readonly BotCommandDeclaration[] {
  const loadedPersonas = (): Promise<readonly PersonaProfile[]> => personasFor();
  const tryLoadPersonas = async (): Promise<PersonaLoad> => {
    try {
      return { kind: 'ok', personas: await loadedPersonas() };
    } catch (e) {
      return { kind: 'error', why: e instanceof Error ? e.message : String(e) };
    }
  };
  /** ⛔ 「봇이 없다」로 접지 않는다 — 처방이 다르다(사람이 봇을 만들 일이 아니라 레지스트리를 볼 일이다). */
  const loadFailureText = (why: string): string =>
    `봇 목록을 읽지 못했습니다 — 「봇이 없다」가 아니라 확인이 안 된 상태입니다: ${why.slice(0, 160)}`;

  async function botsHandler(): Promise<string> {
  const load = await tryLoadPersonas();
  if (load.kind === 'error') return loadFailureText(load.why);
  const personas = load.personas;
  if (personas.length === 0) return '봇이 없습니다.';
  return [
    `🤖 봇 ${personas.length}개`,
    ...personas.map((persona) => `• ${persona.personaId} — ${persona.displayName} · 🟢 살아있음`),
  ].join('\n');
}

async function botHandler(args: readonly string[]): Promise<string> {
  const load = await tryLoadPersonas();
  if (load.kind === 'error') return loadFailureText(load.why);
  const personas = load.personas;
  if (personas.length === 0) return '봇이 없습니다.';
  const id = args[0]?.trim();
  const persona = id ? personas.find((candidate) => candidate.personaId === id) : undefined;
  if (!persona) {
    return `⚠️ 봇 '${id ?? ''}'을 찾을 수 없습니다. 있는 봇: ${personas.map((candidate) => `${candidate.personaId} (${candidate.displayName})`).join(', ')}`;
  }
  return `🤖 ${persona.personaId} — ${persona.displayName} · 🟢 살아있음`;
}

async function botsayHandler(args: readonly string[]): Promise<string> {
  const load = await tryLoadPersonas();
  if (load.kind === 'error') return loadFailureText(load.why);
  const personas = load.personas;
  if (personas.length === 0) return '봇이 없습니다.';
  const id = args[0]?.trim();
  const message = args.slice(1).join(' ').trim();
  const persona = id ? personas.find((candidate) => candidate.personaId === id) : undefined;
  if (!persona) {
    return `⚠️ 봇 '${id ?? ''}'을 찾을 수 없습니다. 있는 봇: ${personas.map((candidate) => `${candidate.personaId} (${candidate.displayName})`).join(', ')}`;
  }
  if (!message) return `⚠️ ${persona.displayName}에게 남길 말을 입력하세요.`;
  try {
    const receipt = mailbox.send({
      team: 'botlab',
      to: persona.personaId,
      from: 'user',
      body: message,
    });
    // 📬⛔ 「접수했다」로 끝내지 «않는다» — `D2` 뒤로 그 봇이 «다른 기계»에서 돌 수 있고,
    //    그러면 이 말은 여기 담겼을 뿐 «안 읽힌다»(2026-09-01 에 실제로 그랬다).
    //    ⛔ ssh 는 쓰지 않는다 — 사람이 채팅에서 «기다리는» 자리다(로컬 크론 하나면 갈린다).
    let persistenceWarning = '';
    try {
      const session = getPersonaSession(persona.personaId, { source: 'cli' });
      persistPersonaMessage(session.id, {
        role: 'user',
        content: message,
        ts: new Date().toISOString(),
      });
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      persistenceWarning = `\n⚠️ 상주 대화 기록 실패: ${why.slice(0, 160)}`;
    }
    const reach = describeBotsayReach({ personaId: persona.personaId, localCrontab: await crontabReader(null) });
    return `✅ ${persona.displayName} (${persona.personaId})에게 메시지를 접수했습니다. 확인 id: ${receipt.id}${reach}${persistenceWarning}`;
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return `⚠️ ${persona.displayName} (${persona.personaId})에게 메시지를 남기지 못했습니다: ${why.slice(0, 160)}`;
  }
}

/**
 * 🖥️ 봇 «화면»에 채팅에서 닿는다 — ⛔ 「새 화면을 만든다」가 아니라 ***이미 있는 주소를 «말한다»***.
 * ⛔ 비번은 «싣지 않는다»(bot-wall.html R2) · 기본은 «보기 전용»이다.
 */
async function screenHandler(args: readonly string[], surface?: BotCommandSurface): Promise<string> {
  const parsed = parseScreenArgs(args);
  // ⛔ 모르는 낱말을 «삼키지» 않는다 — 삼키면 `/screen --shto` 가 조용히 「전부 보기」가 된다.
  if (parsed.unknown.length > 0) {
    return `⚠️ 모르는 인자: ${parsed.unknown.join(' ')} — 쓰는 법: \`/screen [봇] [--shot]\``;
  }
  const load = await tryLoadPersonas();
  if (load.kind === 'error') return loadFailureText(load.why);
  const personas = load.personas;
  if (personas.length === 0) return '봇이 없습니다.';
  const id = parsed.botId;
  // ⛔ 「봇을 못 찾았다」를 «바깥에 묻기 전»에 답한다 — 못 찾을 것을 위해 ssh·tailscale 을 부르지 않는다.
  const persona = id ? personas.find((candidate) => candidate.personaId === id) : undefined;
  if (id && !persona) {
    return `⚠️ 봇 '${id}'을 찾을 수 없습니다. 있는 봇: ${personas.map((candidate) => candidate.personaId).join(', ')}`;
  }
  if (parsed.shot) return screenShot(persona, surface);
  const host = await resolveTailnetHost(screenAlias, screenProbe);
  if (host.kind === 'unmeasured') return formatUnmeasuredHost(host, screenAlias);
  return persona
    ? formatOneScreen(host.host, screenSlotFor(persona))
    : formatAllScreens(host.host, personas.map(screenSlotFor));
}

/**
 * 🖼️ `--shot` — ⛔ 「지금 화면」 한 장. 비번도 VNC 클라이언트도 «필요 없다».
 * ⛔ 화면은 «흐른다» — 그래서 이 답은 「그때 그 순간」이고, 계속 보려면 벽(`/screen <봇>`)이다.
 */
async function screenShot(
  persona: PersonaProfile | undefined,
  surface?: BotCommandSurface,
): Promise<string> {
  if (!persona) return '⚠️ `--shot` 은 봇을 «하나» 정해야 합니다 — 예: `/screen newsbot --shot`';
  const slot = screenSlotFor(persona);
  if (slot.kind === 'no-screen') {
    return `🖼️ ${slot.label} (${slot.personaId}) — 찍을 화면을 «못 정한다»: ${slot.why}`;
  }
  // ⛔ 「이 표면이 그림을 못 낸다」와 「화면이 없다」는 «다른 값»이다 — 그렇게 말하고 길을 준다.
  if (!surface?.sendImage) {
    return `🖼️ 이 표면은 그림을 «못 냅니다» — 대신 벽으로 보세요: \`/screen ${slot.personaId}\``;
  }
  const shot = await screenCapture(slot.botNumber);
  if (shot.kind === 'failed') {
    return `🖼️ ${slot.label} (${slot.personaId}) 화면을 «못 찍었다»: ${shot.why}`;
  }
  const caption = `🖼️ ${slot.label} (${slot.personaId}) — 화면 :${slot.botNumber} · ${new Date().toISOString()}`;
  try {
    const handed: unknown = surface.sendImage(shot.png, { caption });
    // ⛔⭐ 관의 계약은 «불꽃놀이»(void)다 — 그런데 «약속을 돌려주는» 관을 만나면 그 거부가
    //    unhandled rejection 으로 «샌다». 계약을 안 바꾸고도 그 새는 것만 막는다.
    if (handed && typeof (handed as Promise<void>).catch === 'function') {
      void (handed as Promise<void>).catch(() => undefined);
    }
  } catch (e) {
    // ⛔ 관이 «그 자리에서» 터지면 그것은 내가 «아는» 실패다 — 그때는 단정하지 말고 그대로 말한다.
    const why = e instanceof Error ? e.message : String(e);
    return `🖼️ ${slot.label} — 화면은 찍었는데 관이 «거부했다»: ${why.slice(0, 200)}`;
  }
  // ⛔⭐ 「보냈습니다」라고 쓰지 «않는다» — 이 관은 설계상 불꽃놀이라 ***전송 성패를 여기서 못 안다***.
  //    ⇒ 그래서 ⑴ 내가 «한 일»만 말하고 ⑵ ***사람이 그 실패를 «스스로 알아볼» 길***을 같이 준다.
  //       (「사진이 안 보이면 실패한 것」 — 이 한 줄이 없으면 사람은 «안 온 사진»을 기다린다)
  return [
    `🖼️ ${slot.label} — 화면 :${slot.botNumber} 한 장(${shot.png.length.toLocaleString()}바이트)을 위로 올렸습니다.`,
    `⚠️ 사진이 «안 보이면» 전송이 실패한 것입니다 — 이 답은 그 성패를 «모릅니다».`,
    `계속 보려면 \`/screen ${slot.personaId}\``,
  ].join('\n')
}

/**
 * 📈 `/chart <티커>` — ***종목 하나를 봇 화면에 «그림으로» 그리고 그 사진을 여기로.***
 * ⛔ 새 로직을 «안 만든다» — `chart-symbol.ts`(사슬) ⊕ `screenShot`(41차의 사진 관)을 «잇기만» 한다.
 * ⚠️ 이 명령은 그 봇 페이지의 문서를 «덮는다» ⇒ 기본을 «예비 봇»으로 두고 그 사실을 말한다.
 */
async function chartHandler(args: readonly string[], surface?: BotCommandSurface): Promise<string> {
  // 🔭 ⛔ 어댑터 계측과 «짝»이다 — 여기 없으면 「어댑터는 들어갔는데 여기 왔나」를 못 가른다.
  debug.log('bots.chart', 'enter', { argCount: args.length, hasSurface: surface !== undefined });
  let parsed = parseChartArgs(args);
  if (parsed.unknown.length > 0) {
    return `⚠️ 모르는 인자: ${parsed.unknown.join(' ')} — 쓰는 법: \`/chart <티커> [--from -2m] [--bot <봇>]\``;
  }
  // 🇰🇷 한글로 준 이름이면 코드로 바꾼다 — ⛔ 못 찾으면 «길을 주고» 멈춘다.
  if (parsed.symbol !== null && looksKorean(parsed.symbol)) {
    const code = krResolver(parsed.symbol);
    if (code === null) {
      // ⛔ 「이름을 못 찾았다」와 「표 자체를 못 읽었다」는 «다른 답»이다 — 처방이 다르다.
      const problem = tableProblem();
      if (problem !== null) {
        return [`⚠️ 한글 이름을 «읽을 수 없습니다» — ${problem}`,
          '   ⇒ 그동안은 코드로 쓰십시오: `/chart 005930`'].join('\n');
      }
      return [`⚠️ 「${parsed.symbol}」를 «못 찾았습니다» — 정확한 상장사 이름이어야 합니다(부분 일치는 안 합니다).`,
        '   예: `/chart 삼성전자` · `/chart SK하이닉스` · 또는 코드로 `/chart 005930`'].join('\n');
    }
    parsed = { ...parsed, symbol: `${code}.KO` };
  }
  if (parsed.symbol === null) {
    return ['⚠️ 티커가 없습니다 — 예: `/chart AAPL`',
      '   ⭐ 접미는 «안 붙여도» 됩니다 — `AAPL`→`AAPL.US` · `005930`→`005930.KO` 로 읽습니다.',
      '   말로도 됩니다: 「AAPL 차트 보여줘」 · 「삼성전자 6개월 차트」',
      '   🌏 아는 이름: 비트코인 · 이더리움 · 코스피 · 나스닥 · 다우 · 금값 · 테슬라 · 엔비디아 · 애플 …',
      '   📈 지수·암호화폐·ETF 도 됩니다: `^KS11` · `^IXIC` · `BTC-USD.CC` · `QQQ.US`',
      '   ⚠️ `AI`·`API` 같은 흔한 약어는 «일부러» 안 잡습니다 — 그 종목이면 `$AI` 나 `AI.US` 로 적어 주세요.'].join('\n');
  }
  const load = await tryLoadPersonas();
  if (load.kind === 'error') return loadFailureText(load.why);
  // ⛔⭐ **「비었다」와 「그 봇이 없다」는 «다른 답»이다** — 전수 스위트가 잡았다(42차).
  //    🩸 옛 판은 빈 명부에서 「봇 'botlab-4'을 찾을 수 없습니다. 있는 봇: 」라고 답했다 —
  //       ***있는 봇 목록이 비어 있는데도*** 「그 이름이 문제」인 것처럼 말한 것이다.
  //    🔑 이 표면의 다른 명령들이 지키는 계약이고(`screenHandler` 와 같은 꼴), 그 계약을 시험이 «전수로» 문다.
  if (load.personas.length === 0) return '봇이 없습니다.';
  const wantId = parsed.botId ?? DEFAULT_CHART_BOT;
  const persona = load.personas.find((p) => p.personaId === wantId);
  if (!persona) {
    return `⚠️ 봇 '${wantId}'을 찾을 수 없습니다. 있는 봇: ${load.personas.map((p) => p.personaId).join(', ')}`;
  }
  const slot = screenSlotFor(persona);
  if (slot.kind === 'no-screen') {
    return `📈 ${slot.label} (${slot.personaId}) — 그릴 화면을 «못 정한다»: ${slot.why}`;
  }
  // ⛔ 봇 CDP 포트는 화면 번호에서 «파생»된다(페르소나가 그렇게 낳는다).
  const port = persona.browserPort ?? 9400 + slot.botNumber;
  const drawn = await chartRunner({ symbol: parsed.symbol, port, from: parsed.from, id: `chat-${parsed.symbol}` });
  if (drawn.kind === 'failed') {
    return [`📈 ${parsed.symbol} 을 «못 그렸다»: ${drawn.why}`,
      '   ⚠️ 티커 꼴을 확인하세요 — 미국 `.US` · 한국 `.KO`'].join('\n');
  }
  // ⭐ 그리고 «사진»으로 — 41차가 세운 그 관을 그대로 쓴다(재발명 0).
  const shot = await screenShot(persona, surface);
  return [`📈 ${parsed.symbol} · ${parsed.from} — ${slot.personaId} 화면에 그렸습니다.`, shot].join('\n');
}

/**
 * ⏰ `/routines` — 「무엇이 언제 · «어느 기계»에서 도나」.
 * ⭐ 목록이 목적이 아니다 — ***「맥이 «꺼져도» 도나」를 «보이게»*** 하는 것이 목적이다.
 */
async function routinesHandler(): Promise<string> {
  const load = await tryLoadPersonas();
  // ⛔ 페르소나를 못 읽어도 «일정»은 답할 수 있다 — 「사는 곳」 줄만 못 낸다. 그 사실을 말한다.
  const personas = load.kind === 'ok' ? load.personas : [];
  // ⛔ 두 crontab 을 «나란히» 묻는다 — 한쪽이 죽어도 다른 쪽 답은 낸다.
  // ⛔ 넷을 «나란히» 묻는다 — 한쪽이 죽어도 다른 쪽 답은 낸다(시간대를 못 물어도 목록은 낸다).
  const [mac, vm, macTz, vmTz] = await Promise.all([
    crontabReader(null), crontabReader(screenAlias), tzReader(null), tzReader(screenAlias),
  ]);
  const viewer = viewerZone();
  const text = formatRoutines({
    mac: parseBotlabCron(mac, { hostOffsetMinutes: macTz, ...viewer }),
    vm: parseBotlabCron(vm, { hostOffsetMinutes: vmTz, ...viewer }),
    ...countBotResidence(personas),
    vmAlias: screenAlias,
    macOffsetMinutes: macTz,
    vmOffsetMinutes: vmTz,
    ...viewer,
  });
  return load.kind === 'error'
    // ⛔ 같은 «가족»의 낱말을 쓴다 — 표면마다 다른 말로 같은 실패를 내면 사람이 둘로 배운다.
    ? `${text}\n⚠️ 봇 명부를 읽지 못했습니다 — 「사는 곳」 수는 0으로 «보일 뿐»입니다: ${load.why.slice(0, 120)}`
    : text;
}

  return [
  {
    name: 'bots',
    description: 'List available bots and their status',
    arguments: [],
    handler: botsHandler,
  },
  {
    name: 'bot',
    description: 'Show one bot status',
    arguments: [{ name: 'id', description: 'Bot id', required: true }],
    handler: botHandler,
  },
  {
    name: 'screen',
    description: 'Bot screen: wall URL (view-only, no VNC password) or --shot for a live picture',
    arguments: [
      { name: 'id', description: 'Bot id (omit for all bots on one wall)', required: false },
      { name: 'shot', description: 'Pass --shot for a picture of that bot screen right now', required: false },
    ],
    handler: screenHandler,
  },
  {
    name: 'chart',
    description: 'Draw a stock chart (candles + trend + high/low) on a bot screen and send the picture',
    arguments: [
      { name: 'symbol', description: 'Ticker — US: AAPL.US · KR: 005930.KO', required: true },
      { name: 'from', description: 'Period start, e.g. -2m (default -2m)', required: false },
      { name: 'bot', description: 'Which bot screen (default: spare bot)', required: false },
    ],
    handler: chartHandler,
  },
  {
    name: 'routines',
    description: 'What runs when, and on which machine (Mac vs VM)',
    arguments: [],
    handler: routinesHandler,
  },
  {
    name: 'botsay',
    description: 'Leave a message for a bot',
    arguments: [
      { name: 'id', description: 'Bot id', required: true },
      { name: 'message', description: 'Message for the bot', required: true },
    ],
    handler: botsayHandler,
  },
];
}

export const botCommandDeclarations = createBotCommandDeclarations(globalPersonas);

export type BotCommandRequestResolution =
  | { readonly ok: true; readonly command: BotCommandDeclaration }
  | {
      readonly ok: false;
      readonly reason: 'unknown-command' | 'irreversible-command' | 'irreversible-argument';
      readonly detail: string;
    };

/** Resolve a request at the command boundary before a surface can dispatch it. */
export function resolveBotCommandRequest(
  request: { readonly name: string; readonly args: readonly string[]; readonly allowIrreversible?: boolean },
  declarations: readonly BotCommandDeclaration[] = botCommandDeclarations,
): BotCommandRequestResolution {
  const command = declarations.find((candidate) => candidate.name === request.name);
  if (command === undefined) {
    return { ok: false, reason: 'unknown-command', detail: 'Requested command is not declared.' };
  }
  if (request.allowIrreversible !== true && command.name === 'botsay') {
    return { ok: false, reason: 'irreversible-command', detail: 'Command botsay requires irreversible access.' };
  }
  if (request.allowIrreversible !== true && request.args.includes('--shot')) {
    return { ok: false, reason: 'irreversible-argument', detail: 'Argument --shot requires irreversible access.' };
  }
  return { ok: true, command };
}

/** Derive JSON-serializable command metadata without exposing executable handlers. */
export function botCommandCatalog(
  declarations: readonly BotCommandDeclaration[] = botCommandDeclarations,
): readonly BotCommandCatalogEntry[] {
  return declarations.map((command) => ({
    name: command.name,
    description: command.description,
    arguments: command.arguments.map((argument) => ({
      name: argument.name,
      description: argument.description,
      required: argument.required,
    })),
  }));
}

/** Test seam; production commands always use the global persona registry and mailbox. */
export function createBotCommandDeclarationsForTest(
  personasFor: BotPersonaSource,
  mailbox: Pick<TeamMailbox, 'send'> = globalTeamMailbox,
  screenProbe: TailnetProbe = defaultTailnetProbe,
  screenAlias: string = botlabHostAlias(),
  screenCapture: typeof captureBotScreen = captureBotScreen,
  crontabReader: typeof readCrontab = readCrontab,
  tzReader: typeof readHostTzOffsetMinutes = readHostTzOffsetMinutes,
  chartRunner: typeof runChartSymbol = runChartSymbol,
  krResolver: (name: string) => string | null = defaultKoreanResolver,
  tableProblem: () => string | null = koreanTableProblem,
  getPersonaSession: typeof getOrCreatePersonaSession = getOrCreatePersonaSession,
  persistPersonaMessage: typeof appendMessage = appendMessage,
): readonly BotCommandDeclaration[] {
  return createBotCommandDeclarations(personasFor, mailbox, screenProbe, screenAlias, screenCapture, crontabReader, tzReader, chartRunner, krResolver, tableProblem, getPersonaSession, persistPersonaMessage);
}

/** Convert the surface-neutral declarations for Telegram registration and dispatch. */
export function botCommandsToTelegram(
  declarations: readonly BotCommandDeclaration[] = botCommandDeclarations,
): TgSlashCommand[] {
  return declarations.map((command) => ({
    name: command.name,
    description: command.description,
    handler: async (args, _ctx, opts) => dispatchBotCommand(command, args, {
      surface: 'telegram',
      hasOpts: opts !== undefined && opts !== null,
      canSendImage: opts?.fileSink?.sendImage !== undefined,
      // ⛔ 함수를 «뽑아서» 넘기지 않는다 — 구현이 `this` 에 기대면 그 자리에서 깨진다.
      handlerSurface: opts?.fileSink?.sendImage
        ? { sendImage: (png, imageOpts) => opts.fileSink!.sendImage!(png, imageOpts) }
        : {},
    }),
  }));
}
