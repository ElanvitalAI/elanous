import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'parse5';
import { parseAppManifest } from '../nexus/apps/app-contract.js';
import type { AppSimulationReceipt } from '../nexus/apps/app-simulation.js';
import { applyMadeWithBadge, MADE_WITH_BADGE_ENTITLEMENT } from '../nexus/apps/made-with-badge.js';

export type SimScenarioOutcome = 'passed' | 'failed' | 'skipped' | 'unmeasured';
/** AppSimulationReceipt plus the source fingerprint field supplied by the promotion receipt contract. */
export type AppPromotionSimulationReceipt = AppSimulationReceipt & { readonly appFingerprint?: string };

export interface SimReceiptInput {
  readonly simulationReceipt: AppPromotionSimulationReceipt;
  /** Supplied by the same current-source fingerprint resolver used by app promotion. */
  readonly currentAppFingerprint: string;
  /** The app.yaml whose validated simulate.scenarios list is authoritative. */
  readonly appSourceRoot: string;
  readonly deviceCatalogVersion: number | null;
  /** Outcomes come from the completed simulation run; required IDs are read from app.yaml, never from this input. */
  readonly scenarioResults: readonly { readonly id: string; readonly outcome: SimScenarioOutcome }[];
  readonly sandboxEstablished: boolean;
  readonly externalNetworkAttempts: number | null;
  readonly blockedNetworkAttempts: number | null;
  readonly unmeasuredCount: number | null;
  /** Relative durable store reference; absolute host paths are not included in a public proof. */
  readonly eventLedgerPath: string | null;
}

export interface SimReceipt {
  readonly schema: 'elanous.sim-receipt.v1';
  readonly appSimulationReceiptId: string;
  readonly appSimulationRunId: string;
  readonly appId: string;
  readonly appFingerprint: string;
  readonly deviceCatalogVersion: number | null;
  readonly requiredScenarios: readonly { readonly id: string; readonly outcome: SimScenarioOutcome }[];
  readonly sandboxEstablished: boolean;
  readonly externalNetworkAttempts: number | null;
  readonly blockedNetworkAttempts: number | null;
  readonly unmeasuredCount: number | null;
  readonly eventLedgerPath: string | null;
  readonly createdAt: string;
  readonly verdict: 'passed' | 'failed' | 'stale' | 'unmeasured';
  readonly reasons: readonly string[];
  readonly receiptFingerprint: string;
}

const APP_ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SCENARIO_NAME = /^[^\u0000-\u001f\u007f]+$/u;
const APP_FINGERPRINT = /^[a-f0-9]{64}$/;
const RELATIVE_LEDGER_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[a-zA-Z0-9._/-]+\.(?:jsonl|sqlite(?:#[A-Za-z0-9._:-]+)?)$/;
interface ParsedHtmlNode {
  readonly tagName?: string;
  readonly attrs?: readonly { readonly name: string; readonly value: string }[];
  readonly childNodes?: readonly ParsedHtmlNode[];
  readonly content?: ParsedHtmlNode;
  readonly sourceCodeLocation?: { readonly startTag?: { readonly endOffset: number } } | null;
}

function bindFingerprintToOwnedBadge(html: string, fingerprint: string): string {
  const document = parse(html, { sourceCodeLocationInfo: true }) as unknown as ParsedHtmlNode;
  const pending = [document];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.tagName === 'footer' && node.attrs?.some(attribute => attribute.name === 'data-elanous-made-with-badge' && attribute.value === 'true')) {
      const end = node.sourceCodeLocation?.startTag?.endOffset;
      if (end !== undefined) return `${html.slice(0, end - 1)} data-sim-receipt-fingerprint="${fingerprint}"${html.slice(end - 1)}`;
    }
    if (node.childNodes) pending.push(...node.childNodes);
    if (node.content?.childNodes) pending.push(...node.content.childNodes);
  }
  return html;
}

function isCount(value: number | null): value is number {
  // Source: 내부 문서 `user-simulation-kit` §5 — evidence counters cannot be negative.
  return value !== null && Number.isSafeInteger(value) && value >= 0;
}

export function currentSimDeviceCatalogVersion(): number | null {
  try {
    const metadata = JSON.parse(readFileSync(join(import.meta.dir, '../../catalog/ux-sim/mock-scenario-catalog-fragments/metadata.json'), 'utf8')) as { deviceCatalogVersion?: unknown };
    return typeof metadata.deviceCatalogVersion === 'number' && Number.isSafeInteger(metadata.deviceCatalogVersion)
      && metadata.deviceCatalogVersion > 0 ? metadata.deviceCatalogVersion : null;
  } catch { return null; }
}

function requiredScenarioIdsFromAppYaml(appSourceRoot: string): string[] {
  try {
    const parsed = parseAppManifest(readFileSync(join(appSourceRoot, 'app.yaml'), 'utf8'));
    if (!parsed.ok) return [];
    const simulate = parsed.manifest.simulate;
    if (!simulate || typeof simulate !== 'object' || Array.isArray(simulate)) return [];
    const scenarios = (simulate as { scenarios?: unknown }).scenarios;
    if (!Array.isArray(scenarios)) return [];
    return scenarios.flatMap((scenario) => scenario && typeof scenario === 'object' && !Array.isArray(scenario)
      && typeof (scenario as { name?: unknown }).name === 'string' ? [(scenario as { name: string }).name] : []);
  } catch {
    return [];
  }
}

/** Build a content-addressed proof from the existing app simulation receipt and current source snapshot. */
export function buildConceptProofReceipt(input: SimReceiptInput): SimReceipt {
  const currentFingerprint = input.currentAppFingerprint;
  const scenarioResults = new Map<string, SimScenarioOutcome>();
  for (const result of input.scenarioResults) {
    if (scenarioResults.has(result.id)) scenarioResults.set(result.id, 'failed');
    else scenarioResults.set(result.id, result.outcome);
  }
  const requiredScenarioIds = requiredScenarioIdsFromAppYaml(input.appSourceRoot);
  const scenarios = [...new Set(requiredScenarioIds)]
    .map(id => ({ id, outcome: scenarioResults.get(id) ?? 'unmeasured' as const }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const reasons: string[] = [];
  let verdict: SimReceipt['verdict'] = 'passed';
  const setVerdict = (next: SimReceipt['verdict'], reason: string) => {
    reasons.push(reason);
    if (next === 'stale' || (next === 'failed' && verdict !== 'stale')
      || (next === 'unmeasured' && verdict === 'passed')) verdict = next;
  };

  if (!APP_ID.test(input.simulationReceipt.appId)) setVerdict('failed', 'app-id-invalid');
  if (!APP_FINGERPRINT.test(currentFingerprint)) setVerdict('unmeasured', 'current-app-fingerprint-unavailable');
  if (!input.simulationReceipt.appFingerprint || input.simulationReceipt.appFingerprint !== currentFingerprint) {
    setVerdict('stale', 'app-fingerprint-missing-or-stale');
  }
  if (input.simulationReceipt.outcome !== 'passed') setVerdict('failed', 'app-simulation-failed');
  // Source: 내부 문서 `user-simulation-kit` §5 — a proof requires a non-empty required scenario set.
  if (scenarios.length === 0 || scenarios.length !== requiredScenarioIds.length) setVerdict('failed', 'required-scenarios-missing-or-duplicated');
  const scenarioIds = new Set<string>();
  for (const scenario of scenarios) {
    if (!SCENARIO_NAME.test(scenario.id) || !scenario.id.trim() || scenarioIds.has(scenario.id)) setVerdict('failed', 'required-scenario-invalid');
    scenarioIds.add(scenario.id);
    if (scenario.outcome === 'unmeasured') setVerdict('unmeasured', `scenario-unmeasured:${scenario.id}`);
    else if (scenario.outcome !== 'passed') setVerdict('failed', `required-scenario-${scenario.outcome}:${scenario.id}`);
  }
  if (input.deviceCatalogVersion === null || !Number.isSafeInteger(input.deviceCatalogVersion)
    // Source: 내부 문서 `user-simulation-kit` §4 — catalog versions are positive integers.
    || input.deviceCatalogVersion < 1) setVerdict('unmeasured', 'device-catalog-version-unmeasured');
  if (!input.sandboxEstablished) setVerdict('unmeasured', 'network-sandbox-unmeasured');
  if (!isCount(input.externalNetworkAttempts)) setVerdict('unmeasured', 'external-network-attempt-count-unmeasured');
  // Source: 내부 문서 `user-simulation-kit` §5 — any real external network attempt invalidates the proof.
  else if (input.externalNetworkAttempts > 0) setVerdict('failed', 'external-network-attempts-present');
  if (!isCount(input.blockedNetworkAttempts)) setVerdict('unmeasured', 'blocked-network-attempt-count-unmeasured');
  if (!isCount(input.unmeasuredCount)) setVerdict('unmeasured', 'unmeasured-count-unavailable');
  // Source: 내부 문서 `user-simulation-kit` §5 — valid proof has zero unmeasured fields.
  else if (input.unmeasuredCount > 0) setVerdict('unmeasured', 'unmeasured-fields-present');
  if (!input.eventLedgerPath || !RELATIVE_LEDGER_PATH.test(input.eventLedgerPath)) setVerdict('unmeasured', 'event-ledger-reference-unavailable');
  if (!Number.isFinite(Date.parse(input.simulationReceipt.createdAt))) setVerdict('unmeasured', 'receipt-created-at-invalid');

  const payload = {
    schema: 'elanous.sim-receipt.v1' as const,
    appSimulationReceiptId: input.simulationReceipt.id,
    appSimulationRunId: input.simulationReceipt.runId,
    appId: input.simulationReceipt.appId,
    appFingerprint: currentFingerprint,
    deviceCatalogVersion: input.deviceCatalogVersion,
    requiredScenarios: scenarios,
    sandboxEstablished: input.sandboxEstablished,
    externalNetworkAttempts: input.externalNetworkAttempts,
    blockedNetworkAttempts: input.blockedNetworkAttempts,
    unmeasuredCount: input.unmeasuredCount,
    eventLedgerPath: input.eventLedgerPath,
    createdAt: input.simulationReceipt.createdAt,
    verdict,
    reasons,
  };
  const receiptFingerprint = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  return { ...payload, receiptFingerprint };
}

/** Show the owned attribution only for a passing proof and bind it to that proof's content fingerprint. */
export function applyConceptProofBadge(
  html: string,
  receipt: SimReceipt | undefined,
  entitlements?: Readonly<Record<string, unknown>>,
): string {
  if (!receipt || receipt.verdict !== 'passed') {
    return applyMadeWithBadge(html, { ...entitlements, [MADE_WITH_BADGE_ENTITLEMENT]: 0 });
  }
  const decorated = applyMadeWithBadge(html, entitlements);
  return bindFingerprintToOwnedBadge(decorated, receipt.receiptFingerprint);
}
