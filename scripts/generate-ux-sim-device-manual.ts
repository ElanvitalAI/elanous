import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadMockScenarioCatalog, renderMockScenarioDeviceMarkdownTable } from '../src/ux-sim/mock-scenario-catalog.js';

const manualPath = resolve(import.meta.dir, '../docs/manual/MANUAL-ux-simulation-devices-2026-08-23.md');
const begin = '<!-- BEGIN GENERATED MOCK DEVICE CATALOG -->';
const end = '<!-- END GENERATED MOCK DEVICE CATALOG -->';
const manual = readFileSync(manualPath, 'utf8');
const startAt = manual.indexOf(begin);
const endAt = manual.indexOf(end);
if (startAt < 0 || endAt < 0 || endAt < startAt) {
  throw new Error(`manual must contain ordered catalog markers: ${begin} / ${end}`);
}
const generated = [
  begin,
  '> 이 표는 `src/ux-sim/mock-scenario-catalog.json`에서 생성한다. 갱신: `bun scripts/generate-ux-sim-device-manual.ts`.',
  '',
  ...renderMockScenarioDeviceMarkdownTable(loadMockScenarioCatalog()),
  end,
].join('\n');
writeFileSync(manualPath, `${manual.slice(0, startAt)}${generated}${manual.slice(endAt + end.length)}`);
