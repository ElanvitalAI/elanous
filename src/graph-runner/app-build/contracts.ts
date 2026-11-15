/** Product-neutral planning contracts for the staged application build graph. */
export const ARCHITECTURE_SECTIONS = ['context', 'dataModel', 'api', 'sequences', 'deployment', 'security', 'tradeOffs', 'operations'] as const;
// OP #64914 approved build budget; individual transports may enforce tighter limits.
export const APP_BUILD_MAX_FILES = 24;
export const APP_BUILD_MAX_REPAIRS = 2;
function validAssumption(statement: string, source: unknown): boolean {
  const match = statement.trim().match(/^(user|assumed):\s*(\S[^\r\n]*)$/u);
  if (!match || match[1] !== source) return false;
  const content = match[2]!.trim();
  return !/[?？][\s"'”’)]*$/u.test(content)
    && !/^(?:which|what|should|would|could|can|do|does|is|are|will|how|when|where|who|why)\b/iu.test(content)
    && !/(?:까요|나요|습니까|할까)[.!。]?$/u.test(content);
}
export interface TestStrategyItem {
  id: string; kind: 'unit' | 'api' | 'seed' | 'fault'; target: string;
  testFile: string; device: 'bun-test-sandbox'; command: ['bun', 'test', string];
}
const MAX_TEST_STRATEGIES = 8;
const MAX_TEST_TARGET_CHARS = 512;
/** A single registered device; model text never becomes a shell command. */
export function parseTestStrategy(value: unknown, files?: readonly { path: string; role?: string }[]): TestStrategyItem[] {
  if (!Array.isArray(value) || !value.length || value.length > MAX_TEST_STRATEGIES) throw new Error('test strategy required');
  const ids = new Set<string>();
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || Object.keys(item).sort().join(',') !== 'command,device,id,kind,target,testFile'
      || typeof item.id !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/u.test(item.id) || ids.has(item.id)
      || !['unit', 'api', 'seed', 'fault'].includes(item.kind)
      || typeof item.target !== 'string' || !item.target.trim() || item.target.length > MAX_TEST_TARGET_CHARS
      || typeof item.testFile !== 'string' || !/^[A-Za-z0-9_/-]+\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(item.testFile)
      || item.testFile.split('/').some((part: string) => !part || part.startsWith('.'))
      || item.device !== 'bun-test-sandbox' || !Array.isArray(item.command)
      || JSON.stringify(item.command) !== JSON.stringify(['bun', 'test', './' + item.testFile])
      || files && !files.some(file => file.path === item.testFile && (file.role === undefined || file.role === 'test'))) {
      throw new Error('test strategy invalid or missing planned test file');
    }
    ids.add(item.id);
    return { id: item.id, kind: item.kind, target: item.target.trim(), testFile: item.testFile,
      device: 'bun-test-sandbox', command: ['bun', 'test', './' + item.testFile] };
  });
}

export function parsePlanningStage(stage: 'assumptions' | 'architecture' | 'file-plan', value: unknown, options: { seedRequested?: boolean; requireTestStrategy?: boolean; testStrategy?: unknown } = {}): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('stage output must be an object');
  const record = value as Record<string, unknown>;
  if (stage === 'assumptions') {
    if (!Array.isArray(record.assumptions) || !record.assumptions.length || record.assumptions.some(item => !item || typeof item !== 'object'
      || typeof item.statement !== 'string' || !validAssumption(item.statement, item.source) || !['user', 'assumed'].includes(item.source))) throw new Error('assumptions contract missing');
    return { assumptions: record.assumptions };
  }
  if (stage === 'architecture') {
    const sections = record.sections as Record<string, unknown> | undefined;
    if (typeof record.markdown !== 'string' || !record.markdown.trim() || !sections
      || ARCHITECTURE_SECTIONS.some(key => typeof sections[key] !== 'string' || !String(sections[key]).trim())) throw new Error('architecture requires all eight sections');
    const testStrategy = record.testStrategy === undefined && !options.requireTestStrategy ? undefined : parseTestStrategy(record.testStrategy);
    const testStrategyTitle = record.testStrategyTitle;
    if (testStrategy && (typeof testStrategyTitle !== 'string' || !testStrategyTitle.trim()
      || testStrategyTitle.length > MAX_TEST_TARGET_CHARS || /[\r\n]/u.test(testStrategyTitle))) throw new Error('localized test strategy title required');
    return { markdown: record.markdown, sections, ...(testStrategy ? { testStrategy, testStrategyTitle } : {}) };
  }
  if (!Array.isArray(record.plan) || !record.plan.length || record.plan.length > APP_BUILD_MAX_FILES) throw new Error('file plan budget exceeded or missing');
  const names = new Set<string>();
  const roles = new Set<string>();
  for (const entry of record.plan) {
    if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string' || typeof entry.purpose !== 'string' || !entry.purpose.trim() || typeof entry.role !== 'string'
      || !['architecture', 'frontend', 'backend', 'database', 'test', 'seed', 'config', 'asset'].includes(entry.role)
      || !Array.isArray(entry.dependsOn) || entry.dependsOn.some((name: unknown) => typeof name !== 'string' || !names.has(name))) throw new Error('file plan dependency contract invalid');
    const path = entry.path as string;
    if (/^[A-Za-z]:/u.test(path) || path.startsWith('//') || Buffer.byteLength(path) > 1024 || path.split('/').length > 16 || path.includes('\\') || path.includes('\0')
      || path.split('/').some(part => !part || part.startsWith('.')) || path === 'source-artifact.json' || path.startsWith('source-artifact.json/') || names.has(path) || [...names].some(name => path.startsWith(name + '/') || name.startsWith(path + '/'))) throw new Error('file plan path invalid');
    names.add(path);
    roles.add(entry.role);
  }
  if (!options.seedRequested && roles.has('seed')) throw new Error('seed role requires explicit request');
  if (!names.has('ARCHITECTURE.md')) throw new Error('file plan requires architecture file');
  if (['architecture', 'frontend', 'backend', 'database', 'test'].some(role => !roles.has(role))
    || (options.seedRequested && !roles.has('seed'))) throw new Error('file plan required roles missing');
  if (options.testStrategy !== undefined) parseTestStrategy(options.testStrategy, record.plan);
  return { plan: record.plan };
}
