import type { SimWorldApp } from './world-schema.js';

export type FakeAppFailureStage = 'build' | 'deploy' | 'runtime';
export type FakeAppFailureClassification = 'known' | 'unknown';

export interface FakeAppFailure {
  readonly id: string;
  readonly appId: string;
  readonly appVersion: string;
  readonly stage: FakeAppFailureStage;
  readonly connector: string;
  readonly errorCode: string;
  readonly classification: FakeAppFailureClassification;
}

export interface FakeAppFailuresDevice {
  inject(): readonly FakeAppFailure[];
}

interface FailureFixture {
  readonly id: string;
  readonly stage: FakeAppFailureStage;
  readonly connector: string;
  readonly errorCode: string;
  readonly classification: FakeAppFailureClassification;
}

const FAILURE_FIXTURES: readonly FailureFixture[] = Object.freeze([
  { id: 'static-artifact-missing', stage: 'build', connector: 'static-export', errorCode: 'artifact-missing', classification: 'known' },
  { id: 'app-contract-invalid', stage: 'build', connector: 'app-contract', errorCode: 'contract-invalid', classification: 'known' },
  { id: 'publish-gate-rejected', stage: 'deploy', connector: 'app-publisher', errorCode: 'gate-rejected', classification: 'known' },
  { id: 'certificate-issuance-failed', stage: 'deploy', connector: 'certificate-issuer', errorCode: 'certificate-failed', classification: 'known' },
  { id: 'relay-disconnected', stage: 'deploy', connector: 'app-relay', errorCode: 'relay-disconnected', classification: 'known' },
  // Source: 내부 문서 `app-dev-observe-heal` §7 (repeated 5xx runtime failures).
  { id: 'runtime-server-errors', stage: 'runtime', connector: 'app-runtime', errorCode: 'http-5xx-repeat', classification: 'known' },
  { id: 'runtime-slow-request', stage: 'runtime', connector: 'app-runtime', errorCode: 'slow-request', classification: 'known' },
  // Source: 내부 문서 `app-dev-observe-heal` §7 (credential 401).
  { id: 'runtime-credential-rejected', stage: 'runtime', connector: 'app-auth', errorCode: 'credential-401', classification: 'known' },
  { id: 'runtime-canary-hit', stage: 'runtime', connector: 'app-canary', errorCode: 'canary-hit', classification: 'known' },
  { id: 'unknown-build-hook-shape', stage: 'build', connector: 'build-hook', errorCode: 'unrecognized-hook-result', classification: 'unknown' },
]);

/** Fixed, network-free failure injections tied to each declared app's active world version. */
export function createFakeAppFailures(apps: readonly SimWorldApp[]): FakeAppFailuresDevice {
  const targets = apps.map((app) => {
    const version = app.current ?? app.versions[0]?.id;
    if (!version || !app.versions.some(({ id }) => id === version)) {
      throw new Error(`fake app failure device requires a declared app version: ${app.slug}`);
    }
    return { appId: app.slug, appVersion: version };
  });
  if (targets.length === 0) throw new Error('fake app failure device requires a declared app');

  const fixtures = targets.flatMap((target) => FAILURE_FIXTURES.map((fixture) => Object.freeze({
    ...fixture,
    ...target,
    id: `${target.appId}:${fixture.id}`,
  })));
  const frozenFixtures = Object.freeze(fixtures);
  return Object.freeze({
    inject: () => frozenFixtures,
  });
}
