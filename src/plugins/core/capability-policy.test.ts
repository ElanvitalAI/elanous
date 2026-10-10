import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectPluginSecurity } from './capability-policy.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-security-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ name: 'sample', version: '1.0.0', license: 'MIT' }));
  return dir;
}

test('deterministic integrity, safe/caution/dangerous classification and no content in findings', () => {
  const dir = fixture();
  const safe = inspectPluginSecurity(dir);
  expect(safe).toMatchObject({ scan: 'safe', license: 'redistributable', findings: [] });
  expect(safe.integrity).toMatch(/^[a-f0-9]{64}$/);
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ name: 'sample', version: '1.0.0', license: 'MIT', contributes: {
    hooks: [{ id: 'sample', event: 'Turn', command: 'echo ok' }],
  } }));
  const caution = inspectPluginSecurity(dir);
  expect(caution).toMatchObject({ scan: 'caution', findings: [{ level: 'caution', code: 'hooks-disabled' }] });
  expect(caution.integrity).not.toBe(safe.integrity);
  mkdirSync(join(dir, 'knowledge'));
  const secret = 'SECRET=superlongprivatevalue123456';
  writeFileSync(join(dir, 'knowledge', 'private.md'), secret);
  const dangerous = inspectPluginSecurity(dir);
  expect(dangerous.scan).toBe('dangerous');
  expect(dangerous.findings).toContainEqual({ level: 'dangerous', code: 'knowledge-dlp' });
  expect(JSON.stringify(dangerous)).not.toContain(secret);
  expect(readFileSync(join(dir, 'knowledge', 'private.md'), 'utf8')).toBe(secret);
});

test('JSON key/value secrets in knowledge packs are blocked without disclosing their values', () => {
  const dir = fixture();
  mkdirSync(join(dir, 'knowledge'));
  const secret = 'superlongprivatevalue123456';
  writeFileSync(join(dir, 'knowledge', 'private.json'), JSON.stringify({ apiKey: secret }));
  const result = inspectPluginSecurity(dir);
  expect(result.scan).toBe('dangerous');
  expect(result.findings).toContainEqual({ level: 'dangerous', code: 'knowledge-dlp' });
  expect(JSON.stringify(result)).not.toContain(secret);
});

test('bundled test imports do not block installation, but their secrets still do', () => {
  const dir = fixture();
  mkdirSync(join(dir, 'graphs'));
  const testFile = join(dir, 'graphs', 'run-step.test.ts');
  writeFileSync(testFile, "import { runGraph } from '../../../src/graph-runner/runner.js';\n");
  expect(inspectPluginSecurity(dir).scan).toBe('safe');
  writeFileSync(join(dir, 'graphs', 'run-step.ts'), "import { runGraph } from '../../../src/graph-runner/runner.js';\n");
  expect(inspectPluginSecurity(dir).findings).toContainEqual({ level: 'dangerous', code: 'unsafe-import' });
  const secret = 'SECRET=superlongprivatevalue123456';
  writeFileSync(testFile, secret);
  const result = inspectPluginSecurity(dir);
  expect(result.findings).toContainEqual({ level: 'dangerous', code: 'embedded-secret' });
  expect(JSON.stringify(result)).not.toContain(secret);
});

test('NUL and oversized files fail closed without exposing their filenames or bytes', () => {
  const dir = fixture();
  const secret = 'SECRET=superlongprivatevalue123456';
  mkdirSync(join(dir, 'knowledge'));
  writeFileSync(join(dir, 'knowledge', `${secret}.bin`), Buffer.from([0, 65, 66]));
  writeFileSync(join(dir, `${secret}.ts`), 'x'.repeat(2_000_001));
  const decision = inspectPluginSecurity(dir);
  expect(decision.scan).toBe('dangerous');
  expect(decision.findings.filter(f => f.code === 'unscannable-file')).toHaveLength(2);
  expect(JSON.stringify(decision)).not.toContain(secret);
  writeFileSync(join(dir, 'knowledge', `${secret}.bin`), Buffer.from([65, 66]));
  rmSync(join(dir, `${secret}.ts`));
  const filenameOnly = inspectPluginSecurity(dir);
  expect(filenameOnly.scan).toBe('dangerous');
  expect(filenameOnly.findings).toContainEqual({ level: 'dangerous', code: 'credential-filename' });
  expect(JSON.stringify(filenameOnly)).not.toContain(secret);
});

test('unknown licenses stay private', () => {
  const dir = fixture();
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ name: 'sample', version: '1.0.0', license: 'Proprietary' }));
  expect(inspectPluginSecurity(dir)).toMatchObject({ license: 'restricted', scan: 'caution' });
});

test('a test file reached from the runtime (main or an import) is scanned like any executable file', () => {
  const dir = fixture();
  mkdirSync(join(dir, 'graphs'));
  writeFileSync(join(dir, 'graphs', 'evil.test.ts'), "import { runGraph } from '../../../src/graph-runner/runner.js';\nexport default {};\n");
  expect(inspectPluginSecurity(dir).findings).not.toContainEqual({ level: 'dangerous', code: 'unsafe-import' });
  // main points straight at the test file
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ name: 'sample', version: '1.0.0', main: './graphs/evil.test.ts' }));
  expect(inspectPluginSecurity(dir)).toMatchObject({ scan: 'dangerous' });
  expect(inspectPluginSecurity(dir).findings).toContainEqual({ level: 'dangerous', code: 'unsafe-import' });
  // main is a clean file that imports the test file (.js specifier resolves to the .ts source)
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ name: 'sample', version: '1.0.0', main: './plugin.ts' }));
  writeFileSync(join(dir, 'plugin.ts'), "import evil from './graphs/evil.test.js';\nexport default evil;\n");
  expect(inspectPluginSecurity(dir).findings).toContainEqual({ level: 'dangerous', code: 'unsafe-import' });
});

test('documented placeholder keys and call results are not secrets; real-looking values next to them still are', () => {
  const dir = fixture();
  mkdirSync(join(dir, 'specs'));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'specs', 'tavily.md'), [
    'client = TavilyClient(api_key="tvly-YOUR_API_KEY")',
    'const client = tavily({ apiKey: "tvly-YOUR_API_KEY" });',
    'TOKEN=xxxxxxxxxxxxxxxxxxxx',
    'secret: REPLACE_ME_WITH_THE_VALUE',
  ].join('\n'));
  writeFileSync(join(dir, 'src', 'ocr.ts'), 'export function run(getUpstageApiKey: () => string) {\n  const apiKey = getUpstageApiKey();\n  return apiKey;\n}\n');
  expect(inspectPluginSecurity(dir).findings).not.toContainEqual({ level: 'dangerous', code: 'embedded-secret' });
  // Counterexamples: still caught.
  for (const line of [
    'apiKey: "tvly-dev-8f3k2m9q1x7z4w6p"',          // vendor prefix, but a concrete value
    'const apiKey = "superlongprivatevalue123456";', // quoted literal in code
    'apiKey = superlongprivatevalue123456',          // unquoted literal, no call
    'token = "fetchTokenFromVaultNow("',             // quoted, looks like a call but is a string
    'SECRET=yourcompanysecretvalue123',              // contains "your" but is not a placeholder
    'token=ghp_realvalue1234567890(',                // unquoted value followed by "(" but not a function name
    'apiKey: sk-live1234567890abcd(see docs)',       // same, in prose
    'apiKey: "sk-live-abcxxxxxxxxxdef0123"',         // a run of x inside a real-looking key
    'apiKey: "sk-YOUR_live_7f3k2m9q1x7z"',           // YOUR_ inside a key that carries digits
  ]) {
    writeFileSync(join(dir, 'specs', 'leak.md'), `${line}\n`);
    const result = inspectPluginSecurity(dir);
    expect(result.findings, line).toContainEqual({ level: 'dangerous', code: 'embedded-secret' });
    expect(JSON.stringify(result)).not.toContain('superlongprivatevalue123456');
  }
  // The knowledge DLP branch shares the same rule: placeholders do not trip it, real values do.
  mkdirSync(join(dir, 'knowledge'));
  rmSync(join(dir, 'specs', 'leak.md'));
  writeFileSync(join(dir, 'knowledge', 'setup.md'), 'apiKey: "tvly-YOUR_API_KEY"\n');
  expect(inspectPluginSecurity(dir).findings).not.toContainEqual({ level: 'dangerous', code: 'knowledge-dlp' });
  writeFileSync(join(dir, 'knowledge', 'setup.md'), 'apiKey: "superlongprivatevalue123456"\n');
  expect(inspectPluginSecurity(dir).findings).toContainEqual({ level: 'dangerous', code: 'knowledge-dlp' });
  rmSync(join(dir, 'knowledge'), { recursive: true });
  // A placeholder elsewhere in the same file does not mask a real value.
  writeFileSync(join(dir, 'specs', 'leak.md'), 'apiKey: "tvly-YOUR_API_KEY"\napiKey: "superlongprivatevalue123456"\n');
  expect(inspectPluginSecurity(dir).findings).toContainEqual({ level: 'dangerous', code: 'embedded-secret' });
});

test('imports of the package\'s own src/ are allowed; imports that leave the package root are not', () => {
  const dir = fixture();
  mkdirSync(join(dir, 'scripts'));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'router.ts'), 'export const route = 1;\n');
  writeFileSync(join(dir, 'scripts', 'main.ts'), "import { route } from '../src/router.ts';\nexport default route;\n");
  writeFileSync(join(dir, 'plugin.ts'), "import { route } from './src/router.js';\nexport default route;\n");
  expect(inspectPluginSecurity(dir)).toMatchObject({ scan: 'safe', findings: [] });
  // Counterexamples: still caught.
  for (const target of ['../../src/graph-runner/runner.js', '/usr/local/elanous/src/graph-runner/runner.js', '../../../etc/passwd', 'file:///usr/local/elanous/src/x.js']) {
    writeFileSync(join(dir, 'scripts', 'main.ts'), `import x from '${target}';\nexport default x;\n`);
    expect(inspectPluginSecurity(dir).findings, target).toContainEqual({ level: 'dangerous', code: 'unsafe-import' });
  }
});
