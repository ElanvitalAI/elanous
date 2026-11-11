import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'parse5';
import { applyConceptProofBadge, buildConceptProofReceipt, type AppPromotionSimulationReceipt, type SimReceiptInput } from './sim-receipt.js';

interface ParsedNode { readonly tagName?: string; readonly attrs?: readonly { readonly name: string; readonly value: string }[]; readonly childNodes?: readonly ParsedNode[]; readonly content?: ParsedNode }

function hasRenderedOwnedBadge(node: ParsedNode): boolean {
  if (node.tagName === 'footer' && node.attrs?.some(attribute => attribute.name === 'data-elanous-made-with-badge' && attribute.value === 'true')) return true;
  return [...(node.childNodes ?? []), ...(node.content?.childNodes ?? [])].some(hasRenderedOwnedBadge);
}

const catalogMetadata = JSON.parse(readFileSync(new URL('../../catalog/ux-sim/mock-scenario-catalog-fragments/metadata.json', import.meta.url), 'utf8')) as { deviceCatalogVersion: number };

function createAppSourceRoot(scenarios = ['happy-path', 'provider-failure-recovery']): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'sim-receipt-app-source-'));
  const declarations = scenarios.map(name => `    - name: ${name}\n      steps: [{ action: makeAd, as: owner }]\n      expect: [{ screen-text: Ready }]`).join('\n');
  writeFileSync(join(root, 'app.yaml'), `apiVersion: elanous.app/v0
slug: demo-app
title: Demo app
frontend: { kind: static-export }
tables:
  notes:
    columns:
      id: { type: text, primary: true }
      title: { type: text }
roles: { owner: { via: nexus-session } }
rpc:
  addNote:
    sql: INSERT INTO notes (id, title) VALUES (:id, :title)
    params: { id: { type: text }, title: { type: text } }
    allow: [owner]
actions:
  makeAd: { builtin: generate, async: true, spend: owner-confirm, uses: [cred:higgsfield.secret] }
simulate:
  connectors:
    makeAd: { fake: generate-job, profile: slow-then-ok }
  scenarios:
${declarations}
`);
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('concept proof receipt binds passing scenarios and the made-with badge to the current app fingerprint', () => {
  const appSource = createAppSourceRoot();
  try {
  const fingerprint = 'a'.repeat(64);
  const simulationReceipt: AppPromotionSimulationReceipt = { id: 'app-sim-receipt', appId: 'demo-app', runId: 'app-sim-run',
    createdAt: '2026-11-10T08:00:00.000Z', outcome: 'passed', summary: 'required scenarios passed', appFingerprint: fingerprint };
  const input: SimReceiptInput = {
    simulationReceipt,
    currentAppFingerprint: fingerprint,
    appSourceRoot: appSource.root,
    deviceCatalogVersion: catalogMetadata.deviceCatalogVersion,
    scenarioResults: [{ id: 'happy-path', outcome: 'passed' }, { id: 'provider-failure-recovery', outcome: 'passed' }],
    sandboxEstablished: true,
    // Source: 내부 문서 `user-simulation-kit` §5 — valid proofs require zero real external network attempts.
    externalNetworkAttempts: 0,
    // Source: 내부 문서 `user-simulation-kit` §2 — blocked attempts are measured separately from real sends.
    blockedNetworkAttempts: 1,
    // Source: 내부 문서 `user-simulation-kit` §5 — a proof with any unmeasured field is not valid.
    unmeasuredCount: 0,
    eventLedgerPath: 'app-simulation.sqlite#app-sim-run',
  };

  const receipt = buildConceptProofReceipt(input);
  expect(receipt).toMatchObject({ verdict: 'passed', appFingerprint: fingerprint,
    deviceCatalogVersion: input.deviceCatalogVersion, appSimulationReceiptId: simulationReceipt.id,
    appSimulationRunId: simulationReceipt.runId, requiredScenarios: input.scenarioResults,
    externalNetworkAttempts: 0, blockedNetworkAttempts: 1, unmeasuredCount: 0,
    eventLedgerPath: input.eventLedgerPath });
  expect(receipt.receiptFingerprint).toMatch(/^[a-f0-9]{64}$/);

  const htmlWithExample = '<html><body><textarea><footer data-elanous-made-with-badge="true">user example</footer></textarea><main>concept</main></body></html>';
  const decorated = applyConceptProofBadge(htmlWithExample, receipt);
  expect(decorated).toContain('data-elanous-made-with-badge="true"');
  expect(decorated).toContain(`data-sim-receipt-fingerprint="${receipt.receiptFingerprint}"`);
  expect(decorated).toContain('<textarea><footer data-elanous-made-with-badge="true">user example</footer></textarea>');
  expect(decorated.match(/data-sim-receipt-fingerprint=/g)).toHaveLength(1);
  const browserEndTag = applyConceptProofBadge('<html><body><script>const x = 1;</script foo><main>visible</main></body></html>', receipt);
  expect(browserEndTag).toContain(`<footer data-elanous-made-with-badge="true" class="elanous-made-with-badge"`);
  expect(browserEndTag).toContain(`data-sim-receipt-fingerprint="${receipt.receiptFingerprint}"`);
  expect(browserEndTag.match(/data-sim-receipt-fingerprint=/g)).toHaveLength(1);
  const quotedEndTag = applyConceptProofBadge('<html><body><script>const x = 1;</script foo="><textarea>"><main>visible</main></body></html>', receipt);
  expect(quotedEndTag).toContain(`data-sim-receipt-fingerprint="${receipt.receiptFingerprint}"`);
  expect(quotedEndTag.match(/data-sim-receipt-fingerprint=/g)).toHaveLength(1);
  const doubleEscapedScript = applyConceptProofBadge('<script><!--<script></script><textarea> --></script><main>visible</main>', receipt);
  expect(doubleEscapedScript).not.toContain('data-sim-receipt-fingerprint=');
  expect(hasRenderedOwnedBadge(parse(doubleEscapedScript) as unknown as ParsedNode)).toBe(false);
  expect(applyConceptProofBadge(decorated, receipt)).toBe(decorated);
  // Source: 내부 문서 `user-simulation-kit` §5 — reissued badge carries only the current proof fingerprint.
  const refreshedReceipt = buildConceptProofReceipt({ ...input, deviceCatalogVersion: input.deviceCatalogVersion! + 1 });
  const refreshed = applyConceptProofBadge(decorated, refreshedReceipt);
  expect(refreshed.match(/data-sim-receipt-fingerprint=/g)).toHaveLength(1);
  expect(refreshed).toContain(`data-sim-receipt-fingerprint="${refreshedReceipt.receiptFingerprint}"`);
  expect(refreshed).not.toContain(`data-sim-receipt-fingerprint="${receipt.receiptFingerprint}"`);
  } finally { appSource.cleanup(); }
});

test('stale source, failed or missing required scenarios, network escape, and unmeasured evidence cannot receive the badge', () => {
  const appSource = createAppSourceRoot();
  try {
  const originalFingerprint = 'a'.repeat(64);
  const simulationReceipt: AppPromotionSimulationReceipt = { id: 'app-sim-receipt', appId: 'demo-app', runId: 'app-sim-run',
    createdAt: '2026-11-10T08:00:00.000Z', outcome: 'passed', summary: 'required scenarios passed', appFingerprint: originalFingerprint };
  const base: SimReceiptInput = {
    simulationReceipt,
    currentAppFingerprint: originalFingerprint,
    appSourceRoot: appSource.root,
    deviceCatalogVersion: catalogMetadata.deviceCatalogVersion,
    scenarioResults: [{ id: 'happy-path', outcome: 'passed' }],
    sandboxEstablished: true,
    // Source: 내부 문서 `user-simulation-kit` §5 — valid proofs require zero real external network attempts.
    externalNetworkAttempts: 0,
    // Source: 내부 문서 `user-simulation-kit` §2 — blocked attempts are measured separately from real sends.
    blockedNetworkAttempts: 0,
    // Source: 내부 문서 `user-simulation-kit` §5 — a proof with any unmeasured field is not valid.
    unmeasuredCount: 0,
    eventLedgerPath: 'events/app-sim-run.jsonl',
  };
  const changedFingerprint = 'b'.repeat(64);
  const stale = buildConceptProofReceipt({ ...base, currentAppFingerprint: changedFingerprint });
  expect(stale.verdict).toBe('stale');
  expect(applyConceptProofBadge('<html><body>app</body></html>', stale)).not.toContain('made with elanous');

  const changedReceipt = { ...simulationReceipt, appFingerprint: changedFingerprint };
  const current = { ...base, currentAppFingerprint: changedFingerprint, simulationReceipt: changedReceipt };
  expect(buildConceptProofReceipt({ ...current, scenarioResults: [] }).verdict).toBe('unmeasured');
  expect(buildConceptProofReceipt({ ...current, requiredScenarioIds: ['happy-path'] } as SimReceiptInput).verdict).toBe('unmeasured');
  expect(buildConceptProofReceipt({ ...current, scenarioResults: [
    { id: 'happy-path', outcome: 'passed' }, { id: 'happy-path', outcome: 'passed' },
  ] }).verdict).toBe('failed');
  expect(buildConceptProofReceipt({ ...current, scenarioResults: [{ id: 'happy-path', outcome: 'passed' }, { id: 'provider-failure-recovery', outcome: 'passed' }] }).verdict).toBe('passed');
  expect(buildConceptProofReceipt({ ...current, scenarioResults: [{ id: 'happy-path', outcome: 'failed' }] }).verdict).toBe('failed');
  // Source: 내부 문서 `user-simulation-kit` §5 — a proof cannot pass if a real external send occurred.
  expect(buildConceptProofReceipt({ ...current, externalNetworkAttempts: 1 }).verdict).toBe('failed');
  expect(buildConceptProofReceipt({ ...current, sandboxEstablished: false }).verdict).toBe('unmeasured');
  expect(buildConceptProofReceipt({ ...current, unmeasuredCount: 1 }).verdict).toBe('unmeasured');
  expect(buildConceptProofReceipt({ ...current, eventLedgerPath: null }).verdict).toBe('unmeasured');
  expect(buildConceptProofReceipt({ ...current, simulationReceipt: { ...changedReceipt, appFingerprint: undefined } }).verdict).toBe('stale');
  expect(buildConceptProofReceipt({ ...current, simulationReceipt: { ...changedReceipt, outcome: 'failed' } }).verdict).toBe('failed');
  const invalidAppSource = createAppSourceRoot([]);
  try { expect(buildConceptProofReceipt({ ...current, appSourceRoot: invalidAppSource.root }).verdict).toBe('failed'); }
  finally { invalidAppSource.cleanup(); }
  } finally { appSource.cleanup(); }
});
