import { describe, expect, test } from 'bun:test';
import { parseWorkspaceConfig } from './workspace-config.js';
import { workspacePlan } from './workspace-plan.js';

describe('workspace declaration', () => {
  const text = `version: 1\nroles:\n  lead: { capabilities: [coordinate, review] }\nseats:\n  OP: { role: lead }\n  API: { capabilities: [build-ts] }\nspaces:\n  shop: { coordinator: OP, seats: [API] }\n`;
  test('yaml and JSON parse, defaults and role override', () => {
    const parsed = parseWorkspaceConfig(text, '/tmp/shop/.elanous/workspace.yaml');
    expect(parsed.errors).toEqual([]);
    expect(parsed.config!.seats.OP!.capabilities).toEqual(['coordinate', 'review']);
    expect(parsed.config!.seats.API!.cwd).toBe('/tmp/shop/seats/API');
    expect(parseWorkspaceConfig(JSON.stringify({version:1,seats:{OP:{capabilities:['coordinate']}},spaces:{shop:{coordinator:'OP'}}}), '/tmp/shop/.elanous/workspace.json').errors).toEqual([]);
  });
  test('refuses unknown keys, secrets, disallowed remote', () => {
    const bad = parseWorkspaceConfig('version: 1\nhosts: { node-b: { ssh: node-b } }\nseats: { OP: { host: node-b, password: hi, runtme: eln } }\n', '/tmp/workspace.yaml');
    expect(bad.config).toBeUndefined();
    expect(bad.errors.join('\n')).toContain('unknown key "runtme"');
    expect(bad.errors.join('\n')).toContain('looks like a secret');
    expect(bad.errors.join('\n')).toContain('remote.allowed is false');
  });
  test('plan reports unlisted and never closes', () => {
    const cfg = parseWorkspaceConfig(text, '/tmp/shop/.elanous/workspace.yaml').config!;
    const plan = workspacePlan(cfg, {workspaces: [], tabs: [], panes: [{tab:'t1',title:'stranger'}]});
    expect(plan).toEqual(['+ open seat OP in space shop (eln · local)', '+ open seat API in space shop (eln · local)', '* coordinator shop = OP', '? unlisted stranger (t1) — left open']);
  });
});


test('repeated keys report the actual mapping line in YAML and JSON', () => {
  const yaml = 'version: 1\nseats:\n  A:\n    runtime: eln\n  B:\n    runtime: wrong\n    runtme: eln\n';
  const result = parseWorkspaceConfig(yaml, '/tmp/federation.yaml');
  expect(result.errors).toContain('error: seats.B.runtime must be one of eln, codex, claude, grok, shell (/tmp/federation.yaml:6)');
  expect(result.errors).toContain('error: unknown key "runtme" in seats.B (/tmp/federation.yaml:7)');
  const json = '{\n "version": 1,\n "seats": {\n "A": {"runtme": "eln"},\n "B": {"runtme": "eln"}\n }\n}';
  expect(parseWorkspaceConfig(json, '/tmp/federation.json').errors).toContain('error: unknown key "runtme" in seats.B (/tmp/federation.json:5)');
});

test('role and tag select a unique coordinator with reserved sections', () => {
  const declaration = `version: 1
hq: {}
grids: {}
seats:
  OP: { role: lead, tags: [main] }
  TC: { role: lead, tags: [other] }
spaces:
  HQ: { coordinator: { role: lead, tag: main }, seats: [TC] }
`;
  const result = parseWorkspaceConfig(declaration, '/tmp/federation.yaml');
  expect(result.errors).toEqual([]);
  expect(result.config!.spaces.HQ!.coordinator).toBe('OP');
  expect(parseWorkspaceConfig(declaration.replace('tag: main', 'tag: missing'), '/tmp/federation.yaml').errors.join('\n')).toContain('selector must match exactly one seat');
});

test('real ls shape: matching seat, coordinator and unlisted pane in the same tab', () => {
  const cfg = parseWorkspaceConfig(`version: 1
seats:
  OP: { role: lead }
spaces:
  HQ: { coordinator: OP }
`, '/tmp/federation.yaml').config!;
  const plan = workspacePlan(cfg, { workspaces: [{id: 'w1', name: 'HQ', coordinatorSeat: 'OP'}], tabs: [{id:'t1', workspaceId:'w1',label:'OP'}], panes: [{tab:'t1',pane:'p1',title:'OP',seat:'OP'}, {tab:'t1',pane:'p2',title:'extra',seat:null}] });
  expect(plan).toEqual(['= ok OP in HQ', '? unlisted extra (p2) — left open']);
});
