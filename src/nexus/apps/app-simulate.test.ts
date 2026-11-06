import { describe, expect, test } from 'bun:test';
import { parseAppManifest } from './app-contract.js';
import { APP_SIMULATION_DEVICES, validateAppSimulation } from './app-simulate.js';

const appYaml = `apiVersion: elanous.app/v0
slug: voice-note
title: Voice notes
frontend: { kind: static-export }
tables: { notes: {} }
roles: { owner: { via: nexus-session } }
rpc:
  addNote: { sql: INSERT INTO notes (id) VALUES (:id), params: { id: { type: text } }, allow: [owner] }
actions:
  makeAd: { builtin: generate, async: true, spend: owner-confirm, uses: [cred:higgsfield.secret] }
storage: { prefix: apps/voice-note/ }
simulate:
  seed: 7
  clock: { start: 2026-11-05T09:00:00+09:00, speed: 60 }
  connectors:
    makeAd: { fake: generate-job, profile: slow-then-ok }
    payment: { fake: payment }
  scenarios:
    - name: retry payment
      steps:
        - { rpc: addNote, as: owner }
        - { inject: payment.declined, at: +1m }
      expect:
        - { table: notes, rows: 1 }
        - { event: payment.retry-scheduled }
`;

describe('SIMKIT-APP-YAML-SIMULATE', () => {
  test('accepts the declared app simulation contract through the production app manifest parser', () => {
    const result = parseAppManifest(appYaml);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest.simulate).toMatchObject({ seed: 7 });
  });

  test('rejects undeclared connectors, internal or unknown fakes, profiles, and injected events', () => {
    const base = {
      connectors: { makeAd: { fake: 'generate-job', profile: 'slow-then-ok' } },
      scenarios: [{ name: 'one', steps: [{ inject: 'generate-job.failed' }], expect: [{ 'screen-text': 'Done' }] }],
    };
    expect(validateAppSimulation(base, { actions: ['makeAd'] })).toEqual([]);
    expect(validateAppSimulation({ ...base, connectors: { shell: { fake: 'fake-bin' } } }, { actions: ['makeAd'] }).map(x => x.reason))
      .toContain('계약에 선언된 동작·storage·auth·payment 커넥터여야 한다');
    expect(validateAppSimulation({ ...base, connectors: { makeAd: { fake: 'fake-land-queue' } } }, { actions: ['makeAd'] }).map(x => x.path))
      .toContain('/simulate/connectors/@entry:0/fake');
    expect(validateAppSimulation({ ...base, connectors: { makeAd: { fake: 'generate-job', profile: 'unlisted' } } }, { actions: ['makeAd'] }).map(x => x.path))
      .toContain('/simulate/connectors/@entry:0/profile');
    expect(validateAppSimulation({ ...base, scenarios: [{ ...base.scenarios[0], steps: [{ inject: 'generate-job.not-declared' }] }] }, { actions: ['makeAd'] }).map(x => x.path))
      .toContain('/simulate/scenarios/0/steps/0/inject');
  });

  test('checks contract references, expectations, and deterministic clock shape', () => {
    const errors = validateAppSimulation({
      seed: -1,
      clock: { start: 'not-a-time', speed: 0 },
      connectors: { makeAd: { fake: 'generate-job' } },
      scenarios: [{ name: 'bad', steps: [{ action: 'missing', as: 'admin' }], expect: [{ table: 'outside', rows: -1 }] }],
    }, { actions: ['makeAd'], roles: ['owner'], tables: ['notes'] });
    expect(errors.map(x => x.path)).toEqual(expect.arrayContaining([
      '/simulate/seed', '/simulate/clock', '/simulate/scenarios/0/steps/0/action',
      '/simulate/scenarios/0/steps/0/as', '/simulate/scenarios/0/expect/0',
    ]));
  });

  test('rejects credentials, URLs, and account fields without echoing supplied values', () => {
    const secret = 'sk-private-should-not-appear';
    const result = validateAppSimulation({ connectors: { payment: { fake: 'payment', apiKey: secret } }, note: 'https://example.invalid' });
    expect(result.length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.some(item => item.path.startsWith('/simulate/connectors/@entry:0'))).toBe(true);
    expect(Object.keys(APP_SIMULATION_DEVICES)).not.toContain('fake-land-queue');
  });

  test('treats inherited device names as unknown and never throws from the production parser', () => {
    const source = appYaml.replace('fake: generate-job, profile: slow-then-ok', 'fake: constructor, profile: anything');
    expect(() => parseAppManifest(source)).not.toThrow();
    const result = parseAppManifest(source);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some(x => x.path.endsWith('/fake'))).toBe(true);
  });

  test('validates table expectations independent of YAML key order and rejects undeclared tables', () => {
    const malformed = appYaml.replace('{ table: notes, rows: 1 }', '{ rows: anything, table: 123 }');
    const malformedResult = parseAppManifest(malformed);
    expect(malformedResult.ok).toBe(false);
    if (!malformedResult.ok) expect(malformedResult.errors.some(x => x.path === '/simulate/scenarios/0/expect/0')).toBe(true);

    const undeclared = appYaml.replace('tables: { notes: {} }', 'tables: {}');
    const undeclaredResult = parseAppManifest(undeclared);
    expect(undeclaredResult.ok).toBe(false);
    if (!undeclaredResult.ok) expect(undeclaredResult.errors.some(x => x.path === '/simulate/scenarios/0/expect/0/table')).toBe(true);
  });

  test('rejects embedded URLs and timezone-less clocks through the production parser', () => {
    const withUrl = appYaml.replace('event: payment.retry-scheduled', 'screen-text: "visit https://example.invalid"');
    const urlResult = parseAppManifest(withUrl);
    expect(urlResult.ok).toBe(false);
    if (!urlResult.ok) expect(JSON.stringify(urlResult.errors)).not.toContain('example.invalid');

    const localClock = appYaml.replace('2026-11-05T09:00:00+09:00', '2026-11-05T09:00:00');
    const clockResult = parseAppManifest(localClock);
    expect(clockResult.ok).toBe(false);
    if (!clockResult.ok) expect(clockResult.errors.some(x => x.path === '/simulate/clock')).toBe(true);
  });

  test('accepts an omitted optional simulation block and rejects malformed containers', () => {
    expect(parseAppManifest(appYaml.replace(/simulate:[\s\S]*$/, '')).ok).toBe(true);
    const malformed = parseAppManifest(`${appYaml.split('simulate:')[0]}simulate: []\n`);
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.errors.some(x => x.path === '/simulate')).toBe(true);
  });
});
