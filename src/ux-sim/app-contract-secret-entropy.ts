// Feed synthetic credential candidates through the production parser. The device returns case IDs
// and aggregate metrics only; candidate strings stay in memory and never enter logs or artifacts.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseAppManifest } from '../nexus/apps/app-contract.js';

type CaseKind = 'secret' | 'benign' | 'reference' | 'boundary-secret' | 'boundary-benign' | 'actual-fixture' | 'legacy-prefix-reference';

interface CorpusCase {
  readonly id: string;
  readonly value: string;
  readonly kind: CaseKind;
}

export interface AppContractCredentialObservation {
  readonly id: string;
  readonly kind: CaseKind;
  readonly secretDetected: boolean;
  readonly validReferenceAccepted: boolean;
  readonly diagnosticLeaksValue: boolean;
  readonly benignRejectionExpected: boolean;
}

export interface AppContractCredentialCorpusResult {
  readonly observations: readonly AppContractCredentialObservation[];
  readonly secretCount: number;
  readonly truePositives: number;
  readonly falseNegatives: number;
  readonly benignCount: number;
  readonly falsePositives: number;
  readonly trueNegatives: number;
  readonly falsePositiveRate: number;
  readonly referenceCount: number;
  readonly acceptedReferences: number;
  readonly actualFixtureCount: number;
  readonly actualFixtureFalsePositives: number;
  readonly actualFixtureFalsePositiveRate: number;
  readonly actualFixturesAccepted: number;
}

const manifestFor = (value: string) => `apiVersion: elanous.app/v0
slug: credential-fixture
title: Credential classifier fixture
frontend: { kind: static-export }
credentials:
  - ${JSON.stringify(value)}
`;

function digest(seed: string): string {
  return createHash('sha256').update(seed).digest('hex');
}

function syntheticSecret(seed: string): string {
  const first = createHash('sha256').update(seed).digest('base64url');
  const second = createHash('sha256').update(`${seed}:tail`).digest('base64url');
  return `${first}${second.slice(0, 24)}`;
}

function symbolsByCounts(counts: readonly number[]): string {
  return counts.map((count, index) => String.fromCharCode(33 + index).repeat(count)).join('');
}

function actualFixtureCases(): CorpusCase[] {
  const root = resolve(import.meta.dir, '../..');
  const fixtureTest = readFileSync(resolve(root, 'src/nexus/apps/app-contract.test.ts'), 'utf8');
  const validYaml = fixtureTest.match(/const validYaml = `([\s\S]*?)`;/)?.[1];
  if (!validYaml) throw new Error('app contract test credential fixture is missing');
  const fixtures = [
    ['voice-note-template', readFileSync(resolve(root, 'templates/next-app-voice-note/app.yaml'), 'utf8')],
    ['translator-template', readFileSync(resolve(root, 'templates/next-app-translator/app.yaml'), 'utf8')],
    ['app-contract-test', validYaml],
  ] as const;
  return fixtures.flatMap(([sourceId, source]) => {
    const parsed = parseAppManifest(source);
    if (!parsed.ok) throw new Error(`actual credential fixture is invalid: ${sourceId}`);
    const credentials = parsed.manifest.credentials;
    if (!Array.isArray(credentials)) throw new Error(`actual credential fixture has no credentials list: ${sourceId}`);
    return credentials.map((value, index): CorpusCase => {
      if (typeof value !== 'string') throw new Error(`actual credential fixture entry is not text: ${sourceId}/${index + 1}`);
      return { id: `actual-${sourceId}-${index + 1}`, value, kind: 'actual-fixture' };
    });
  });
}

function corpus(): CorpusCase[] {
  const secretCases = Array.from({ length: 32 }, (_, index): CorpusCase => ({
    id: `synthetic-token-${index + 1}`,
    value: syntheticSecret(`app-contract-secret-corpus-${index + 1}`),
    kind: 'secret',
  }));
  const benignLabels: CorpusCase[] = [
    'raw-value', 'api-key-not-a-secret', 'catalog fixture', 'public config string',
    'field-name', 'not-a-secret', 'use-env-var', 'needs-cred-reference',
  ].map((value, index) => ({ id: `benign-label-${index + 1}`, value, kind: 'benign' }));
  const hashes = Array.from({ length: 20 }, (_, index): CorpusCase => ({
    id: `benign-sha256-${index + 1}`,
    value: `sha256:${digest(`app-contract-public-hash-${index + 1}`)}`,
    kind: 'benign',
  }));
  const ids = Array.from({ length: 20 }, (_, index): CorpusCase => {
    const hex = digest(`app-contract-public-id-${index + 1}`);
    return {
      id: `benign-uuid-${index + 1}`,
      value: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`,
      kind: 'benign',
    };
  });
  const references = Array.from({ length: 12 }, (_, index): CorpusCase => ({
    id: `valid-reference-${index + 1}`,
    value: `cred:provider.secret_${index + 1}`,
    kind: 'reference',
  }));
  const boundaries: CorpusCase[] = [
    { id: 'boundary-length-31-high-entropy', value: symbolsByCounts(Array.from({ length: 31 }, () => 1)), kind: 'boundary-benign' },
    { id: 'boundary-length-32-low-entropy', value: 'a'.repeat(32), kind: 'boundary-benign' },
    { id: 'boundary-entropy-4.1875', value: symbolsByCounts([...Array(13).fill(2), ...Array(6).fill(1)]), kind: 'boundary-benign' },
    { id: 'boundary-entropy-4.25', value: symbolsByCounts([...Array(12).fill(2), ...Array(8).fill(1)]), kind: 'boundary-secret' },
    { id: 'boundary-long-valid-reference', value: 'cred:provider.abcdefghijklmnopqrstuvwxyz_123456', kind: 'reference' },
    { id: 'legacy-prefix-reference-remains-rejected', value: 'cred:provider.github_pat_foo', kind: 'legacy-prefix-reference' },
  ];
  return [...secretCases, ...benignLabels, ...hashes, ...ids, ...references, ...boundaries, ...actualFixtureCases()];
}

/** Runs the synthetic corpus against parseAppManifest; observations never contain candidate values. */
export function runAppContractCredentialCorpus(): AppContractCredentialCorpusResult {
  const observations = corpus().map(({ id, value, kind }): AppContractCredentialObservation => {
    const result = parseAppManifest(manifestFor(value));
    const issue = result.ok ? undefined : result.errors.find((candidate) => candidate.path === '/credentials/0');
    const diagnostic = issue?.reason ?? '';
    return {
      id,
      kind,
      secretDetected: diagnostic.includes('자격 값은 app.yaml 에 넣을 수 없다'),
      validReferenceAccepted: (kind === 'reference' || kind === 'actual-fixture') && result.ok,
      diagnosticLeaksValue: !result.ok && result.errors.some(({ path, reason }) => path.includes(value) || reason.includes(value)),
      benignRejectionExpected: kind === 'benign' || kind === 'boundary-benign'
        ? issue?.reason === '자격은 cred:<슬롯> 이름이어야 한다'
        : true,
    };
  });
  const secrets = observations.filter((observation) => observation.kind === 'secret');
  const benign = observations.filter((observation) => observation.kind === 'benign');
  const references = observations.filter((observation) => observation.kind === 'reference');
  const actualFixtures = observations.filter((observation) => observation.kind === 'actual-fixture');
  const truePositives = secrets.filter((observation) => observation.secretDetected).length;
  const falsePositives = benign.filter((observation) => observation.secretDetected).length;
  return {
    observations,
    secretCount: secrets.length,
    truePositives,
    falseNegatives: secrets.length - truePositives,
    benignCount: benign.length,
    falsePositives,
    trueNegatives: benign.length - falsePositives,
    falsePositiveRate: benign.length === 0 ? 0 : falsePositives / benign.length,
    referenceCount: references.length,
    acceptedReferences: references.filter((observation) => observation.validReferenceAccepted).length,
    actualFixtureCount: actualFixtures.length,
    actualFixtureFalsePositives: actualFixtures.filter((observation) => observation.secretDetected).length,
    actualFixtureFalsePositiveRate: actualFixtures.length === 0 ? 0 : actualFixtures.filter((observation) => observation.secretDetected).length / actualFixtures.length,
    actualFixturesAccepted: actualFixtures.filter((observation) => observation.validReferenceAccepted).length,
  };
}
