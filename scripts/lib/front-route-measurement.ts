import { classifyIntakeFrontRoute } from '../../src/intake-plane/front-route-classifier.js';
import { INTAKE_FRONT_ROUTE_TRACKS, type IntakeFrontRouteDecision, type IntakeFrontRouteTrack } from '../../src/intake-plane/front-route-rules.js';
import type { ResolveRoleProviderFn } from '../../src/intake-plane/runtime-callables.js';
import { wilsonInterval, type WilsonInterval } from './nl-routing-measurement.js';

export interface FrontRouteItem { id: string; text: string; expected: IntakeFrontRouteTrack }
export interface FrontRouteCorpus { description: string; items: FrontRouteItem[] }
export type FrontRouteConfusion = Record<IntakeFrontRouteTrack, Record<IntakeFrontRouteTrack, number>>;
export interface FrontRouteProviderResult {
  label: string;
  runs: number;
  agree: number;
  agreement: number;
  wilson: WilsonInterval | null;
  askHuman: number;
  confusion: FrontRouteConfusion;
  meanLatencyMs: number;
  perItem: { id: string; expected: IntakeFrontRouteTrack; got: IntakeFrontRouteTrack[] }[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isTrack(value: unknown): value is IntakeFrontRouteTrack {
  return typeof value === 'string' && (INTAKE_FRONT_ROUTE_TRACKS as readonly string[]).includes(value);
}

export function loadFrontRouteCorpus(json: unknown): FrontRouteCorpus {
  const parsed: unknown = typeof json === 'string' ? JSON.parse(json) : json;
  if (!isRecord(parsed) || typeof parsed.description !== 'string' || !Array.isArray(parsed.items) || parsed.items.length === 0) {
    throw new Error('Front-route corpus requires a description and nonempty items array');
  }
  const ids = new Set<string>();
  const items: FrontRouteItem[] = parsed.items.map((raw: unknown, index: number) => {
    if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id.trim() ||
      typeof raw.text !== 'string' || !raw.text.trim() || !isTrack(raw.expected)) {
      throw new Error(`Invalid front-route corpus item at index ${index} (id, text, expected track required)`);
    }
    if (ids.has(raw.id)) throw new Error(`Duplicate front-route corpus id at index ${index}`);
    ids.add(raw.id);
    return { id: raw.id, text: raw.text, expected: raw.expected };
  });
  return { description: parsed.description, items };
}

function emptyConfusion(): FrontRouteConfusion {
  return Object.fromEntries(INTAKE_FRONT_ROUTE_TRACKS.map((expected) => [expected,
    Object.fromEntries(INTAKE_FRONT_ROUTE_TRACKS.map((got) => [got, 0])),
  ])) as FrontRouteConfusion;
}

export async function measureFrontRoute(
  items: readonly FrontRouteItem[],
  { providers, runs, classify = classifyIntakeFrontRoute, now = () => performance.now() }: {
    providers: readonly { label: string; resolve: ResolveRoleProviderFn }[];
    runs: number;
    classify?: typeof classifyIntakeFrontRoute;
    now?: () => number;
  },
): Promise<FrontRouteProviderResult[]> {
  if (!Number.isSafeInteger(runs) || runs < 1) throw new Error('runs must be a positive integer');
  if (!items.length || !providers.length) throw new Error('items and providers must not be empty');
  if (new Set(providers.map(({ label }) => label)).size !== providers.length || providers.some(({ label }) => !label.trim())) {
    throw new Error('provider labels must be unique and nonempty');
  }
  // An id can contain another item's text, too: sanitize against the whole corpus.
  const texts = items.map(({ text }) => text);
  const exposesText = (id: string) => texts.some((text) => id.includes(text));
  const safeIds = new Set(items.filter(({ id }) => !exposesText(id)).map(({ id }) => id));
  const reportIds = items.map(({ id }, index) => {
    if (!exposesText(id)) return id;
    let candidate = `item-${index + 1}`;
    if (exposesText(candidate) || safeIds.has(candidate)) {
      let codePoint = 0xe000;
      while (texts.some((text) => text.includes(String.fromCodePoint(codePoint)))) codePoint++;
      const unused = String.fromCodePoint(codePoint);
      candidate = unused;
      while (safeIds.has(candidate)) candidate += unused;
    }
    safeIds.add(candidate);
    return candidate;
  });
  const results: FrontRouteProviderResult[] = [];
  for (const { label, resolve } of providers) {
    const confusion = emptyConfusion();
    const perItem: FrontRouteProviderResult['perItem'] = [];
    let agree = 0;
    let askHuman = 0;
    let latencyMs = 0;
    for (const [index, item] of items.entries()) {
      const got: IntakeFrontRouteTrack[] = [];
      for (let repeat = 0; repeat < runs; repeat++) {
        const started = now();
        let decision: IntakeFrontRouteDecision;
        try {
          decision = await classify(item.text, { resolveRoleProvider: resolve });
        } catch {
          decision = { track: 'ask-human', confidence: 0, reason: 'classifier-failed:llm-error', decidedBy: 'classifier' };
        } finally {
          latencyMs += now() - started;
        }
        if (!isTrack(decision.track)) throw new Error(`Invalid classifier track for item ${reportIds[index]}`);
        got.push(decision.track);
        confusion[item.expected][decision.track]++;
        if (decision.track === item.expected) agree++;
        if (decision.track === 'ask-human' &&
          (decision.reason.startsWith('classifier-low-confidence:') || decision.reason.startsWith('classifier-failed:'))) askHuman++;
      }
      perItem.push({ id: reportIds[index]!, expected: item.expected, got });
    }
    const total = items.length * runs;
    results.push({ label, runs: total, agree, agreement: agree / total, wilson: wilsonInterval(agree, total), askHuman,
      confusion, meanLatencyMs: latencyMs / total, perItem });
  }
  return results;
}

export function formatFrontRouteReport(result: readonly FrontRouteProviderResult[]): string {
  const percent = (n: number) => `${(100 * n).toFixed(1)}%`;
  const lines = ['Provider | Agreement | 95% Wilson | ask-human (low confidence/failure) | Mean latency ms'];
  for (const provider of result) {
    const interval = provider.wilson;
    lines.push(`${provider.label} | ${provider.agree}/${provider.runs} (${percent(provider.agreement)}) | ${interval ? `${percent(interval.lower)}–${percent(interval.upper)}` : 'n/a'} | ${provider.askHuman} | ${provider.meanLatencyMs.toFixed(1)}`);
    lines.push(`Confusion (${provider.label}): expected \\ got | ${INTAKE_FRONT_ROUTE_TRACKS.join(' | ')}`);
    for (const expected of INTAKE_FRONT_ROUTE_TRACKS) {
      lines.push(`${expected} | ${INTAKE_FRONT_ROUTE_TRACKS.map((got) => provider.confusion[expected][got]).join(' | ')}`);
    }
  }
  return lines.join('\n');
}
