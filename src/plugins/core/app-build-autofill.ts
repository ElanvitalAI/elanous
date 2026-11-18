/**
 * ONE-LINE-INTENT-CONTEXT-AUTOFILL — plugin-layer slot filling for the built-in app_build route.
 *
 * A member types one natural line («용평 스키 강습 예약 앱 만들어줘»). The model only has to
 * choose app_build and pass that line as `ask`; this module fills the rest deterministically:
 *  - appSlug: the server-verified member app slot (never model text; a supplied slug is replaced),
 *  - handle: not an argument at all — Nexus resolves userSlug at reserve (/v1/members/owner),
 *  - data needs: simple lexical cues (database · mail · auth · seed) or explicit defaults,
 *  - runtime contract: a declared default when the model omitted or malformed it.
 * A missing member binding stays `needs_connection`; nothing is guessed. Core stays untouched.
 */
import type { ToolRuntimeContext } from '../../tool-runtime/types.js';

export const APP_BUILD_PLUGIN_ID = 'elanous-app-build';
export const APP_BUILD_TOOL_NAME = 'app_build';

// 출처: #37905 — same member app-slot shape the child runtime trusts for the ordinary app-build entry.
const MEMBER_APP_SLOT = /^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/;
const DEFAULT_ENTRY = 'backend/entry.ts';
const DEFAULT_HEALTH = '/health';
const HOST_NOTE_MARK = '[host-filled · not user text]';

const CREATE = /(만들어|만들자|만들고|만들기|생성해|생성하|구축해|구축하|개발해|개발하|제작해|제작하|\b(?:build|create|make|develop|scaffold)\b)/i;
const APP_NOUN = /(앱|어플|애플리케이션|어플리케이션|시스템|웹사이트|홈페이지|사이트|서비스|플랫폼|\b(?:apps?|application|web ?app|website|site|system|service|platform)\b)/i;
const NOT_NEW = /(기존|등록된|이미 만든|방법|어떻게|만드는 법|\b(?:existing|registered|already built|how (?:do|to|can)|what is)\b)/i;
const DATA_CUES = {
  database: /(예약|회원|게시판|재고|주문|목록|저장|기록|티켓|티케팅|신청|접수|일정|데이터베이스|\b(?:DB|database|booking|reservations?|inventory|orders?|tickets?|ticketing|records?|crud|todos?|notes?)\b)/i,
  mail: /(메일|이메일|\b(?:e-?mail|mail|newsletter)\b)/i,
  auth: /(로그인|회원 ?가입|\b(?:login|log in|sign ?in|sign ?up|accounts?)\b)/i,
  seed: /(가상 ?데이터|샘플 ?데이터|예시 ?데이터|더미|시드 ?데이터|채워 ?넣|\b(?:seed|sample data|mock data|fake data|dummy data|synthetic data|demo data)\b)/i,
} as const;

export interface AppBuildDataNeeds { database: boolean; mail: boolean; auth: boolean; seed: boolean }

export interface AppBuildFilledFields {
  intent: 'app-build';
  /** line-cue: the line itself names a new app; route-selection: the model chose app_build without cues. */
  intentSource: 'line-cue' | 'route-selection';
  appSlug: string;
  appSlugSource: 'verified-member-slot';
  /** True when the caller supplied a different appSlug that was discarded. */
  appSlugReplaced: boolean;
  handleSource: 'nexus-owner-endpoint-at-reserve';
  appName?: string;
  dataNeeds: AppBuildDataNeeds;
  seedRequested: boolean;
  runtimeSource: 'caller' | 'default';
}

export type AppBuildAutofillResult =
  | { status: 'filled'; args: Record<string, unknown>; filled: AppBuildFilledFields }
  | { status: 'needs_connection'; error: string; code: 'VERIFIED_OWNER_REQUIRED' | 'MEMBER_APP_SLOT_REQUIRED' }
  | { status: 'invalid'; error: string; code: 'APP_BUILD_ASK_REQUIRED' };

export function isAppBuildRoute(pluginId: string, toolName: string): boolean {
  return pluginId === APP_BUILD_PLUGIN_ID && toolName === APP_BUILD_TOOL_NAME;
}

/** Deterministic «new app» intent from one line. Exported for APP-BUILD-NATURAL-ROUTE-DETERMINISTIC. */
export function classifyAppBuildIntent(line: string): boolean {
  const text = line.trim();
  return !!text && CREATE.test(text) && APP_NOUN.test(text) && !NOT_NEW.test(text);
}

export function inferAppBuildDataNeeds(line: string): AppBuildDataNeeds {
  return {
    database: DATA_CUES.database.test(line), mail: DATA_CUES.mail.test(line),
    auth: DATA_CUES.auth.test(line), seed: DATA_CUES.seed.test(line),
  };
}

/** Display name only («용평 스키 강습 예약»). It never becomes the slug: Nexus binds one slot per member. */
export function appNameFromLine(line: string): string | undefined {
  const korean = /^(.+?)\s*(?:앱|어플|애플리케이션|어플리케이션|시스템|웹사이트|홈페이지|사이트|서비스|플랫폼)/.exec(line.trim());
  const english = /\b(?:build|create|make|develop|scaffold)\s+(?:me\s+)?(?:an?\s+|the\s+)?(.+?)\s+(?:web ?app|apps?|application|website|site|system|service|platform)\b/i.exec(line);
  const name = (english?.[1] ?? korean?.[1])?.replace(/[^\p{L}\p{N} -]/gu, ' ').replace(/\s+/g, ' ').trim();
  return name ? name : undefined;
}

function validRuntime(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const runtime = (value as Record<string, unknown>).runtime as Record<string, unknown> | undefined;
  const command = runtime?.startCommand;
  return !!runtime && Array.isArray(command) && command.length === 2 && command[0] === 'bun'
    && typeof command[1] === 'string' && /^backend\/[A-Za-z0-9][A-Za-z0-9._/-]*\.tsx?$/u.test(command[1]) && !command[1].includes('..')
    && typeof runtime.healthPath === 'string' && /^\/[A-Za-z0-9/_-]*$/u.test(runtime.healthPath);
}

/**
 * Fill app_build arguments from the one-line `ask` and the server-verified owner context.
 * Owner identity, slot and handle come only from `context`; tool arguments cannot supply them.
 */
export function autofillAppBuildArgs(args: Record<string, unknown>, context?: Pick<ToolRuntimeContext, 'verifiedOwner'>): AppBuildAutofillResult {
  const owner = context?.verifiedOwner;
  if (!owner?.id) return { status: 'needs_connection', code: 'VERIFIED_OWNER_REQUIRED',
    error: 'needs_connection: verified member connection required before app_build (eln member connect)' };
  if (typeof owner.appSlug !== 'string' || !MEMBER_APP_SLOT.test(owner.appSlug)) return { status: 'needs_connection',
    code: 'MEMBER_APP_SLOT_REQUIRED',
    error: 'APP_BUILD_TRUSTED_ENTRY_REQUIRED: needs_connection — verified member app slot is missing or unsafe' };
  const rawAsk = typeof args.ask === 'string' ? args.ask.trim() : '';
  if (!rawAsk) return { status: 'invalid', code: 'APP_BUILD_ASK_REQUIRED',
    error: 'app_build requires ask: pass the user one-line request verbatim' };
  const line = rawAsk.split(HOST_NOTE_MARK)[0]!.trim();
  const dataNeeds = inferAppBuildDataNeeds(line);
  const seedRequested = dataNeeds.seed || args.seedRequested === true;
  const runtimeSource = validRuntime(args.artifactMetadata) ? 'caller' as const : 'default' as const;
  const artifactMetadata = runtimeSource === 'caller' ? args.artifactMetadata
    : { runtime: { startCommand: ['bun', DEFAULT_ENTRY], healthPath: DEFAULT_HEALTH } };
  const appName = appNameFromLine(line);
  const filled: AppBuildFilledFields = {
    intent: 'app-build', intentSource: classifyAppBuildIntent(line) ? 'line-cue' : 'route-selection',
    appSlug: owner.appSlug, appSlugSource: 'verified-member-slot',
    appSlugReplaced: args.appSlug !== undefined && args.appSlug !== owner.appSlug,
    handleSource: 'nexus-owner-endpoint-at-reserve', ...(appName ? { appName } : {}),
    dataNeeds, seedRequested, runtimeSource,
  };
  // The planner reads only `ask`; give it the declared runtime and inferred data needs once, labelled as host text.
  const notes = [
    ...(runtimeSource === 'default' ? [`runtime: bun ${DEFAULT_ENTRY}, health ${DEFAULT_HEALTH}`] : []),
    ...(['database', 'mail', 'auth'] as const).some(key => dataNeeds[key])
      ? [`data needs: ${(['database', 'mail', 'auth'] as const).filter(key => dataNeeds[key]).join(', ')}`] : [],
  ];
  const ask = notes.length ? `${line}\n${HOST_NOTE_MARK} ${notes.join(' · ')}` : line;
  // Identity-shaped arguments are dropped: owner, member and handle are server-bound.
  const { appSlug: _appSlug, handle: _handle, userSlug: _userSlug, ownerId: _ownerId, memberId: _memberId,
    verifiedOwner: _verifiedOwner, ...rest } = args;
  const { memberId: _contextMember, ...callerContext } = args.context && typeof args.context === 'object'
    && !Array.isArray(args.context) ? args.context as Record<string, unknown> : {};
  return { status: 'filled', filled, args: { ...rest, ask, seedRequested, artifactMetadata, appSlug: owner.appSlug,
    context: { ...callerContext, oneLineAutofill: filled } } };
}
