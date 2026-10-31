import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import { loadGraphProfiles, parseGraphProfileYaml, selectGraphProfiles } from './graph-profile-yaml.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test('profile parser accepts deterministic state bundles and overlay references', () => {
  expect(parseGraphProfileYaml('profile_id: pod-docs-only\napplies_when: docs_only == true\nstate: { review_depth: light }\noverlays: [review-light]'))
    .toMatchObject({ profile: { profileId: 'pod-docs-only', appliesWhen: 'docs_only == true', state: { review_depth: 'light' }, overlays: ['review-light'] }, errors: [] });
});

test('profile parser rejects expression syntax, non-scalar state, and duplicate overlays', () => {
  const parsed = parseGraphProfileYaml('profile_id: bad\napplies_when: docs_only == true && substrate == pod\nstate: { nested: { x: y } }\noverlays: [x, x]');
  expect(parsed.profile).toBeUndefined();
  expect(parsed.errors.map(({ path }) => path)).toEqual(['<inline>/applies_when', '<inline>/state/nested', '<inline>/overlays']);
});

test('profile loader rejects duplicate ids and selection rejects conflicting state without partial application', () => {
  const dir = mkdtempSync(join(tmpdir(), 'graph-profile-')); dirs.push(dir); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'a.yaml'), 'profile_id: local\napplies_when: substrate == pod\nstate: { review_depth: light }\noverlays: []');
  writeFileSync(join(dir, 'b.yaml'), 'profile_id: pod\napplies_when: substrate == pod\nstate: { review_depth: deep }\noverlays: []');
  const loaded = loadGraphProfiles(dir);
  expect(loaded.errors).toEqual([]);
  expect(selectGraphProfiles(loaded.profiles, { substrate: 'pod' })).toMatchObject({ applied: [], errors: ['profile state conflict: review_depth (light vs deep)'], state: { substrate: 'pod' } });
});
