// WEBCHAT-APP-BUILD-PLUGIN-BRIDGE — graph plugin(elanous-app-build: app_build_plan · app_build)를
// 공용 앱 tool 조립기에 결속한다. 실행 슬라이스(OP #96590): «앱 만들어줘» 한 줄이 시작 신호에서
// 그치지 않고 plugin.json handler(graph:app-build · graph:app-build-plan)의 실제 실행에 닿는다.
//
// 재사용 최우선 — 그래프 러너(runGraph)·게시 승인 레지스트리·HITL 확인 경로는 이미 서버측 실행 기계
// (daemon dispatchDaemonPluginRoute → route adapter → child-plugin-runtime 기본 dispatchGraph)에 있다.
// 이 브리지는 그 기계를 (1) 서버가 context 로 결속한 appBuildRouteDispatch(daemon 배선 — 도구 인자로는
// 절대 주입되지 않는다) 또는 (2) 주입된 deps.dispatchGraph(시험·향후 호스트)로 호출할 뿐, 두 번째
// 실행 기계를 만들지 않는다. 실행기가 없으면 started 를 위조하지 않고 fail-closed 로 알린다.
//
// 게이트 계약(실측 11-19 그대로): 회원 연결이 없으면 published 가 아니라 needs_connection 명시 상태
// (error «needs_connection: …» · code VERIFIED_OWNER_REQUIRED — app-build-autofill.ts 와 같은 출처).
// published 는 완료된 그래프가 명시적으로 준 publicUrl 로만 — 확인 경로 없이는 자동 공개 0(위조 금지).
// app_build_plan 은 계획만 낸다(planned, 공개 없음).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { LLMToolSpec } from '../llm/tool-spec.js';
import { parsePluginManifest } from '../plugins/core/manifest.js';
import { withCapabilityDiscoveryDescription } from '../plugins/core/capability-discovery.js';
import { autofillAppBuildArgs, isAppBuildRoute } from '../plugins/core/app-build-autofill.js';
import { isAppBuildDeclined } from '../plugins/core/app-build-decline-guard.js';
import { requestConfirmation as confirmOnChannels } from '../hitl/confirm.js';
import type { ToolRuntimeContext } from '../tool-runtime/types.js';

const manifestPath = resolve(import.meta.dir, '../../plugins/elanous-app-build/plugin.json');
const pluginRoot = resolve(import.meta.dir, '../../plugins');

/** app-build plugin id — decline-guard(APP-BUILD-DECLINE-NO-BYPASS)와 같은 출처. */
export const APP_BUILD_PLUGIN_ID = 'elanous-app-build';

/** Manifest·route 결속은 app-deploy-plugin.ts 와 동일 패턴 — TUI route-adapter(graph:)와 같은 계약. */
export function appBuildPluginSpecs(): LLMToolSpec[] {
  const manifest = parsePluginManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
  if (manifest.id !== APP_BUILD_PLUGIN_ID) throw new Error('app build plugin manifest is missing');
  const tools = (manifest.contributes.aiTools ?? []).filter(item => item.name === 'app_build' || item.name === 'app_build_plan');
  return tools.map(tool => {
    if (!tool?.route) throw new Error('app build plugin route is missing');
    return {
      name: tool.name,
      description: withCapabilityDiscoveryDescription(tool.description, manifest),
      parameters: tool.parameters ?? { type: 'object', properties: {} },
      pluginId: manifest.id,
      route: tool.route,
    };
  });
}

export type AppBuildOutput = {
  kind: 'app-build';
  tool: 'app_build' | 'app_build_plan';
  /** published = 그래프 완료 + 확인된 공개(publicUrl 필수). planned = app_build_plan 계획 완료(공개 없음).
   *  needs_connection = 멤버 게이트(회원 연결·슬롯 없음 — 원문 code 보존). awaiting-approval = 승인 보류
   *  (세션-생존/재개 기계 없이 정직한 홀드 상태). rejected = 확인 거절·인자·원점 거부. failed = 실행 실패
   *  (실행기 부재 포함). started 는 이제 없다 — 실행 없이 «시작됨»을 위조하지 않는다. */
  status: 'planned' | 'published' | 'needs_connection' | 'awaiting-approval' | 'rejected' | 'failed';
  pluginId: string;
  graphId?: string;
  buildComplete: boolean;
  publicUrl?: string;
  code?: string;
  needsConnection?: boolean;
  approvalHold?: string;
  error?: string;
};

/** 시험·호스트 주입 실행기 — route adapter 의 dispatchGraph seam 과 같은 서명(재사용). */
export interface AppBuildDeps {
  dispatchGraph?: (pluginId: string, graphId: string, graphFile: string, args: Record<string, unknown>,
    context?: ToolRuntimeContext) => Promise<unknown>;
  /** 확인 주입(시험). 결과는 requestConfirmation 과 같은 형태(boolean 또는 {answer}) — 정규화해 읽는다. */
  requestConfirmation?: (opts: Parameters<typeof confirmOnChannels>[0]) => Promise<unknown>;
}

/** graph id 는 manifest handler(graph:app-build · graph:app-build-plan)에서 유도한다 — src 하드코딩은
 *  PLUGIN-ONLY-RATCHET 가 동결한다(선례 app-deploy-plugin.ts: pluginId: manifest.id). */
function graphIdOf(toolName: 'app_build' | 'app_build_plan'): string {
  const manifest = parsePluginManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
  const handler = (manifest.contributes.aiTools ?? []).find(item => item.name === toolName)?.handler;
  if (typeof handler !== 'string' || !/^(?:\.\/)?graph:/.test(handler)) {
    throw new Error(`app build plugin handler is missing for ${toolName}`);
  }
  return handler.replace(/^(?:\.\/)?graph:/, '');
}

function graphFileOf(toolName: 'app_build' | 'app_build_plan'): string {
  return resolve(pluginRoot, APP_BUILD_PLUGIN_ID, 'graph', `${graphIdOf(toolName)}.yaml`);
}

/** requiresConfirm 등 route 메타데이터는 manifest 단일 출처(plugin.json). */
function requiresConfirmOf(toolName: 'app_build' | 'app_build_plan'): boolean {
  return appBuildPluginSpecs().find(spec => spec.name === toolName)?.route?.requiresConfirm === true;
}

/** daemon plugin-routes.ts 의 verifiedOwnerOf 와 같은 소유자 규칙(재사용): 원점·영수증 일치 슬롯.
 *  소유자 신원은 서버 세션에서만 — 도구 인자에서 절대 아니다. 슬롯은 검증 소유자 문맥이 이미 실은
 *  appSlug, 없으면 daemon ctx 처럼 영수증(appDeploymentOwner · memberId 일치)에서 유도한다. */
function effectiveOwner(context?: ToolRuntimeContext): ToolRuntimeContext['verifiedOwner'] {
  const owner = context?.verifiedOwner;
  if (!owner?.id || context?.requestOrigin === 'external-agent') return undefined;
  const receipt = context?.appDeploymentOwner;
  const appSlug = owner.appSlug || (receipt && receipt.memberId === owner.id ? receipt.appSlug : undefined);
  return appSlug ? { id: owner.id, appSlug } : { id: owner.id };
}

/** 완료 상태에서 공개 URL 만 읽는다(한 단계 좁은 탐색 — URL 을 지어내지 않는다). published 는 그래프가
 *  명시적으로 준 https URL 로만 성립; 없으면 failed(위조 금지). */
function publicUrlOf(state: unknown): string | undefined {
  if (!state || typeof state !== 'object') return undefined;
  const record = state as Record<string, unknown>;
  for (const container of [record, record.result, record.output, record.outputs, record.publish]) {
    if (!container || typeof container !== 'object') continue;
    const url = (container as Record<string, unknown>).publicUrl;
    if (typeof url === 'string' && /^https?:\/\//u.test(url)) return url;
  }
  return undefined;
}

type AppBuildBase = { kind: 'app-build'; tool: 'app_build' | 'app_build_plan'; pluginId: string; graphId: string };

function translateIncomplete(base: AppBuildBase, record: Record<string, unknown>): AppBuildOutput {
  const status = record.status;
  if (status === 'awaiting-approval') {
    const pending = record.pending && typeof record.pending === 'object'
      ? (record.pending as Record<string, unknown>).message : undefined;
    const hold = typeof record.approvalHold === 'string' ? record.approvalHold
      : typeof pending === 'string' ? pending : 'unavailable';
    return { ...base, status: 'awaiting-approval', buildComplete: false, approvalHold: hold };
  }
  const error = typeof record.error === 'string' ? record.error
    : status === 'failed' ? 'app build graph failed'
      : `unexpected app build graph state: ${String(status)}`;
  return { ...base, status: 'failed', buildComplete: false, error };
}

/** 그래프 상태(runGraph 결과) → AppBuildOutput 계약. done+URL 만 published; plan 은 planned 로. */
function translateGraphState(toolName: 'app_build' | 'app_build_plan', base: AppBuildBase, state: unknown): AppBuildOutput {
  const record = state && typeof state === 'object' ? state as Record<string, unknown> : {};
  if (record.status === 'done') {
    if (toolName === 'app_build_plan') return { ...base, status: 'planned', buildComplete: false };
    const publicUrl = publicUrlOf(record);
    return publicUrl
      ? { ...base, status: 'published', buildComplete: true, publicUrl }
      : { ...base, status: 'failed', buildComplete: false, error: 'app build finished without a public URL' };
  }
  return translateIncomplete(base, record);
}

/** route adapter 결과({ok:true|false} · declined 구조) → AppBuildOutput. 게이트 원문·code 는 보존. */
function translateRouteResult(toolName: 'app_build' | 'app_build_plan', base: AppBuildBase, result: unknown): AppBuildOutput {
  if (isAppBuildDeclined(result)) {
    return { ...base, status: 'rejected', buildComplete: false, code: 'APP_BUILD_DECLINED',
      error: 'app_build confirmation was declined' };
  }
  const record = result && typeof result === 'object' ? result as Record<string, unknown> : {};
  if (record.ok === false) {
    const error = typeof record.error === 'string' ? record.error : 'app_build route failed';
    const code = typeof record.code === 'string' ? record.code : undefined;
    if (error.includes('needs_connection') || code === 'VERIFIED_OWNER_REQUIRED' || code === 'MEMBER_APP_SLOT_REQUIRED') {
      return { ...base, status: 'needs_connection', buildComplete: false, needsConnection: true,
        ...(code ? { code } : {}), error };
    }
    if (error.includes('confirmation declined') || error.includes('confirmation failed closed')) {
      return { ...base, status: 'rejected', buildComplete: false, ...(code ? { code } : {}), error };
    }
    return { ...base, status: 'failed', buildComplete: false, ...(code ? { code } : {}), error };
  }
  if (record.ok === true) return translateGraphState(toolName, base, record.result);
  if (record.status !== undefined) return translateGraphState(toolName, base, record);
  return { ...base, status: 'failed', buildComplete: false, error: 'app_build route returned no result' };
}

/** 실행 슬라이스 — 게이트(원점·ask·멤버) → 실행기 위임(서버 route dispatch 우선, 없으면 주입
 *  dispatchGraph) → 계약 번역. 확인·소유자·그래프 신뢰 게이트는 route adapter 안에 하나만 있다. */
export async function runAppBuild(
  toolName: 'app_build' | 'app_build_plan',
  args: Record<string, unknown>,
  context?: ToolRuntimeContext,
  deps?: AppBuildDeps,
): Promise<AppBuildOutput> {
  const base: AppBuildBase = { kind: 'app-build', tool: toolName, pluginId: APP_BUILD_PLUGIN_ID, graphId: graphIdOf(toolName) };
  const reject = (error: string, code?: string): AppBuildOutput =>
    ({ ...base, status: 'rejected', buildComplete: false, ...(code ? { code } : {}), error });
  const needsConnection = (error: string, code: string): AppBuildOutput =>
    ({ ...base, status: 'needs_connection', buildComplete: false, needsConnection: true, code, error });

  // 원점 게이트 — 서버가 결속한 요청만. 외부 에이전트 원점은 실행기에 닿기 전에 거부한다.
  if (context?.requestOrigin === 'external-agent') {
    return reject('external-agent request origin cannot start app_build');
  }
  // 인자 게이트 — 한 줄 요청(ask)은 사용자 발언 그대로.
  if (typeof args.ask !== 'string' || !args.ask.trim()) {
    return reject(`${toolName} requires ask: pass the user one-line request verbatim`, 'APP_BUILD_ASK_REQUIRED');
  }
  // 멤버 게이트 — needs_connection 명시 상태. app_build 는 route adapter 와 같은 autofill 게이트
  // 전체(소유자·슬롯·ask), app_build_plan 은 그래프 라우트 공통 게이트(검증 소유자)를 쓴다.
  const owner = effectiveOwner(context);
  if (!owner?.id) {
    return needsConnection(
      toolName === 'app_build'
        ? 'needs_connection: verified member connection required before app_build (eln member connect)'
        : 'graph route requires a verified owner context',
      'VERIFIED_OWNER_REQUIRED',
    );
  }
  let graphArgs = args;
  if (isAppBuildRoute(APP_BUILD_PLUGIN_ID, toolName)) {
    const filled = autofillAppBuildArgs(args, { verifiedOwner: owner });
    if (filled.status !== 'filled') {
      if (filled.status === 'needs_connection') return needsConnection(filled.error, filled.code);
      return reject(filled.error, filled.code);
    }
    graphArgs = filled.args;
  }

  // 실행기 — 서버 결속 route dispatch 우선(전체 route adapter 기계 재사용), 없으면 주입 dispatchGraph.
  const routeDispatch = context?.appBuildRouteDispatch;
  const dispatchGraph = deps?.dispatchGraph;
  if (!routeDispatch && !dispatchGraph) {
    return { ...base, status: 'failed', buildComplete: false, error: 'graph route executor is not configured' };
  }
  if (routeDispatch) {
    // 위임 경로 — requiresConfirm 확인·소유자·그래프 신뢰 게이트는 route adapter 가 수행한다(이중 확인 없음).
    try {
      return translateRouteResult(toolName, base, await routeDispatch(toolName, args));
    } catch (error) {
      return { ...base, status: 'failed', buildComplete: false, error: String(error) };
    }
  }

  // 주입 실행기 경로(시험·향후 호스트) — 브리지가 확인 게이트를 채널과 함께 수행한다(adapter 동일 계약).
  // 확인 없이는 published 가 될 수 없고, 실패·타임아웃은 닫힌다(fail closed).
  if (requiresConfirmOf(toolName)) {
    const confirmWith = deps?.requestConfirmation ?? confirmOnChannels;
    let asked: unknown;
    try {
      asked = await confirmWith({
        prompt: `앱 만들기(${toolName})를 실행할까요?`, header: '앱 만들기', detail: String(args.ask),
        yesLabel: 'y', noLabel: 'N', channels: context?.confirmChannels ?? [], onTimeout: () => false,
      });
    } catch {
      asked = false;
    }
    const approved = typeof asked === 'boolean' ? asked : (asked as { answer?: unknown } | undefined)?.answer === true;
    if (!approved) return reject('app_build confirmation was declined', 'APP_BUILD_DECLINED');
  }
  try {
    return translateGraphState(toolName, base,
      await dispatchGraph!(APP_BUILD_PLUGIN_ID, graphIdOf(toolName), graphFileOf(toolName), graphArgs, context));
  } catch (error) {
    return { ...base, status: 'failed', buildComplete: false, error: String(error) };
  }
}
