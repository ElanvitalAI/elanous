import { expect, test } from 'bun:test';
import type { LLMToolRouteMetadata, LLMToolSpec } from '../llm/tool-spec.js';
import { withCapabilityDiscoveryDescription } from '../plugins/core/capability-discovery.js';
import { HYDRATED_TOOLS_KEY } from '../skills/tools/tool-search-spec.js';
import { dispatchToolByName, registerToolRuntime } from './registry.js';
import { capabilitySearchRuntime, toolSearchRuntime, type ToolSearchRunResult } from './tool-search-runtime.js';
import type { ToolRuntimeContext } from './types.js';

const gcpArchitectRoute: LLMToolRouteMetadata = {
  triggers: ['GCP 확장안', '용량 부족', '클라우드 확장'],
  examples: ['용량이 부족한데 GCP 확장안을 제안해줘'],
  sideEffects: 'external',
  risk: 'high',
  cost: 'spends-cloud',
  requiresConfirm: true,
};

const gcpArchitectSpec: LLMToolSpec = {
  name: 'gcp_architect_expand',
  description: '용량 부족을 분석해 GCP 확장안을 제안합니다.',
  parameters: { type: 'object', properties: { ticketDesignPath: { type: 'string' } } },
  pluginId: 'gcp-architect-expand',
  route: gcpArchitectRoute,
};

test('classic ToolSearch dispatch searches and hydrates route tools from the current surface pool', async () => {
  registerToolRuntime(toolSearchRuntime);
  const context: ToolRuntimeContext = { surface: 'tui', surfaceSpecs: [gcpArchitectSpec] };

  const result = await dispatchToolByName('tool_search', { query: 'route:용량 부족 GCP 확장안' }, context) as ToolSearchRunResult;

  expect(result.matched).toEqual(['gcp_architect_expand']);
  expect(result.unknown).toEqual([]);
  expect(result[HYDRATED_TOOLS_KEY]).toEqual([gcpArchitectSpec]);
});

test('capability_search has no global fallback beyond the dispatching surface catalog', async () => {
  registerToolRuntime(capabilitySearchRuntime);
  const absent = await capabilitySearchRuntime.run({ query: 'select:gcp_architect_expand' }, { surface: 'tui' });
  expect(absent.matched).toEqual([]);
  expect(absent[HYDRATED_TOOLS_KEY]).toBeUndefined();
});

test('general discovery ignores request wording without penalizing unmatched project constraints', async () => {
  const spec = { name: 'FixtureLookup', description: 'please use shared lookup', parameters: { type: 'object' } };
  const ctx: ToolRuntimeContext = { surface: 'tui', surfaceSpecs: [spec] };
  const query = { query: 'unrelated alpha beta please' };
  expect((await capabilitySearchRuntime.run(query, ctx)).matched).toEqual([]);
  expect((await toolSearchRuntime.run(query, ctx)).matched).toEqual(['FixtureLookup']);
  expect((await capabilitySearchRuntime.run({ query: 'shared lookup' }, ctx)).matched).toEqual(['FixtureLookup']);
  expect((await capabilitySearchRuntime.run({ query: 'Quartz private staging environment unfamiliar constraints lookup' }, ctx)).matched)
    .toEqual(['FixtureLookup']);
  expect((await capabilitySearchRuntime.run({ query: 'select:FixtureLookup' }, ctx)).matched).toEqual(['FixtureLookup']);
});

test('schema and prerequisites alone cannot supply multi-term discovery intent', async () => {
  const spec = { name: 'FixtureLookup', parameters: { type: 'object' },
    description: withCapabilityDiscoveryDescription('Read useful widgets.', {
      whenToUse: 'Look up a genuine widget.', inputs: { query: 'quasar schema-only label' },
      outputs: { value: 'widget result' }, examples: ['Look up widgets.'], requires: { memberConnection: true },
    }) };
  const context: ToolRuntimeContext = { surface: 'tui', surfaceSpecs: [spec] };
  expect((await capabilitySearchRuntime.run({ query: 'quasar memberconnection' }, context)).matched).toEqual([]);
  expect((await capabilitySearchRuntime.run({ query: 'genuine widget' }, context)).matched).toEqual(['FixtureLookup']);
});

test('app subject discovery coexists with a different tool matching longer project terms', async () => {
  const app = { name: 'FixtureAppBuilder', description: '앱 생성과 실행', parameters: { type: 'object' } };
  const booking = { name: 'FixtureBookingLookup', description: '병원 예약 조회', parameters: { type: 'object' } };
  for (const surfaceSpecs of [[app, booking], [booking, app]]) {
    const ctx: ToolRuntimeContext = { surface: 'tui', surfaceSpecs };
    const result = await capabilitySearchRuntime.run({ query: '병원 예약 앱 만들어줘' }, ctx);
    expect(result.matched).toContain(app.name);
    expect(result.matched).toContain(booking.name);
    const status = await capabilitySearchRuntime.run({ query: '병원 예약 상태 조회' }, ctx);
    expect(status.matched).toContain(booking.name);
    expect(status.matched).not.toContain(app.name);
  }
});

test('one-character subjects exclude incidental later capability mentions', async () => {
  const unrelated = {
    name: 'FixtureScrap', parameters: { type: 'object' },
    description: withCapabilityDiscoveryDescription('Save member links', {
      whenToUse: '회원 링크를 저장한다. 앱 생성과 게시를 별도로 확인한다.',
      examples: ['앱 구현 배포 전에 링크를 저장해줘'],
    } as Parameters<typeof withCapabilityDiscoveryDescription>[1]),
  };
  const app = { name: 'FixtureApp', description: '앱 생성과 실행', parameters: { type: 'object' } };
  const result = await capabilitySearchRuntime.run({ query: '병원 예약 앱 만들어줘' },
    { surface: 'tui', surfaceSpecs: [unrelated, app] });
  expect(result.matched).toEqual([app.name]);
});

test('particle normalization preserves a complete multi-character capability subject', async () => {
  const hospital = { name: 'FixtureHospital', description: '병원을 설계하고 운영한다', parameters: { type: 'object' } };
  const oneChar = { name: 'FixtureOther', description: '원 생성', parameters: { type: 'object' } };
  const result = await capabilitySearchRuntime.run({ query: '병원을 만들어줘' },
    { surface: 'tui', surfaceSpecs: [hospital, oneChar] });
  expect(result.matched).toContain(hospital.name);
  expect(result.matched).not.toContain(oneChar.name);
});
