import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'bun:test';
import * as EntranceRegistryModule from './entrance-registry.js';
import {
  CLI_DEV_ASK_ENTRANCE,
  CLI_HARNESS_ASK_ENTRANCE,
  CLI_HARNESS_SAY_ENTRANCE,
  describeEntranceCommand,
  deriveEntranceStampability,
  ENTRANCE_EXPORT_IDENTIFIER_EVIDENCE,
  type EntranceDeclaration,
  type EntranceId,
  retiredEntranceDescriptionPrefix,
  CLI_HARNESS_ORCHESTRATE_ENTRANCE,
  CLI_HARNESS_PLAN_ENTRANCE,
  CLI_HARNESS_RUN_ENTRANCE,
  ENTRANCE_REGISTRY,
  listEntrancesWithModelExposure,
  lookupEntrance,
  renderLaunchEntrances,
  retiredEntranceNotice,
  summarizeEntrances,
  TUI_SLASH_ASK_ENTRANCE,
  DAEMON_HARNESS_ASK_ENTRANCE,
} from './entrance-registry.js';

const sourceText = (relativePath: string): string => readFileSync(
  fileURLToPath(new URL(relativePath, import.meta.url)),
  'utf8',
);

const exportedConstNames = (relativePath: string): Set<string> => new Set(
  [...sourceText(relativePath).matchAll(/export\s+const\s+(\w+)/g)].map((match) => match[1] as string),
);

const registryExports = exportedConstNames('./entrance-registry.ts');
const selfImplementNameExports = exportedConstNames('../boot/daemon-tools/self-implement-names.ts');
const unknownVerification = { actualMission: 'unknown', legacyParity: 'unknown' } as const;

test('declares live shared ask-flow entrances, live harness ask/say/orchestrate/plan, and the RFC-retired harness run entrance', () => {
  expect(CLI_DEV_ASK_ENTRANCE).toEqual({ id: 'cli-dev-ask', surface: 'cli', status: 'closed', stampability: 'stampable', stampabilityEvidenceFilePath: 'src/self-dev/entrance-registry.ts', verification: { actualMission: 'verified', legacyParity: 'unknown' } });
  expect(TUI_SLASH_ASK_ENTRANCE).toEqual({ id: 'tui-slash-ask', surface: 'slash', status: 'live', stampability: 'stampable', stampabilityEvidenceFilePath: 'src/self-dev/entrance-registry.ts', verification: { actualMission: 'verified', legacyParity: 'verified' } });
  expect(CLI_HARNESS_RUN_ENTRANCE).toEqual({ id: 'cli-harness-run', surface: 'cli', status: 'retired', stampability: 'stampable', stampabilityEvidenceFilePath: 'src/self-dev/entrance-registry.ts', verification: unknownVerification });
  expect(DAEMON_HARNESS_ASK_ENTRANCE).toEqual({ id: 'daemon-harness-ask', surface: 'daemon', status: 'live', stampability: 'stampable', stampabilityEvidenceFilePath: 'src/self-dev/entrance-registry.ts', verification: unknownVerification });
  expect(ENTRANCE_REGISTRY.find((entrance) => entrance.id === 'cli-harness-ask')).toEqual({ id: 'cli-harness-ask', surface: 'cli', status: 'live', stampability: 'stampable', stampabilityEvidenceFilePath: 'src/self-dev/entrance-registry.ts', verification: { actualMission: 'verified', legacyParity: 'verified' } });
  expect(ENTRANCE_REGISTRY.find((entrance) => entrance.id === 'cli-harness-say')).toEqual({ id: 'cli-harness-say', surface: 'cli', status: 'live', stampability: 'stampable', stampabilityEvidenceFilePath: 'src/self-dev/entrance-registry.ts', verification: { actualMission: 'verified', legacyParity: 'verified' } });
  expect(CLI_HARNESS_ORCHESTRATE_ENTRANCE).toEqual({ id: 'cli-harness-orchestrate', surface: 'cli', status: 'live', stampability: 'stampable', stampabilityEvidenceFilePath: 'src/self-dev/entrance-registry.ts', verification: { actualMission: 'verified', legacyParity: 'unknown' } });
  expect(CLI_HARNESS_PLAN_ENTRANCE).toEqual({ id: 'cli-harness-plan', surface: 'cli', status: 'live', stampability: 'stampable', stampabilityEvidenceFilePath: 'src/self-dev/entrance-registry.ts', verification: { actualMission: 'verified', legacyParity: 'unknown' } });
  expect(ENTRANCE_REGISTRY.some((entrance) => entrance.id === 'cli-harness-dogfood' && entrance.status === 'retired')).toBe(true);
  // ⛔ 세 상수가 «레지스트리 안»의 그 항목이어야 한다 — 따로 만든 사본이면 갈린다.
  for (const named of [CLI_DEV_ASK_ENTRANCE, TUI_SLASH_ASK_ENTRANCE, CLI_HARNESS_ORCHESTRATE_ENTRANCE, CLI_HARNESS_PLAN_ENTRANCE, CLI_HARNESS_RUN_ENTRANCE]) {
    expect(ENTRANCE_REGISTRY.some((entrance) => entrance === named)).toBe(true);
  }
  expect(retiredEntranceNotice(CLI_HARNESS_RUN_ENTRANCE))
    .toBe('[ask] ⚠️ 이 발사 입구는 은퇴했다: cli-harness-run');
  expect(retiredEntranceNotice(CLI_DEV_ASK_ENTRANCE)).toBeUndefined();
  expect(renderLaunchEntrances()).toContain('닫힘');
  expect(renderLaunchEntrances()).toContain('cli-dev-ask');
  expect(renderLaunchEntrances()).toContain('cli-self-implement');
  expect(renderLaunchEntrances()).toContain('cli-self-orchestrate');
});

test('registers harness orchestrate and plan while preserving all existing sixteen entrance values', () => {
  const existingSixteen: readonly EntranceDeclaration[] = [
    { id: 'cli-dev-ask', surface: 'cli', status: 'closed', stampability: 'stampable', stampabilityEvidenceFilePath: 'src/self-dev/entrance-registry.ts', verification: { actualMission: 'verified', legacyParity: 'unknown' } },
    { id: 'cli-drive', surface: 'cli', status: 'live', stampability: 'structurally-unstampable', stampabilityEvidenceFilePath: undefined, verification: unknownVerification },
    { id: 'cli-self-implement', surface: 'cli', status: 'closed', stampability: 'unknown', stampabilityEvidenceFilePath: undefined, verification: unknownVerification },
    { id: 'cli-self-orchestrate', surface: 'cli', status: 'closed', stampability: 'unknown', stampabilityEvidenceFilePath: undefined, verification: unknownVerification },
    { id: 'cli-harness-ask', surface: 'cli', status: 'live', stampability: 'stampable', stampabilityEvidenceFilePath: 'src/self-dev/entrance-registry.ts', verification: { actualMission: 'verified', legacyParity: 'verified' } },
    { id: 'cli-harness-say', surface: 'cli', status: 'live', stampability: 'stampable', stampabilityEvidenceFilePath: 'src/self-dev/entrance-registry.ts', verification: { actualMission: 'verified', legacyParity: 'verified' } },
    { id: 'cli-harness-run', surface: 'cli', status: 'retired', stampability: 'stampable', stampabilityEvidenceFilePath: 'src/self-dev/entrance-registry.ts', verification: unknownVerification },
    { id: 'cli-harness-dogfood', surface: 'cli', status: 'retired', stampability: 'stampable', stampabilityEvidenceFilePath: 'src/self-dev/entrance-registry.ts', verification: unknownVerification },
    { id: 'tui-slash-ask', surface: 'slash', status: 'live', stampability: 'stampable', stampabilityEvidenceFilePath: 'src/self-dev/entrance-registry.ts', verification: { actualMission: 'verified', legacyParity: 'verified' } },
    { id: 'tui-slash-implement', surface: 'slash', status: 'retired', stampability: 'structurally-unstampable', stampabilityEvidenceFilePath: undefined, verification: unknownVerification },
    { id: 'tui-slash-dev', surface: 'slash', status: 'live', stampability: 'structurally-unstampable', stampabilityEvidenceFilePath: undefined, verification: { actualMission: 'verified', legacyParity: 'unknown' } },
    { id: 'nl-self-implement', surface: 'nl', status: 'live', stampability: 'stampable', stampabilityEvidenceFilePath: 'src/boot/daemon-tools/self-implement-names.ts', verification: { actualMission: 'verified', legacyParity: 'verified' } },
    { id: 'nl-self-orchestrate', surface: 'nl', status: 'retired', stampability: 'unknown', stampabilityEvidenceFilePath: undefined, verification: unknownVerification },
    { id: 'nl-solve-mission', surface: 'nl', status: 'live', stampability: 'structurally-unstampable', stampabilityEvidenceFilePath: undefined, verification: unknownVerification },
    { id: 'nl-run-dev-harness', surface: 'nl', status: 'retired', stampability: 'structurally-unstampable', stampabilityEvidenceFilePath: undefined, verification: unknownVerification },
    { id: 'daemon-self-implement', surface: 'daemon', status: 'live', stampability: 'stampable', stampabilityEvidenceFilePath: 'src/boot/daemon-tools/self-implement-names.ts', verification: unknownVerification },
  ];
  expect(ENTRANCE_REGISTRY).toHaveLength(19);
  expect(DAEMON_HARNESS_ASK_ENTRANCE).toEqual({ id: 'daemon-harness-ask', surface: 'daemon', status: 'live', stampability: 'stampable', stampabilityEvidenceFilePath: 'src/self-dev/entrance-registry.ts', verification: unknownVerification });
  for (const expected of existingSixteen) {
    expect(lookupEntrance(expected.id)).toEqual(expected);
  }
  expect(CLI_HARNESS_ORCHESTRATE_ENTRANCE).toEqual({ id: 'cli-harness-orchestrate', surface: 'cli', status: 'live', stampability: 'stampable', stampabilityEvidenceFilePath: 'src/self-dev/entrance-registry.ts', verification: { actualMission: 'verified', legacyParity: 'unknown' } });
  expect(CLI_HARNESS_PLAN_ENTRANCE).toEqual({ id: 'cli-harness-plan', surface: 'cli', status: 'live', stampability: 'stampable', stampabilityEvidenceFilePath: 'src/self-dev/entrance-registry.ts', verification: { actualMission: 'verified', legacyParity: 'unknown' } });
  for (const entrance of [CLI_HARNESS_ORCHESTRATE_ENTRANCE, CLI_HARNESS_PLAN_ENTRANCE]) {
    expect(Object.keys(entrance).sort()).toEqual(['id', 'stampability', 'stampabilityEvidenceFilePath', 'status', 'surface', 'verification']);
  }
  const driveEntrance = lookupEntrance('cli-drive');
  expect(ENTRANCE_REGISTRY.some((entrance) => entrance === driveEntrance)).toBe(true);
  expect(summarizeEntrances()).toMatchObject({ total: 19, live: 11, retired: 5, closed: 3 });
  expect(summarizeEntrances().bySurface.find((surface) => surface.surface === 'cli')).toEqual({ surface: 'cli', total: 10, retired: 2 });
});

test('⛔ id 가 «중복되지 않는다» — 중복이면 byId 가 조용히 첫 번째를 고른다', () => {
  const ids = ENTRANCE_REGISTRY.map((e) => e.id);
  expect(new Set(ids).size).toBe(ids.length);
});

test('⭐ 표면별 집계를 «코드가» 낸다 — 문서가 표를 손으로 적지 않게', () => {
  const summary = summarizeEntrances();
  // ⛔ 수를 여기 박지 않는다 — 입구가 늘면 이 시험이 «막아서는» 안 된다.
  //   대신 «불변식»을 문다: 합이 맞고, 표면별 합이 전체와 같고, 은퇴가 전체를 안 넘는다.
  expect(summary.live + summary.retired + summary.closed).toBe(summary.total);
  expect(summary.bySurface.reduce((n, s) => n + s.total, 0)).toBe(summary.total);
  expect(summary.retired).toBeLessThanOrEqual(summary.total);
  // ⭐ 그리고 «은퇴가 하나 이상» 있어야 한다 — 은퇴 축이 살아 있다는 증거
  //   (2026-08-17 사고: 은퇴한 입구가 «열려 있어» 사람이 그 문으로 들어갔다).
  expect(summary.retired).toBeGreaterThan(0);
});

test('catalog-backed model exposure keeps missing distinct from false and preserves declarations', () => {
  const declarations = listEntrancesWithModelExposure();
  expect(declarations).toHaveLength(19);
  expect(declarations.map(({ id, status, stampability, surface, verification }) => ({ id, status, stampability, surface, verification })))
    .toEqual(ENTRANCE_REGISTRY.map(({ id, status, stampability, surface, verification }) => ({ id, status, stampability, surface, verification })));
  expect(declarations.find((entrance) => entrance.id === 'cli-dev-ask')?.imprintEvidence).toBe('CLI_DEV_ASK_ENTRANCE');
  expect(declarations.find((entrance) => entrance.id === 'tui-slash-dev')?.imprintEvidence).toBe('none');
  expect(declarations.find((entrance) => entrance.id === 'cli-self-implement')?.imprintEvidence).toBe('unknown');
  expect(declarations.map(({ id, status, surface, stampabilityEvidenceSource, stampabilityEvidenceSourceFilePath, evidenceSourceFilePath, modelExposed }) => ({ id, status, surface, stampabilityEvidenceSource, stampabilityEvidenceSourceFilePath, evidenceSourceFilePath, modelExposed })))
    .toEqual([
      { id: 'cli-dev-ask', surface: 'cli', status: 'closed', stampabilityEvidenceSource: 'entrance-registry', stampabilityEvidenceSourceFilePath: 'src/self-dev/entrance-registry.ts', evidenceSourceFilePath: 'src/self-dev/entrance-registry.ts', modelExposed: undefined },
      { id: 'cli-drive', surface: 'cli', status: 'live', stampabilityEvidenceSource: 'structural-absence', stampabilityEvidenceSourceFilePath: undefined, evidenceSourceFilePath: undefined, modelExposed: undefined },
      { id: 'cli-self-implement', surface: 'cli', status: 'closed', stampabilityEvidenceSource: 'unverified', stampabilityEvidenceSourceFilePath: undefined, evidenceSourceFilePath: undefined, modelExposed: undefined },
      { id: 'cli-self-orchestrate', surface: 'cli', status: 'closed', stampabilityEvidenceSource: 'unverified', stampabilityEvidenceSourceFilePath: undefined, evidenceSourceFilePath: undefined, modelExposed: undefined },
      { id: 'cli-harness-ask', surface: 'cli', status: 'live', stampabilityEvidenceSource: 'entrance-registry', stampabilityEvidenceSourceFilePath: 'src/self-dev/entrance-registry.ts', evidenceSourceFilePath: 'src/self-dev/entrance-registry.ts', modelExposed: undefined },
      { id: 'cli-harness-say', surface: 'cli', status: 'live', stampabilityEvidenceSource: 'entrance-registry', stampabilityEvidenceSourceFilePath: 'src/self-dev/entrance-registry.ts', evidenceSourceFilePath: 'src/self-dev/entrance-registry.ts', modelExposed: undefined },
      { id: 'cli-harness-orchestrate', surface: 'cli', status: 'live', stampabilityEvidenceSource: 'entrance-registry', stampabilityEvidenceSourceFilePath: 'src/self-dev/entrance-registry.ts', evidenceSourceFilePath: 'src/self-dev/entrance-registry.ts', modelExposed: undefined },
      { id: 'cli-harness-plan', surface: 'cli', status: 'live', stampabilityEvidenceSource: 'entrance-registry', stampabilityEvidenceSourceFilePath: 'src/self-dev/entrance-registry.ts', evidenceSourceFilePath: 'src/self-dev/entrance-registry.ts', modelExposed: undefined },
      { id: 'cli-harness-run', surface: 'cli', status: 'retired', stampabilityEvidenceSource: 'entrance-registry', stampabilityEvidenceSourceFilePath: 'src/self-dev/entrance-registry.ts', evidenceSourceFilePath: 'src/self-dev/entrance-registry.ts', modelExposed: undefined },
      { id: 'cli-harness-dogfood', surface: 'cli', status: 'retired', stampabilityEvidenceSource: 'entrance-registry', stampabilityEvidenceSourceFilePath: 'src/self-dev/entrance-registry.ts', evidenceSourceFilePath: 'src/self-dev/entrance-registry.ts', modelExposed: undefined },
      { id: 'tui-slash-ask', surface: 'slash', status: 'live', stampabilityEvidenceSource: 'entrance-registry', stampabilityEvidenceSourceFilePath: 'src/self-dev/entrance-registry.ts', evidenceSourceFilePath: 'src/self-dev/entrance-registry.ts', modelExposed: undefined },
      { id: 'tui-slash-implement', surface: 'slash', status: 'retired', stampabilityEvidenceSource: 'structural-absence', stampabilityEvidenceSourceFilePath: undefined, evidenceSourceFilePath: undefined, modelExposed: undefined },
      { id: 'tui-slash-dev', surface: 'slash', status: 'live', stampabilityEvidenceSource: 'structural-absence', stampabilityEvidenceSourceFilePath: undefined, evidenceSourceFilePath: undefined, modelExposed: undefined },
      { id: 'nl-self-implement', surface: 'nl', status: 'live', stampabilityEvidenceSource: 'self-implement-tool-names', stampabilityEvidenceSourceFilePath: 'src/boot/daemon-tools/self-implement-names.ts', evidenceSourceFilePath: 'src/boot/daemon-tools/self-implement-names.ts', modelExposed: true },
      { id: 'nl-self-orchestrate', surface: 'nl', status: 'retired', stampabilityEvidenceSource: 'unverified', stampabilityEvidenceSourceFilePath: undefined, evidenceSourceFilePath: undefined, modelExposed: false },
      { id: 'nl-solve-mission', surface: 'nl', status: 'live', stampabilityEvidenceSource: 'structural-absence', stampabilityEvidenceSourceFilePath: undefined, evidenceSourceFilePath: undefined, modelExposed: true },
      { id: 'nl-run-dev-harness', surface: 'nl', status: 'retired', stampabilityEvidenceSource: 'structural-absence', stampabilityEvidenceSourceFilePath: undefined, evidenceSourceFilePath: undefined, modelExposed: undefined },
      { id: 'daemon-self-implement', surface: 'daemon', status: 'live', stampabilityEvidenceSource: 'self-implement-tool-names', stampabilityEvidenceSourceFilePath: 'src/boot/daemon-tools/self-implement-names.ts', evidenceSourceFilePath: 'src/boot/daemon-tools/self-implement-names.ts', modelExposed: undefined },
      { id: 'daemon-harness-ask', surface: 'daemon', status: 'live', stampabilityEvidenceSource: 'entrance-registry', stampabilityEvidenceSourceFilePath: 'src/self-dev/entrance-registry.ts', evidenceSourceFilePath: 'src/self-dev/entrance-registry.ts', modelExposed: undefined },
    ]);
});

test('manual entrance verification defaults to unknown and can be declared per entrance without autofilling existing rows', () => {
  // ⛔⭐ 이 시험의 «뜻»은 「전부 unknown 이다」가 아니라 ***「도구가 «임의로» 채우지 않는다」***다.
  //   📏 2026-08-22: 사람이 «돌려 보고» 두 입구에 판정을 적었다(cli-harness-ask · cli-harness-say).
  //     그것은 «선언»이고 이 시험이 막으려던 것이 아니다.
  //   ⇒ 그래서 ***「사람이 적은 것 «말고는» 전부 unknown」***을 문다.
  //   📏 2026-08-24: 사람이 «돌려 보고» 하나를 더 적었다(cli-harness-plan · ④ 만 · ⑤ 는 «안 쟀다»).
  //     근거 = harness plan 으로 실제 골을 끝까지 돌렸고 원장에 "entrance":"cli-harness-plan" 이 찍혔다.
  const humanDeclared = new Set(['cli-harness-ask', 'cli-harness-say', 'cli-harness-orchestrate', 'cli-harness-plan', 'cli-dev-ask', 'tui-slash-ask', 'tui-slash-dev', 'nl-self-implement']);
  for (const entrance of ENTRANCE_REGISTRY) {
    if (humanDeclared.has(entrance.id)) continue;
    expect(entrance.verification).toEqual(unknownVerification);
  }
  // ⭐ 같은 뜻의 둘째 자 — ***사람이 적은 둘 «말고는» 판정이 없다***.
  expect(ENTRANCE_REGISTRY
    .filter((entrance) => !humanDeclared.has(entrance.id))
    .filter((entrance) => entrance.verification.actualMission !== 'unknown' || entrance.verification.legacyParity !== 'unknown')).toHaveLength(0);

  const rendered = renderLaunchEntrances([
    {
      ...CLI_DEV_ASK_ENTRANCE,
      verification: { actualMission: 'verified', legacyParity: 'verified' },
    },
  ]);
  expect(rendered).toContain('cli-dev-ask (stampable) verification=actualMission:verified,legacyParity:verified');
});

test('stampability is derived from one export-identifier evidence map backed by real exported constants', () => {
  expect(Object.keys(ENTRANCE_EXPORT_IDENTIFIER_EVIDENCE).sort())
    .toEqual(ENTRANCE_REGISTRY.map((entrance) => entrance.id).sort());

  const byId = Object.fromEntries(ENTRANCE_REGISTRY.map((entrance) => [entrance.id, entrance]));
  for (const entrance of ENTRANCE_REGISTRY) {
    const id = entrance.id as EntranceId;
    const evidence = ENTRANCE_EXPORT_IDENTIFIER_EVIDENCE[id];
    expect(entrance.stampability).toBe(deriveEntranceStampability(evidence));
    if (evidence.kind === 'present') {
      expect(evidence.exportedIdentifiers.length).toBeGreaterThan(0);
      for (const exportedIdentifier of evidence.exportedIdentifiers) {
        const sourceExports = exportedIdentifier === 'SELF_IMPLEMENT_TOOL_NAMES'
          ? selfImplementNameExports
          : registryExports;
        expect(sourceExports.has(exportedIdentifier)).toBe(true);
      }
    }
  }

  expect(ENTRANCE_EXPORT_IDENTIFIER_EVIDENCE['cli-drive']).toEqual({ kind: 'absent', source: 'structural-absence', sourceFilePath: undefined });
  expect(byId['cli-drive']?.stampability).toBe('structurally-unstampable');
  expect(ENTRANCE_EXPORT_IDENTIFIER_EVIDENCE['tui-slash-dev']).toEqual({ kind: 'absent', source: 'structural-absence', sourceFilePath: undefined });
  expect(byId['tui-slash-dev']?.stampability).toBe('structurally-unstampable');
  expect(byId['daemon-self-implement']?.stampability).toBe('stampable');
  expect(ENTRANCE_EXPORT_IDENTIFIER_EVIDENCE['nl-self-implement'])
    .toBe(ENTRANCE_EXPORT_IDENTIFIER_EVIDENCE['daemon-self-implement']);
  expect(byId['tui-slash-implement']?.stampability).toBe('structurally-unstampable');
  expect(byId['cli-self-implement']?.stampability).toBe('unknown');
});

test('unknown evidence remains distinct from confirmed absence and empty present evidence is not stampable', () => {
  expect(deriveEntranceStampability({ kind: 'absent', source: 'structural-absence', sourceFilePath: undefined })).toBe('structurally-unstampable');
  expect(deriveEntranceStampability({ kind: 'unverified', source: 'unverified', sourceFilePath: undefined })).toBe('unknown');
  expect(deriveEntranceStampability({ kind: 'present', exportedIdentifiers: [], source: 'entrance-registry', sourceFilePath: 'src/self-dev/entrance-registry.ts' } as never)).toBe('unknown');
});

test('lookup and rendering observe the derived registry values', () => {
  expect(lookupEntrance('daemon-self-implement').stampability).toBe('stampable');
  expect(lookupEntrance('cli-drive').stampability).toBe('structurally-unstampable');
  expect(lookupEntrance('tui-slash-dev').stampability).toBe('structurally-unstampable');
  const rendered = renderLaunchEntrances();
  expect(rendered).toContain('cli-drive (structurally-unstampable) verification=actualMission:unknown,legacyParity:unknown imprintEvidence=none evidenceSource=structural-absence evidenceSourceFilePath=missing modelExposed=missing');
  expect(rendered).toContain('daemon-self-implement (stampable) verification=actualMission:unknown,legacyParity:unknown imprintEvidence=SELF_IMPLEMENT_TOOL_NAMES evidenceSource=self-implement-tool-names evidenceSourceFilePath=src/boot/daemon-tools/self-implement-names.ts modelExposed=missing');
  expect(rendered).toContain('tui-slash-dev (structurally-unstampable) verification=actualMission:verified,legacyParity:unknown imprintEvidence=none evidenceSource=structural-absence evidenceSourceFilePath=missing modelExposed=missing');
  expect(rendered).toContain('cli-self-implement (unknown) verification=actualMission:unknown,legacyParity:unknown imprintEvidence=unknown evidenceSource=unverified');
});

test('⭐ 사람이 읽는 화면이 은퇴를 «조용히 섞지» 않는다', () => {
  const rendered = renderLaunchEntrances();
  expect(rendered).toContain('launch entrances:');
  expect(rendered).toContain('tui-slash-ask (stampable)');
  expect(rendered).toContain('tui-slash-implement (structurally-unstampable)');
  expect(rendered).toContain('tui-slash-dev (structurally-unstampable)');
  expect(rendered).toContain('cli-harness-orchestrate (stampable) verification=actualMission:verified,legacyParity:unknown imprintEvidence=CLI_HARNESS_ORCHESTRATE_ENTRANCE evidenceSource=entrance-registry evidenceSourceFilePath=src/self-dev/entrance-registry.ts modelExposed=missing');
  expect(rendered).toContain('cli-harness-plan (stampable) verification=actualMission:verified,legacyParity:unknown imprintEvidence=CLI_HARNESS_PLAN_ENTRANCE evidenceSource=entrance-registry evidenceSourceFilePath=src/self-dev/entrance-registry.ts modelExposed=missing');
  expect(rendered).toContain('cli-harness-run (stampable) verification=actualMission:unknown,legacyParity:unknown imprintEvidence=CLI_HARNESS_RUN_ENTRANCE evidenceSource=entrance-registry evidenceSourceFilePath=src/self-dev/entrance-registry.ts modelExposed=missing');
  expect(rendered).toContain('nl-self-implement (stampable) verification=actualMission:verified,legacyParity:verified imprintEvidence=SELF_IMPLEMENT_TOOL_NAMES evidenceSource=self-implement-tool-names evidenceSourceFilePath=src/boot/daemon-tools/self-implement-names.ts modelExposed=true');
  expect(rendered).toContain('nl-self-orchestrate (unknown) verification=actualMission:unknown,legacyParity:unknown imprintEvidence=unknown evidenceSource=unverified evidenceSourceFilePath=missing modelExposed=false');
  expect(rendered).toContain('nl-solve-mission (structurally-unstampable) verification=actualMission:unknown,legacyParity:unknown imprintEvidence=none evidenceSource=structural-absence evidenceSourceFilePath=missing modelExposed=true');
  for (const entrance of ENTRANCE_REGISTRY) {
    expect(rendered).toContain(entrance.id);
    // 은퇴한 것은 «표시»가 붙어야 한다.
    if (entrance.status === 'retired') {
      const line = rendered.split('\n').find((l) => l.includes(entrance.id));
      expect(line).toContain('🪦');
    }
  }
});

test('⭐ 은퇴 표시가 «선언에서» 온다 — 붙이는 쪽이 문면을 지어내지 않는다', () => {
  const prefix = retiredEntranceDescriptionPrefix(CLI_HARNESS_RUN_ENTRANCE, 'elanous dev --implement <objective>');
  expect(prefix).toContain('DEPRECATED');
  expect(prefix).toContain('cli-harness-run');
  // ⛔ 「금지만 주고 길을 안 주면 멈춘다」 — 갈 곳이 문면에 «있어야» 한다.
  expect(prefix).toContain('elanous dev --implement <objective>');
});

test('⛔ live 입구에는 «아무것도 안 붙는다» — 호출자가 분기하지 않게', () => {
  expect(retiredEntranceDescriptionPrefix(CLI_DEV_ASK_ENTRANCE, 'x')).toBeUndefined();
  expect(describeEntranceCommand(CLI_DEV_ASK_ENTRANCE, 'x', '원래 설명')).toBe('원래 설명');
});

test('⭐ 은퇴 입구는 원래 설명을 «잃지 않는다» — 앞에 붙일 뿐이다', () => {
  const described = describeEntranceCommand(CLI_HARNESS_RUN_ENTRANCE, 'elanous dev', '원래 설명');
  expect(described).toContain('원래 설명');
  expect(described.indexOf('DEPRECATED')).toBeLessThan(described.indexOf('원래 설명'));
});

test('⛔⭐ 은퇴로 «선언된» 입구는 사람이 보는 자리에서 그 사실을 말해야 한다 (2026-08-17 사고의 형태)', () => {
  // 📏 그날의 사고: 은퇴한 입구가 «열려 있고 아무 말도 안 해서» 사람이 그 문으로 들어갔다.
  //   ⇒ 이 시험은 「모든 은퇴 입구가 표시 문면을 «만들 수 있다»」를 문다.
  //     (각 명령에 «실제로 붙었는지»는 그 명령의 --help 가 답한다 — 여기서는 능력을 문다.)
  for (const entrance of ENTRANCE_REGISTRY.filter((e) => e.status === 'retired')) {
    const prefix = retiredEntranceDescriptionPrefix(entrance, '대체 경로');
    expect(prefix).toBeDefined();
    expect(prefix).toContain(entrance.id);
  }
});

test('runEntrancesAction consumes the registry that now renders harness ask and say', async () => {
  const { runEntrancesAction: runEntrancesActionForJson } = await import('../index.js');
  const jsonOutput: string[] = [];
  runEntrancesActionForJson({ json: true }, {
    baseline: [],
    actualEntrances: [],
    writeOutput: (line) => jsonOutput.push(line),
    writeError: () => undefined,
    setExitCode: () => undefined,
  });
  const structured = JSON.parse(jsonOutput[0]);
  const launchDeclaration = structured.launchEntrances.declarations.find(
    (entrance: { id: string }) => entrance.id === 'daemon-self-implement',
  );
  expect(launchDeclaration).toMatchObject({
    id: 'daemon-self-implement',
    verification: unknownVerification,
    imprintEvidence: 'SELF_IMPLEMENT_TOOL_NAMES',
    stampabilityEvidenceSource: 'self-implement-tool-names',
    stampabilityEvidenceSourceFilePath: 'src/boot/daemon-tools/self-implement-names.ts',
    evidenceSourceFilePath: 'src/boot/daemon-tools/self-implement-names.ts',
  });
  expect(structured.launchEntrances.declarations.find((entrance: { id: string }) => entrance.id === 'tui-slash-dev'))
    .toMatchObject({ imprintEvidence: 'none' });
  expect(structured.launchEntrances.declarations.find((entrance: { id: string }) => entrance.id === 'cli-self-implement'))
    .toMatchObject({ imprintEvidence: 'unknown' });
  expect(structured.launchEntrances.declarations.find((entrance: { id: string }) => entrance.id === 'cli-harness-orchestrate'))
    .toMatchObject({ id: 'cli-harness-orchestrate', verification: { actualMission: 'verified', legacyParity: 'unknown' }, imprintEvidence: 'CLI_HARNESS_ORCHESTRATE_ENTRANCE' });
  expect(structured.launchEntrances.declarations.find((entrance: { id: string }) => entrance.id === 'cli-harness-plan'))
    .toMatchObject({ id: 'cli-harness-plan', verification: { actualMission: 'verified', legacyParity: 'unknown' }, imprintEvidence: 'CLI_HARNESS_PLAN_ENTRANCE' });

  const rendered = renderLaunchEntrances();
  expect(rendered).toContain('launch entrances: 19 (live 11 · retired 5 · closed 3)');
  expect(rendered).toContain('닫힘');
  expect(rendered).toContain('cli-drive (structurally-unstampable)');
  // ⭐ 2026-08-22: ask/say 두 입구가 «자기 이름을» 각인하게 됐다(#11462 가 인자를 열고 #11470 이 넘겼다).
  //   2026-08-23: 등기 착지가 orchestrate/plan 입구도 별도 각인 가능 항목으로 세운다.
  expect(rendered).toContain('cli-harness-ask (stampable)');
  expect(rendered).toContain('cli-harness-say (stampable)');
  expect(rendered).toContain('cli-harness-orchestrate (stampable) verification=actualMission:verified,legacyParity:unknown');
  expect(rendered).toContain('cli-harness-plan (stampable) verification=actualMission:verified,legacyParity:unknown');

  const indexSource = readFileSync(resolve(import.meta.dir, '../index.ts'), 'utf8');
  const runEntrancesAction = indexSource.slice(
    indexSource.indexOf('export function runEntrancesAction'),
    indexSource.indexOf("selfCmd\n  .command('entrances')"),
  );
  expect(runEntrancesAction).toContain('const launchSummary = summarizeEntrances();');
  expect(runEntrancesAction).toContain('launchEntrances: { ...launchSummary, declarations: listEntrancesWithModelExposure() }');
  expect(runEntrancesAction).toContain('renderLaunchEntrances()');
  const declarations = listEntrancesWithModelExposure();
  const driveDeclaration = declarations.find((entrance) => entrance.id === 'cli-drive');
  expect(driveDeclaration).toMatchObject({
    id: 'cli-drive',
    surface: 'cli',
    status: 'live',
    stampability: 'structurally-unstampable',
    imprintEvidence: 'none',
    stampabilityEvidenceSource: 'structural-absence',
    stampabilityEvidenceSourceFilePath: undefined,
    evidenceSourceFilePath: undefined,
    verification: unknownVerification,
  });
  expect(Object.prototype.hasOwnProperty.call(EntranceRegistryModule, 'CLI_DRIVE_ENTRANCE')).toBe(false);

  const { buildDriveAliasDevSpec } = await import('./dev-cli.js');
  const driveSpec = buildDriveAliasDevSpec('echo hi', { goal: 'g' }, ['goal']);
  expect(driveSpec.entrance).toBe('cli-drive');
  expect(driveSpec.completion).toBe('worktree-only');
});

// ⛔⭐⭐ 「선언이 stampable 이다」로 끝내지 «않는다» — ***그 각인을 실제로 넘기는 자리가 있는가***를 문다.
//   📏 2026-08-22 계기: harness ask 로 여덟 발을 쐈는데 원장엔 «전부 cli-dev-ask» 로 적혔다.
//     선언만 고치면 그 결손이 «다시» 숨는다.
test('harness ask and say entrances actually pass their own registry id at the launch site', async () => {
  const { program, setRunDevAskFromGoalFileDepsForTesting } = await import('../index.js');
  const launchedEntrances: string[] = [];
  const originalLog = console.log;
  console.log = () => {};
  try {
    setRunDevAskFromGoalFileDepsForTesting({
      loadLaunchPreflight: async () => ({
        prepareAskLaunch: (() => ({ liveRunWindowMinutes: 30, recentChangeWindowDays: 7 })) as never,
        decideAskPreflight: ((input: { goalFile: string }) => ({
          result: {
            paths: [input.goalFile],
            blockers: [],
            warnings: [],
            openPrs: { state: 'checked', count: 0 },
            liveRuns: { state: 'checked', count: 0 },
            interruptedRuns: { state: 'checked', count: 0 },
            interruptedRunMatches: [],
            activeUnfinishedRuns: { state: 'checked', count: 0 },
            inactiveUnfinishedRuns: { state: 'checked', count: 0 },
            unreadableUnfinishedRunAges: { state: 'checked', count: 0 },
            recentChanges: { state: 'checked', count: 0 },
            preexistingFailures: { state: 'checked', files: [] },
            recentChangeWindowDays: 7,
            unreadableRuns: 0,
            liveRunWindowMs: 30 * 60_000,
          },
          shouldLaunch: true,
        })) as never,
        renderLaunchPreflight: (() => '') as never,
      }),
      loadAskLaunchIo: async () => ({ buildAskPreflightDeps: (async () => ({})) as never }),
      loadAskLaunchFlow: async () => ({
        measureInvokerBehindDefaultBranch: (() => ({ state: 'measured', commits: 0, baseRef: 'origin/main' })) as never,
        recommendLaunchDecomposition: (async () => undefined) as never,
      }),
      loadDevCli: async () => ({
        renderDevCompletionLine: (() => '') as never,
        assertDevCliPathOptions: ((_: unknown, _opts: unknown, _explicit: unknown) => {}) as never,
        buildDevCliSpec: ((
          input: unknown,
          executor: unknown,
          opts: unknown,
          _provided: readonly string[],
          entrance: string,
        ) => {
          launchedEntrances.push(entrance);
          return { input, executor, opts, entrance };
        }) as never,
        // ⛔ 대역이 실물과 달라 ask-file 갈래(index.ts:400 `selected?.kind !== 'ask'`)가 조기 return
        //   하던 것을 고친다(F18). 실물 `selectDevAuthorInput` 은 `{ask}` 를 받으면 kind:'ask' 를 낸다.
        selectDevAuthorInput: ((_provided: unknown, opts: { ask?: string } | undefined) =>
          opts?.ask ? { kind: 'ask', value: opts.ask } : { kind: 'say', value: 'author this goal' }) as never,
      }),
      loadDevPipeline: async () => ({
        runDevPipeline: (async () => ({
          kind: 'self',
          result: { runId: 'run-entrance-guard', outcome: 'completed' },
          plan: {},
        })) as never,
        devResultOk: (() => true) as never,
      }),
      runSayLaunchFlow: async () => ({ kind: 'launch', goalFile: '/tmp/goal.md' }) as never,
      // ask-file 갈래(index.ts:409)도 주입 가능한 흐름을 쓴다 — 대역이 없으면 실제 파일을 읽어 ENOENT 로 죽는다.
      runAskFileLaunchFlow: async () => ({ kind: 'launch', goalFile: '/tmp/goal.md' }) as never,
      print: () => {},
      cwd: () => '/tmp/test-cwd',
      setExitCode: () => {},
    });

    await program.parseAsync(['node', 'elanous', 'harness', 'ask', '/tmp/goal.md']);
    await program.parseAsync(['node', 'elanous', 'harness', 'say', 'author this goal']);

    expect(launchedEntrances).toHaveLength(2);
    expect(launchedEntrances[0]).toBe(CLI_HARNESS_ASK_ENTRANCE.id);
    expect(launchedEntrances[1]).toBe(CLI_HARNESS_SAY_ENTRANCE.id);
    expect(launchedEntrances[0]).not.toBe(CLI_HARNESS_SAY_ENTRANCE.id);
    expect(launchedEntrances[1]).not.toBe(CLI_HARNESS_ASK_ENTRANCE.id);
  } finally {
    console.log = originalLog;
    setRunDevAskFromGoalFileDepsForTesting(undefined);
  }

  expect(registryExports.has('CLI_HARNESS_ASK_ENTRANCE')).toBe(true);
  expect(registryExports.has('CLI_HARNESS_SAY_ENTRANCE')).toBe(true);
});
