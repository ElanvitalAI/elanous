// W9d-FU · http-server router dispatch wire — 11 cascade-zyu endpoints.
//
// Verifies that the dispatch blocks added in http-server.ts forward to
// the right handler when opts.<field> is wired, and return a 503
// `<name>-not-wired` envelope when undefined. Tests bypass the full
// `startNexusHttpServer` and exercise the import surface via
// `feedback_source_level_grep_test_value` pattern — the path strings +
// 503 envelope strings stay frozen.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { startNexusHttpServer } from '../../../src/nexus/api/http-server.js';
import { NexusEventBus } from '../../../src/nexus/api/event-bus.js';
import { createNexusState } from '../../../src/nexus/state/state.js';
import { TabRegistry } from '../../../src/nexus/state/tab-registry.js';
import { staticDeviceFleetSource } from '../../../src/mission-templates/device-detector.js';

const HERE = dirname(fileURLToPath(import.meta.url));

function makeHttpFixture() {
  const bus = new NexusEventBus();
  const state = createNexusState({ nexusVersion: 'test', phase: 'cascade-dispatch' });
  state.bus = bus;
  return { state, registry: new TabRegistry(state), bus };
}

async function uniquePort(): Promise<number> {
  return 45000 + Math.floor(Math.random() * 2000);
}
const HTTP_SERVER_PATH = resolve(HERE, '..', '..', '..', 'src', 'nexus', 'api', 'http-server.ts');
const SOURCE = readFileSync(HTTP_SERVER_PATH, 'utf8');

describe('http-server imports cascade-zyu handlers', () => {
  test.each([
    ['approval-showroom', 'handleApprovalShowroom'],
    ['approval-showroom', 'parseApprovalShowroomPath'],
    ['workflow-design',   'handleWorkflowDesign'],
    ['workflow-design',   'parseWorkflowDesignPath'],
    ['mission-showroom',  'handleMissionShowroom'],
    ['mission-showroom',  'parseMissionShowroomPath'],
    ['devices',           'handleDevices'],
    ['devices',           'handleTemplateCapabilityPreview'],
    ['devices',           'isDevicesPath'],
    ['devices',           'isTemplateCapabilityPreviewPath'],
    ['next-fluent',       'handleNextFluentPreview'],
    ['next-fluent',       'isNextFluentPreviewPath'],
    ['morning-showroom',  'handleMorningShowroom'],
    ['morning-showroom',  'isMorningShowroomPath'],
    ['idle-nudge',        'handleIdleNudge'],
    ['idle-nudge',        'isIdleNudgePath'],
  ])('imports %s/%s', (module, symbol) => {
    expect(SOURCE).toContain(symbol);
    expect(SOURCE).toContain(`from './${module}.js'`);
  });
});

describe('http-server NexusHttpServerOpts fields', () => {
  test.each([
    'approvalShowroom?: ApprovalShowroomRouteOpts',
    'workflowDesign?: WorkflowDesignRouteOpts',
    'missionShowroom?: MissionShowroomRouteOpts',
    'devices?: DevicesRouteOpts',
    'nextFluent?: NextFluentRouteOpts',
    'morningShowroom?: MorningShowroomRouteOpts',
    'idleNudge?: IdleNudgeRouteOpts',
  ])('declares %s', (field) => {
    expect(SOURCE).toContain(field);
  });
});

describe('http-server dispatch · 503 envelope strings frozen', () => {
  test.each([
    'approval-showroom-not-wired',
    'workflow-design-not-wired',
    'mission-showroom-not-wired',
    'devices-not-wired',
    'next-fluent-not-wired',
    'morning-showroom-not-wired',
    'idle-nudge-not-wired',
  ])('emits %s on undefined opts', (envelope) => {
    expect(SOURCE).toContain(envelope);
  });
});

describe('http-server dispatch · GET /v1/devices through fetch', () => {
  test('wired devices route reaches the existing GET handler', async () => {
    const fixture = makeHttpFixture();
    const server = startNexusHttpServer({
      ...fixture,
      eventBus: fixture.bus,
      startPort: await uniquePort(),
      metaApi: { bearerToken: 'test-token', noAuth: false },
      devices: {
        fleetSource: staticDeviceFleetSource([]),
      },
    });
    try {
      const response = await fetch(`${server.url}/v1/devices`, {
        headers: { authorization: 'Bearer test-token' },
      });
      expect(response.status).toBe(200);
      expect(response.status).not.toBe(404);
      expect(response.status).not.toBe(405);
      await expect(response.json()).resolves.toMatchObject({ totalDevices: 0, kinds: [] });
    } finally {
      server.stop();
    }
  });

  test('without metaApi, devices route is denied before reaching its handler', async () => {
    const fixture = makeHttpFixture();
    const server = startNexusHttpServer({
      ...fixture, eventBus: fixture.bus, startPort: await uniquePort(),
    });
    try {
      const response = await fetch(`${server.url}/v1/devices`);
      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({ error: 'unauthorized' });
    } finally { server.stop(); }
  });

  test('unwired devices route preserves the 503 not-wired response', async () => {
    const fixture = makeHttpFixture();
    const server = startNexusHttpServer({
      ...fixture,
      eventBus: fixture.bus,
      startPort: await uniquePort(),
      metaApi: { bearerToken: 'test-token', noAuth: false },
    });
    try {
      const response = await fetch(`${server.url}/v1/devices`, {
        headers: { authorization: 'Bearer test-token' },
      });
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({ error: 'devices-not-wired' });
    } finally {
      server.stop();
    }
  });
});

describe('http-server dispatch · pathname match wiring', () => {
  test('approval showroom dispatch is gated by parseApprovalShowroomPath', () => {
    expect(SOURCE).toMatch(/const approvalRunId = parseApprovalShowroomPath\(pathname\);/);
  });
  test('workflow design dispatch is gated by parseWorkflowDesignPath', () => {
    expect(SOURCE).toMatch(/const workflowDesignName = parseWorkflowDesignPath\(pathname\);/);
  });
  test('mission showroom dispatch is gated by parseMissionShowroomPath', () => {
    expect(SOURCE).toMatch(/const missionShowroomRoute = parseMissionShowroomPath\(pathname\);/);
  });
  test('devices + template-capability-preview share opts.devices', () => {
    expect(SOURCE).toMatch(/isDevicesPath\(pathname\)/);
    expect(SOURCE).toMatch(/isTemplateCapabilityPreviewPath\(pathname\)/);
    // Both blocks fall back to the same opts field
    const occurrences = SOURCE.match(/devices-not-wired/g) ?? [];
    expect(occurrences.length).toBe(2);
  });
  test('next-fluent / morning / idle-nudge use isPath matchers', () => {
    expect(SOURCE).toMatch(/isNextFluentPreviewPath\(pathname\)/);
    expect(SOURCE).toMatch(/isMorningShowroomPath\(pathname\)/);
    expect(SOURCE).toMatch(/isIdleNudgePath\(pathname\)/);
  });
});
