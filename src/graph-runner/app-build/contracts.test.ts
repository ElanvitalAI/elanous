import { expect, test } from 'bun:test';
import { APP_BUILD_MAX_FILES, parsePlanningStage, parseTestStrategy } from './contracts.js';

const roles = ['architecture', 'frontend', 'backend', 'database', 'test'];
const valid = roles.map(role => ({ path: role === 'architecture' ? 'ARCHITECTURE.md' : role + '/main.ts', purpose: role, role, dependsOn: [] }));
test('file plans require architecture and every executable application component without hidden seed defaults', () => {
  expect(() => parsePlanningStage('file-plan', { plan: valid })).not.toThrow();
  expect(() => parsePlanningStage('file-plan', { plan: valid }, { seedRequested: true })).toThrow('roles');
  expect(() => parsePlanningStage('file-plan', { plan: valid.filter(file => file.role !== 'database') })).toThrow('roles');
});
test('file plan rejects unsafe paths, duplicate entries, missing dependencies and unbounded plans', () => {
  for (const path of ['../escape', '/absolute', '.env', 'source-artifact.json/subfile', 'nul\0file']) {
    expect(() => parsePlanningStage('file-plan', { plan: [...valid, { path, role: 'asset', purpose: 'synthetic', dependsOn: [] }] })).toThrow();
  }
  expect(() => parsePlanningStage('file-plan', { plan: [...valid, valid[0]] })).toThrow();
  expect(() => parsePlanningStage('file-plan', { plan: [{ ...valid[0], dependsOn: ['not-yet-generated'] }, ...valid.slice(1)] })).toThrow('dependency');
  expect(() => parsePlanningStage('file-plan', { plan: Array.from({ length: APP_BUILD_MAX_FILES + 1 }, (_, index) => ({ path: 'file' + index, role: 'asset', purpose: 'synthetic', dependsOn: [] })) })).toThrow('budget');
});

test('seed files require an explicit request and remain required when requested', () => {
  const withSeed = [...valid, { path: 'seed.ts', role: 'seed', purpose: 'requested synthetic rows', dependsOn: [] }];
  expect(() => parsePlanningStage('file-plan', { plan: withSeed }, { seedRequested: false })).toThrow('explicit request');
  expect(() => parsePlanningStage('file-plan', { plan: withSeed })).toThrow('explicit request');
  expect(() => parsePlanningStage('file-plan', { plan: withSeed }, { seedRequested: true })).not.toThrow();
});
test('file plans reject ancestor and descendant file conflicts in either order', () => {
  const entry = { path: 'frontend', role: 'asset', purpose: 'conflicting file', dependsOn: [] };
  expect(() => parsePlanningStage('file-plan', { plan: [...valid, entry] })).toThrow('path');
  expect(() => parsePlanningStage('file-plan', { plan: [entry, ...valid] })).toThrow('path');
});

test('assumptions require a nonempty labeled declarative statement, never a clarification', () => {
  expect(() => parsePlanningStage('assumptions', { assumptions: [] })).toThrow();
  for (const statement of ['', ' ', 'assumed:', ': Use SQLite', 'Use SQLite', 'assumed: Which database would you like?',
    'assumed: What features', 'user: Should we deploy?', 'assumed: SQLite?', 'assumed: 어떤 DB로 할까요?', 'assumed: 사용할까요',
    'assumed: Use SQLite？', 'assumed: Use SQLite\nWhat next?']) {
    expect(() => parsePlanningStage('assumptions', { assumptions: [{ statement, source: 'assumed' }] })).toThrow();
  }
  for (const statement of ['assumed: Use local SQLite.', 'user: 사용자는 앱 생성을 요청했다.']) {
    expect(() => parsePlanningStage('assumptions', { assumptions: [{ statement, source: statement.startsWith('user:') ? 'user' : 'assumed' }] })).not.toThrow();
  }
});
test('file plans reject Windows drives and UNC paths before materialization', () => {
  for (const path of ['C:/outside/file.ts', 'c:relative.ts', 'Z:/file', '//server/share/file', String.raw`\\server\share\file`, String.raw`C:\outside\file.ts`]) {
    expect(() => parsePlanningStage('file-plan', { plan: [...valid, { path, role: 'asset', purpose: 'synthetic', dependsOn: [] }] })).toThrow('path');
  }
});

test('assumption labels match the structured source and do not mislabel user requirements', () => {
  expect(() => parsePlanningStage('assumptions', { assumptions: [{ statement: 'user: Use SQLite.', source: 'assumed' }] })).toThrow();
  expect(() => parsePlanningStage('assumptions', { assumptions: [{ statement: 'assumed: Use SQLite.', source: 'user' }] })).toThrow();
});

const strategy = [{ id: 'api-roundtrip', kind: 'api', target: '생성하고 다시 조회한 값이 일치', testFile: 'tests/api.test.ts',
  device: 'bun-test-sandbox', command: ['bun', 'test', './tests/api.test.ts'] }];
test('strategy rejects shell commands, invented devices, missing test files and duplicate ids', () => {
  expect(parseTestStrategy(strategy)[0]?.id).toBe('api-roundtrip');
  for (const patch of [{ command: ['sh', '-c', 'echo passed'] }, { device: 'invented' },
    { testFile: '../api.test.ts' }, { command: ['bun', 'test', '--preload=untrusted'] }]) {
    expect(() => parseTestStrategy([{ ...strategy[0], ...patch }])).toThrow();
  }
  expect(() => parseTestStrategy([...strategy, ...strategy])).toThrow();
  expect(() => parseTestStrategy(strategy, [{ path: 'tests/api.test.ts', role: 'backend' }])).toThrow();
  expect(() => parseTestStrategy(strategy, [])).toThrow();
  const planned = [...valid, { path: 'tests/api.test.ts', purpose: 'API round trip', role: 'test', dependsOn: [] }];
  expect(() => parsePlanningStage('file-plan', { plan: planned }, { testStrategy: strategy })).not.toThrow();
  expect(() => parsePlanningStage('file-plan', { plan: valid }, { testStrategy: strategy })).toThrow();
});
