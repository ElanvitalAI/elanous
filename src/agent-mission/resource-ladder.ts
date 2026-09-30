import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { debug } from '../debug/log.js';
import { streamLLM } from '../llm.js';
import { emitDecision, type DecisionEvent } from '../live/detail-switch.js';
import { OFFICIAL_INDEX_KEYS } from '../market/official-keys.js';
import { verifyIndex, type MarketplaceIndex } from '../market/signed-index.js';
import { buildCapabilityMatrix, pickBackend, type CapabilityReaders } from './capability-matrix.js';
import { createCapabilityReaders } from './capability-readers.js';
import { normalizeServiceName } from './capability-types.js';
import { discoverCapability, type CapabilityCandidate } from './discover-capability.js';
import { ELANOUS_MARKET_URL } from '../plugins/install/market-fetch.js';

const MARKETPLACE = 'elanous';
const INDEX_URL = new URL('marketplace.json', ELANOUS_MARKET_URL).href; // one source of truth for the official market
const MAX_NEEDS = 5;
const MAX_VOCABULARY = 200;

export interface ResourcePlan {
  needs: string[];
  have: string[];
  plugin?: { plugin: string; marketplace: string; source: 'official-index' };
  backend?: { name: string; why: string };
  gaps: Array<{ need: string; candidates: CapabilityCandidate[] }>;
  decisions: string[];
}

export interface MissionResources {
  readonly backend?: string;
  readonly plugin?: string;
  readonly resources?: 'off' | 'on';
  /** Total planner budget in milliseconds; discovery uses only the remaining time. */
  readonly deadlineMs?: number;
}

export interface ResourceLadderDeps extends MissionResources {
  /** One JSON-producing LLM call; the raw mission is never sent to logs. */
  readonly inferNeeds?: (safeMission: string, vocabulary: readonly string[]) => Promise<string>;
  readonly readers?: CapabilityReaders;
  /** Read the official index and its detached signature as a pair; no other market is consulted. */
  readonly readOfficialIndex?: () => Promise<{ marketplaceBytes: Uint8Array; signatureText: string }>;
  /** Installed Elanous plugin ledger, not the available-market catalog. */
  readonly readInstalledPlugins?: () => readonly { name: string; market: string }[];
  readonly discover?: typeof discoverCapability;
  /** Optional PTY integration seam (the planner never creates a PTY or installs by itself). */
  readonly installPlugin?: (request: { plugin: string; marketplace: string }) => Promise<unknown>;
  readonly decide?: (event: DecisionEvent) => unknown;
  readonly log?: (step: string, data: Record<string, unknown>) => void;
}

function safeMissionText(mission: string): string {
  return mission
    .replace(/\b(?:api[_-]?key|token|password|secret|authorization)\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)/gi, '[redacted]')
    .replace(/\b(?:bearer\s+)?(?:sk-[\w-]+|gh[pousr]_[\w-]+|github_pat_[\w-]+|AIza[\w-]+|xox[baprs]-[\w-]+)/gi, '[redacted]')
    .replace(/https?:\/\/\S+/gi, '[url]');
}

function safeNeed(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const need = value.normalize('NFKC').trim();
  if (!need || need.length > 80 || /[\n\r{}<>@=:/\\]|(?:secret|password|token|api.?key|bearer|redacted)/i.test(need)) return null;
  return need;
}

function parseNeeds(raw: string, vocabulary: readonly string[]): string[] {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray((parsed as { needs?: unknown }).needs)) return [];
  const needs: string[] = [];
  for (const item of (parsed as { needs: unknown[] }).needs) {
    const label = typeof item === 'string' ? vocabulary.find(value => value === item) : undefined;
    const need = label ?? safeNeed(item);
    if (need && !needs.some(existing => normalizeServiceName(existing) === normalizeServiceName(need))) {
      needs.push(label ?? vocabulary.find(value => normalizeServiceName(value) === normalizeServiceName(need)) ?? need);
    }
    if (needs.length === MAX_NEEDS) break;
  }
  return needs;
}

async function inferNeeds(mission: string, vocabulary: readonly string[]): Promise<string> {
  return streamLLM([
    { role: 'system', content: `Identify at most five concrete tool/service/skill capabilities required for this mission. Reply ONLY with JSON {"needs":["capability"]}. No credentials, tokens, URLs, or mission text in the output. If a relevant label appears in this verified official marketplace vocabulary, use that exact label; otherwise use a concrete capability. If uncertain, return an empty list.\nVerified labels: ${JSON.stringify(vocabulary)}` },
    { role: 'user', content: mission },
  ], () => {}, { maxTokens: 200, temperature: 0 });
}

async function readOfficialIndex(): Promise<{ marketplaceBytes: Uint8Array; signatureText: string }> {
  const [index, signature] = await Promise.all([fetch(INDEX_URL), fetch(new URL('index.sig', INDEX_URL))]);
  if (!index.ok || !signature.ok) throw new Error('official index unavailable');
  return { marketplaceBytes: new Uint8Array(await index.arrayBuffer()), signatureText: await signature.text() };
}

function installedPlugins(): readonly { name: string; market: string }[] {
  try {
    const rows: unknown = JSON.parse(readFileSync(join(elanousStateRoot(), 'plugins', 'installed.json'), 'utf8'));
    if (!Array.isArray(rows)) return [];
    return rows.flatMap((row): { name: string; market: string }[] => row && typeof row === 'object'
      && typeof row.name === 'string' && typeof row.market === 'string' ? [{ name: row.name, market: row.market }] : []);
  } catch { return []; }
}

function matches(need: string, labels: readonly string[]): boolean {
  const key = normalizeServiceName(need);
  return !!key && labels.some(label => normalizeServiceName(label) === key);
}

function pluginLabels(plugin: MarketplaceIndex['plugins'][number]): string[] {
  return [plugin.name, plugin.description ?? '', ...plugin['ai.elanous'].capabilities, ...(plugin['ai.elanous'].vocab ?? [])];
}

function officialVocabulary(index: MarketplaceIndex): string[] {
  const labels: string[] = [];
  for (const entry of index.plugins) {
    for (const label of [entry.name, ...entry['ai.elanous'].capabilities, ...(entry['ai.elanous'].vocab ?? [])]) {
      const safe = typeof label === 'string' && label === label.trim() && label.length <= 80
        && !/[\n\r{}<>@=/\\]/.test(label) && (safeMissionText(label) === label || /^secret:[a-zA-Z0-9._-]+$/.test(label)) ? label : null;
      if (safe && !labels.includes(safe)) labels.push(safe);
      if (labels.length === MAX_VOCABULARY) return labels;
    }
  }
  return labels;
}

function mentionedPluginNames(mission: string, index: MarketplaceIndex): string[] {
  return index.plugins.map(entry => entry.name).filter(name => {
    if (!safeNeed(name) || safeMissionText(name) !== name || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) return false;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^\\p{L}\\p{N}_.-])${escaped}(?=$|[^\\p{L}\\p{N}_.-])`, 'iu').test(mission);
  }).slice(0, MAX_NEEDS);
}

/** Pre-mission resource judgment. Only the optional, injected installer can cause installation. */
export async function planMissionResources(mission: string, deps: ResourceLadderDeps = {}, options: MissionResources = {}): Promise<ResourcePlan> {
  const plan: ResourcePlan = { needs: [], have: [], gaps: [], decisions: [] };
  if (options.resources === 'off' || deps.resources === 'off') return plan;
  const backend = options.backend ?? deps.backend;
  const plugin = options.plugin ?? deps.plugin;
  const budgetMs = options.deadlineMs ?? deps.deadlineMs;
  const deadline = budgetMs === undefined ? undefined : Date.now() + budgetMs;
  const decide = (step: string, kind: DecisionEvent['kind'], what: string, why: string) => {
    plan.decisions.push(`${step}: ${what} — ${why}`);
    (deps.decide ?? emitDecision)({ kind, what, reason: why, purpose: 'pre-mission resource selection', target: 'agent-mission', phase: 'dispatch' });
    (deps.log ?? ((event, data) => debug.log('agent-mission.resources', event, data)))(step, { kind, what, why });
  };

  let index: MarketplaceIndex | undefined;
  try {
    const pair = await (deps.readOfficialIndex ?? readOfficialIndex)();
    const checked = verifyIndex({ ...pair, trustedKeys: OFFICIAL_INDEX_KEYS });
    if (checked.ok && checked.index.name === MARKETPLACE) index = checked.index;
    else decide('official-index', 'ESCALATE', '공식 마켓 거부', '서명 또는 마켓 이름 검증 실패');
  } catch { decide('official-index', 'ESCALATE', '공식 마켓 조회 실패', '서명 검증 가능한 원본 인덱스 없음'); }
  const safeMission = safeMissionText(mission);
  const vocabulary = index ? officialVocabulary(index) : [];
  try { plan.needs = parseNeeds(await (deps.inferNeeds ?? inferNeeds)(safeMission, vocabulary), vocabulary); }
  catch { decide('needs', 'ESCALATE', '능력 판정 불가', 'LLM 응답 실패 — 추측하지 않음'); }
  const mentioned = index ? mentionedPluginNames(safeMission, index) : [];
  for (const name of mentioned) {
    if (!plan.needs.some(need => matches(need, [name]))) {
      if (plan.needs.length === MAX_NEEDS) plan.needs.pop();
      plan.needs.push(name);
    }
    decide('needs', 'VERIFY', name, '이름 언급');
  }
  decide('needs', 'VERIFY', '필요 능력 판정', `${plan.needs.length}개 확인`);
  if (!plan.needs.length) return plan;

  let matrix: ReturnType<typeof buildCapabilityMatrix> = [];
  try { matrix = buildCapabilityMatrix(deps.readers ?? createCapabilityReaders()); }
  catch { decide('have', 'ESCALATE', '능력표 읽기 실패', 'ready 로 확인되지 않은 서비스는 보유로 세지 않음'); }
  const ready = matrix.filter(entry => entry.state === 'ready');
  let remaining = plan.needs.filter(need => {
    if (!ready.some(entry => matches(need, [entry.service]))) return true;
    plan.have.push(need);
    return false;
  });
  decide('have', 'VERIFY', 'ready 서비스 대조', `${plan.have.length}개 확인`);

  if (index && remaining.length) {
    let installed: readonly { name: string; market: string }[] = [];
    try { installed = (deps.readInstalledPlugins ?? installedPlugins)(); }
    catch { decide('have', 'ESCALATE', '설치 원장 읽기 실패', '설치된 스킬을 보유로 간주하지 않음'); }
    remaining = remaining.filter(need => {
      if (!index.plugins.some(entry => installed.some(row => row.market === MARKETPLACE && row.name === entry.name)
        && matches(need, pluginLabels(entry)))) return true;
      plan.have.push(need);
      return false;
    });
    decide('have', 'VERIFY', '설치된 플러그인 스킬 대조', `${plan.have.length}개 확인`);
    if (!plugin) {
      const named = index.plugins.filter(entry => mentioned.includes(entry.name) && remaining.some(need => matches(need, [entry.name])));
      const choices = named.length ? named : index.plugins.filter(entry => remaining.some(need => matches(need, pluginLabels(entry))));
      if (choices.length === 1) {
        plan.plugin = { plugin: choices[0]!.name, marketplace: MARKETPLACE, source: 'official-index' };
        decide('official-index', 'ROUTE', '공식 플러그인 선택', '서명 검증된 인덱스에서 일치하는 플러그인 한 개');
        if (deps.installPlugin) {
          try {
            const result = await deps.installPlugin({ plugin: plan.plugin.plugin, marketplace: MARKETPLACE });
            const installed = result && typeof result === 'object' && 'outcome' in result && result.outcome === 'installed';
            if (installed) remaining = remaining.filter(need => !matches(need, pluginLabels(choices[0]!)));
            decide('official-index', installed ? 'VERIFY' : 'ESCALATE', '플러그인 설치 요청 결과', installed ? '설치 성공 확인' : '설치 미확인 — 필요 능력을 미충족으로 유지');
          } catch { decide('official-index', 'ESCALATE', '플러그인 설치 실패', '설치 결과를 보유로 간주하지 않음'); }
        } else decide('official-index', 'ESCALATE', '플러그인 제안만 함', '설치기 없음 — 필요 능력을 미충족으로 유지');
      } else if (choices.length > 1) decide('official-index', 'ESCALATE', '플러그인 선택 보류', '공식 후보가 둘 이상이라 자동 선택하지 않음');
    } else decide('official-index', 'ROUTE', '명시 플러그인 보존', '호출자 선택을 덮지 않음');
  }

  if (!backend) {
    const chosen = plan.needs.map(need => ({ need, name: pickBackend(matrix, need) })).find(row => row.name);
    if (chosen?.name) {
      plan.backend = { name: chosen.name, why: '필요 서비스의 ready 관측에 따른 선택' };
      decide('backend', 'ROUTE', 'ready 에이전트 선택', plan.backend.why);
    } else decide('backend', 'ESCALATE', '에이전트 자동 선택 보류', '필요 서비스의 ready 관측 없음');
  } else decide('backend', 'ROUTE', '명시 에이전트 보존', '호출자 backend 를 덮지 않음');
  plan.gaps = await Promise.all(remaining.map(async need => {
    let candidates: CapabilityCandidate[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    try {
      const remainingMs = deadline === undefined ? undefined : Math.max(0, deadline - Date.now() - 50);
      if (remainingMs === 0) throw new Error('discovery deadline');
      const discovery = (deps.discover ?? discoverCapability)(need, { community: false, signal: controller.signal });
      candidates = remainingMs === undefined ? await discovery : await Promise.race([
        discovery,
        new Promise<CapabilityCandidate[]>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('discovery deadline')), remainingMs); }),
      ]);
    } catch { controller.abort(); decide('discover', 'ESCALATE', '발굴 실패', '후보 없음 — 자동 설치하지 않음'); }
    finally { if (timer) clearTimeout(timer); }
    decide('discover', 'ESCALATE', '미충족 능력 후보', `${candidates.length}개 후보 제안만 함`);
    return { need, candidates };
  }));
  return plan;
}
