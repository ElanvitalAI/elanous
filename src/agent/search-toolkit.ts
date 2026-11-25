// 검색 묶음(search toolkit) — 캡슐(서브에이전트·연구 팬아웃·하니스 자식)이 «찾기» 도구를 빠짐없이 받게 한다.
//
// 관측(11-25 감사): 캡슐은 Read/Grep/Glob/ListDir 만 받았다 — AstGrep(키워드가 있을 때만 켜짐) ·
//   DirectiveSearch(카탈로그에만 있음) · 문서 검색(LLM 도구 없음)은 어느 캡슐에도 닿지 않았고,
//   연구 팬아웃 자식은 OmniSearch 하나뿐이었다.
// 처방: 묶음 하나 = Read · Grep · Glob · ListDir · AstGrep(바이너리 있을 때만 · 캐시) · DirectiveSearch · DocsSearch.
//   주입처 = buildCliAgentTools(coding 프로필이 지우지 않는다 — 묶음 이름이 어느 추가 묶음에도 없다) ·
//   general-purpose 정의 · dispatchAgent 자식 카탈로그(빠진 것만 더함) · 연구 팬아웃(읽기 전용 추가분).
// 세 얼굴: 관측 = agent.spawn dispatch 의 tools 목록 · 인지 = 묶음 이름 대조 · 수복 = 빠진 도구를 자식에 더한다.
import type { LLMToolSpec } from '../llm/tool-spec.js';

/** 코딩 코어에서 오는 넷 — 자식 카탈로그가 이미 갖는다. */
export const SEARCH_TOOLKIT_CORE = ['Glob', 'Grep', 'Read', 'ListDir'] as const;
/** 묶음이 직접 만들어 붙이는 셋(AstGrep 은 바이너리 있을 때만). */
export const SEARCH_TOOLKIT_EXTRAS = ['AstGrep', 'DirectiveSearch', 'DocsSearch'] as const;

let astGrepCache: boolean | undefined;
let astGrepProbe: (() => boolean) | null = null;

/** `ast-grep`/`sg` 바이너리 유무 — 프로세스당 한 번만 잰다. */
export function astGrepAvailable(): boolean {
  if (astGrepProbe) return astGrepProbe();
  if (astGrepCache === undefined) {
    try {
      astGrepCache = (require('../skills/tools/ast-grep.js') as typeof import('../skills/tools/ast-grep.js')).hasAstGrep();
    } catch { astGrepCache = false; }
  }
  return astGrepCache;
}

/** 시험 심 — null 이면 실물(캐시 초기화). */
export function setAstGrepProbeForTesting(probe: (() => boolean) | null): void {
  astGrepProbe = probe;
  astGrepCache = undefined;
}

/** 지금 이 호스트에서 묶음이 내는 이름 전부. */
export function searchToolkitNames(): string[] {
  return [...SEARCH_TOOLKIT_CORE, ...SEARCH_TOOLKIT_EXTRAS.filter((n) => n !== 'AstGrep' || astGrepAvailable())];
}

export interface SearchToolkitExtras {
  specs: LLMToolSpec[];
  dispatch: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

/** AstGrep · DirectiveSearch · DocsSearch — 코딩 코어 밖의 검색 도구. cwd 는 AstGrep 의 기준 디렉터리. */
export function buildSearchToolkitExtras(cwd: () => string): SearchToolkitExtras {
  const specs: LLMToolSpec[] = [];
  if (astGrepAvailable()) specs.push((require('../skills/tools/ast-grep.js') as typeof import('../skills/tools/ast-grep.js')).buildAstGrepTool());
  specs.push((require('../skills/tools/directive-search.js') as typeof import('../skills/tools/directive-search.js')).buildDirectiveSearchTool());
  specs.push((require('../skills/tools/docs-search.js') as typeof import('../skills/tools/docs-search.js')).buildDocsSearchTool());
  const names = new Set(specs.map((s) => s.name));
  const dispatch = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    if (!names.has(name)) throw new Error(`not a search toolkit tool: ${name}`);
    if (name === 'AstGrep') return (await import('../skills/tools/ast-grep.js')).dispatchAstGrep(args, { cwd: cwd() });
    if (name === 'DirectiveSearch') return (await import('../skills/tools/directive-search.js')).dispatchDirectiveSearch(args);
    return (await import('../skills/tools/docs-search.js')).dispatchDocsSearch(args);
  };
  return { specs, dispatch };
}

/**
 * 자식 카탈로그에 빠진 묶음 도구를 더한다 — 이미 있는 이름은 건드리지 않는다.
 * 코어 넷(Read/Grep/Glob/ListDir)이 빠졌으면 `readOnlyCore` 가 줄 때만 더한다.
 */
export function withSearchToolkit(
  tools: readonly LLMToolSpec[],
  dispatch: ((name: string, args: Record<string, unknown>) => Promise<unknown>) | undefined,
  cwd: () => string,
  readOnlyCore?: () => SearchToolkitExtras,
): { tools: LLMToolSpec[]; dispatch: ((name: string, args: Record<string, unknown>) => Promise<unknown>) | undefined; added: string[] } {
  const have = new Set(tools.map((t) => t.name));
  const extras = buildSearchToolkitExtras(cwd);
  const addedSpecs = extras.specs.filter((s) => !have.has(s.name));
  let core: SearchToolkitExtras | undefined;
  if (readOnlyCore && SEARCH_TOOLKIT_CORE.some((n) => !have.has(n))) {
    core = readOnlyCore();
    for (const s of core.specs) if (!have.has(s.name)) addedSpecs.push(s);
  }
  if (addedSpecs.length === 0) return { tools: [...tools], dispatch, added: [] };
  const extraNames = new Set(extras.specs.filter((s) => !have.has(s.name)).map((s) => s.name));
  const coreNames = new Set((core?.specs ?? []).filter((s) => !have.has(s.name)).map((s) => s.name));
  const wrapped = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    if (extraNames.has(name)) return extras.dispatch(name, args);
    if (coreNames.has(name) && core) return core.dispatch(name, args);
    if (!dispatch) throw new Error(`No dispatcher for ${name}`);
    return dispatch(name, args);
  };
  return { tools: [...tools, ...addedSpecs], dispatch: wrapped, added: addedSpecs.map((s) => s.name) };
}

/**
 * 읽기 전용 검색 카탈로그 — 연구 팬아웃처럼 «쓰기 도구 없는» 자식에게 줄 묶음 전체.
 * 코어 넷은 CLI 카탈로그(같은 가드)에서 이름으로 골라 쓰고, 그 밖의 이름은 거절한다.
 */
export function buildReadOnlySearchCatalog(cwd: string): SearchToolkitExtras {
  const cli = (require('../cli/agent-cli.js') as typeof import('../cli/agent-cli.js')).buildCliAgentTools(undefined, undefined, cwd);
  const allowed = new Set(searchToolkitNames());
  const specs = cli.specs.filter((s) => allowed.has(s.name));
  const names = new Set(specs.map((s) => s.name));
  const dispatch = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    if (!names.has(name)) throw new Error(`read-only search catalog does not allow: ${name}`);
    return cli.dispatch(name, args);
  };
  return { specs, dispatch };
}
