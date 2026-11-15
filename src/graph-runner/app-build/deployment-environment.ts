import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { macAppSandboxProfile } from '../../nexus/apps/app-service-runtime.js';
import { runShell } from '../../shell-primitive/index.js';
import { DEFAULT_TIMEOUT_MS, SHELL_MAX_OUTPUT } from '../../shell-primitive/types.js';
import { writeFileArtifact } from '../../tool-runtime/file-artifact.js';

export interface DeploymentEnvironment {
  readonly runtime: { command: string; version: string; platform: string };
  readonly builtinModules: readonly string[];
  readonly testModules: readonly string[];
  readonly storageModules: readonly string[];
  readonly apiSurfaces?: readonly ApiSurface[];
  readonly nodeModulesPresent: boolean;
  readonly installedPackages: readonly string[];
  readonly packageInstallAvailable: boolean;
  readonly network: 'off';
  readonly writableArtifactRoot: boolean;
  readonly writableTempRoot: boolean;
  readonly portBindingAvailable: boolean;
  readonly sandbox: 'darwin-private-netoff-envempty';
}

export interface ApiSurface {
  readonly module: string;
  readonly exports: readonly string[];
  readonly classes: readonly { name: string; methods: readonly string[] }[];
}

export interface UnavailableImport { readonly path: string; readonly line: number; readonly specifier: string }

const probeSource = [
  "import { builtinModules } from 'node:module';",
  "import { existsSync, readdirSync, writeFileSync } from 'node:fs';",
  "import { join } from 'node:path';",
  "const candidates = [...new Set([...builtinModules.flatMap(name => name.startsWith('node:') ? [name, name.slice(5)] : [name, 'node:' + name]), 'bun', 'bun:sqlite', 'node:sqlite'])].sort();",
  'const modules = [];',
  'for (const name of candidates) { try { await import(name); modules.push(name); } catch {} }',
  "const availableStorage = modules.filter(name => /sqlite|sql|database/iu.test(name));",
  'const apiSurfaces = [];',
  'for (const name of availableStorage) { const loaded = await import(name); const classes = []; const seenClasses = new Set();',
  '  for (const [className, value] of Object.entries(loaded)) {',
  "    if (typeof value !== 'function' || !value.prototype || seenClasses.has(value)) continue; seenClasses.add(value);",
  "    const methods = Object.entries(Object.getOwnPropertyDescriptors(value.prototype)).filter(([method, descriptor]) => method !== 'constructor' && typeof descriptor.value === 'function').map(([method]) => method).sort();",
  '    if (methods.length) classes.push({ name: className, methods });',
  '  }',
  '  apiSurfaces.push({ module: name, exports: Object.keys(loaded).sort(), classes });',
  '}',
  "let writableArtifactRoot = false; try { writeFileSync(join(process.cwd(), 'probe-write.tmp'), 'ok'); writableArtifactRoot = true; } catch {}",
  "let writableTempRoot = false; try { writeFileSync(join(process.env.TMPDIR ?? '', 'probe-temp.tmp'), 'ok'); writableTempRoot = true; } catch {}",
  "let portBindingAvailable = false; try { const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('ok') }); server.stop(true); portBindingAvailable = true; } catch {}",
  "const modulesDir = join(process.cwd(), 'node_modules');",
  "const installedPackages = []; if (existsSync(modulesDir)) for (const entry of readdirSync(modulesDir, { withFileTypes: true })) {",
  "  if (!entry.isDirectory() || entry.name.startsWith('.')) continue;",
  "  if (entry.name.startsWith('@')) { for (const child of readdirSync(join(modulesDir, entry.name), { withFileTypes: true })) {",
  "    if (child.isDirectory()) installedPackages.push(entry.name + '/' + child.name);",
  "  } } else installedPackages.push(entry.name);",
  "}",
  'console.log(JSON.stringify({ version: Bun.version, platform: process.platform, builtinModules: modules, storageModules: availableStorage,',
  "  nodeModulesPresent: existsSync(modulesDir), installedPackages, apiSurfaces, writableArtifactRoot, writableTempRoot, portBindingAvailable }));",
].join('\n');

/** Measure the same private, empty-env, network-off sandbox used by app-build verification. */
export async function diagnoseDeploymentEnvironment(root: string, runtimeCommand = 'bun'): Promise<DeploymentEnvironment> {
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec')) throw new Error('BUILD_ENVIRONMENT_UNAVAILABLE');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const attempt = mkdtempSync(join(root, 'probe-'));
  const app = join(attempt, 'app');
  try {
    writeFileArtifact({ root: app, files: [{ path: 'probe.ts', content: probeSource },
      { path: 'probe.test.ts', content: "import { test } from 'bun:test'; test('module available', () => {});" }], metadata: {} });
    const runtime = realpathSync(process.execPath);
    const profile = macAppSandboxProfile({ readRoot: app, writeRoot: app,
      wrapper: join(app, 'source-artifact.json'), bunBinary: runtime });
    const measured = await runShell({ command: ['/usr/bin/env', '-i', 'HOME=' + app, 'TMPDIR=' + app, 'PATH=/usr/bin:/bin',
      '/usr/bin/sandbox-exec', '-p', profile, runtime, 'probe.ts'],
    cwd: app, sandbox: 'off', network: 'off', approval: 'none', timeoutMs: DEFAULT_TIMEOUT_MS, maxOutputChars: SHELL_MAX_OUTPUT });
    if (measured.outcome !== 'exit' || measured.exitCode !== 0) throw new Error('BUILD_ENVIRONMENT_UNAVAILABLE');
    const testProbe = await runShell({ command: ['/usr/bin/env', '-i', 'HOME=' + app, 'TMPDIR=' + app, 'PATH=/usr/bin:/bin',
      '/usr/bin/sandbox-exec', '-p', profile, runtime, 'test', 'probe.test.ts'],
    cwd: app, sandbox: 'off', network: 'off', approval: 'none', timeoutMs: DEFAULT_TIMEOUT_MS, maxOutputChars: SHELL_MAX_OUTPUT });
    const row: unknown = JSON.parse(measured.stdout.trim());
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('BUILD_ENVIRONMENT_UNAVAILABLE');
    const value = row as Record<string, unknown>;
    if (typeof value.version !== 'string' || typeof value.platform !== 'string'
      || !Array.isArray(value.builtinModules) || !value.builtinModules.every(item => typeof item === 'string')
      || !Array.isArray(value.storageModules) || !value.storageModules.every(item => typeof item === 'string')
      || !Array.isArray(value.apiSurfaces)
      || !Array.isArray(value.installedPackages) || !value.installedPackages.every(item => typeof item === 'string')
      || typeof value.nodeModulesPresent !== 'boolean' || typeof value.writableArtifactRoot !== 'boolean'
      || typeof value.writableTempRoot !== 'boolean' || typeof value.portBindingAvailable !== 'boolean') {
      throw new Error('BUILD_ENVIRONMENT_UNAVAILABLE');
    }
    return { runtime: { command: runtimeCommand, version: value.version, platform: value.platform },
      builtinModules: value.builtinModules as string[], testModules: testProbe.outcome === 'exit' && testProbe.exitCode === 0 ? ['bun:test'] : [],
      storageModules: value.storageModules as string[], apiSurfaces: value.apiSurfaces as ApiSurface[],
      nodeModulesPresent: value.nodeModulesPresent, installedPackages: value.installedPackages as string[],
      // The execution policy denies network and does not mount a package store; generated apps cannot install dependencies here.
      packageInstallAvailable: false, network: 'off', writableArtifactRoot: value.writableArtifactRoot,
      writableTempRoot: value.writableTempRoot, portBindingAvailable: value.portBindingAvailable,
      sandbox: 'darwin-private-netoff-envempty' };
  } finally { rmSync(attempt, { recursive: true, force: true }); }
}

export function environmentContract(environment: DeploymentEnvironment): string {
  const allowed = environment.builtinModules.join(', ');
  return ['Measured deployment sandbox:',
    `runtime ${environment.runtime.command} ${environment.runtime.version} on ${environment.runtime.platform}`,
    `network ${environment.network}; package installation ${environment.packageInstallAvailable ? 'available' : 'unavailable'}; node_modules ${environment.nodeModulesPresent ? 'present' : 'absent'}`,
    `installed packages: ${environment.installedPackages.join(', ') || 'none'}`,
    `test-only modules: ${environment.testModules.join(', ') || 'none'}`,
    `writable artifact root ${environment.writableArtifactRoot}; writable temp root ${environment.writableTempRoot}; port binding ${environment.portBindingAvailable}`,
    `import relative files, measured built-in modules (${allowed}), or installed packages listed above`,
    `available storage modules: ${environment.storageModules.join(', ') || 'none'}`,
    ...apiSurfaceLines(environment),
    `Tests run with ${environment.runtime.command} test in this network-off sandbox; do not start subprocesses.`,
    'Use an available storage module when persistence is needed. The backend entry exports fetch(request) or default {fetch}; do not start a listener at import. The host owns the service port.',
  ].join('\n');
}

export function apiSurfaceLines(environment: DeploymentEnvironment): string[] {
  return (environment.apiSurfaces ?? []).flatMap(surface => [
    `${surface.module} exports: ${surface.exports.join(', ') || 'none'}`,
    ...surface.classes.map(item => `${surface.module} ${item.name}.prototype methods: ${item.methods.join(', ') || 'none'}`),
  ]);
}

export function missingMethodHint(diagnostic: string, environment: DeploymentEnvironment): string {
  const methods = [...diagnostic.matchAll(/\b([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*) is not a function\b/gu)]
    .map(match => match[2]!).slice(0, 3);
  if (!methods.length) return '';
  const observed = (environment.apiSurfaces ?? []).flatMap(surface => surface.classes.flatMap(item =>
    item.methods.map(method => ({ module: surface.module, className: item.name, method }))));
  const unavailable = methods.filter(method => !observed.some(item => item.method === method));
  return [
    unavailable.length ? `Failed method(s) absent from measured storage API surfaces: ${unavailable.join(', ')}.` : '',
    ...apiSurfaceLines(environment),
  ].filter(Boolean).join('\n');
}

export function environmentSummary(environment: DeploymentEnvironment): string {
  return `환경 진단: ${environment.runtime.command} ${environment.runtime.version} · 내장 저장소 ${environment.storageModules.join(', ') || '없음'} · 패키지 설치 ${environment.packageInstallAvailable ? '가능' : '불가'} · 네트워크 ${environment.network} · 쓰기 ${environment.writableArtifactRoot ? '가능' : '불가'} · 포트 ${environment.portBindingAvailable ? '가능' : '불가'}`;
}

/** The same measured allowlist drives the prompt and the pre-sandbox import check. */
export function unavailableImports(files: readonly { path: string; content: string }[], environment: DeploymentEnvironment): UnavailableImport[] {
  const allowed = new Set(environment.builtinModules);
  const installed = new Set(environment.installedPackages);
  const issues: UnavailableImport[] = [];
  for (const file of files) {
    if (!/\.[cm]?[jt]sx?$/u.test(file.path)) continue;
    const source = ts.createSourceFile(file.path, file.content, ts.ScriptTarget.Latest, true);
    const inspect = (name: string, at: ts.Node) => {
      if (/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file.path) && environment.testModules.includes(name)) return;
      if (name.startsWith('./') || name.startsWith('../') || allowed.has(name)) return;
      const packageName = name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0];
      if (packageName && installed.has(packageName)) return;
      issues.push({ path: file.path, line: source.getLineAndCharacterOfPosition(at.getStart(source)).line + 1,
        specifier: name });
    };
    const visit = (node: ts.Node): void => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier
        && ts.isStringLiteralLike(node.moduleSpecifier)) inspect(node.moduleSpecifier.text, node.moduleSpecifier);
      if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
        && node.moduleReference.expression && ts.isStringLiteralLike(node.moduleReference.expression))
        inspect(node.moduleReference.expression.text, node.moduleReference.expression);
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
        const first = node.arguments[0];
        inspect(first && ts.isStringLiteralLike(first) ? first.text : '<dynamic-module>', first ?? node);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return issues;
}

export function unavailableImportHint(issues: readonly UnavailableImport[], environment: DeploymentEnvironment): string {
  return `Pre-sandbox import validation failed: ${issues.map(item => `${item.path}:${item.line} imports ${item.specifier}`).join('; ')}. `
    + `Package installation is ${environment.packageInstallAvailable ? 'available' : 'unavailable'} in the measured sandbox. `
    + `Replace unavailable or dynamic imports with literal relative files, measured built-ins, or installed packages. `
    + `Available storage modules: ${environment.storageModules.join(', ') || 'none'}.`;
}

export function writeEnvironmentReceipt(root: string, runId: string, environment: DeploymentEnvironment): { path: string; sha256: string } {
  if (!/^[A-Za-z0-9-]{1,128}$/u.test(runId)) throw new Error('BUILD_ENVIRONMENT_RECEIPT_INVALID');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = join(realpathSync(root), `${runId}.json`);
  const text = JSON.stringify(environment, null, 2) + '\n';
  try { writeFileSync(path, text, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || readFileSync(path, 'utf8') !== text) throw error;
  }
  const receipt = { path, sha256: createHash('sha256').update(text).digest('hex') };
  readEnvironmentReceipt(root, runId, receipt);
  return receipt;
}

/** Resume reads only the private receipt written for this run, never a graph-supplied environment body. */
export function readEnvironmentReceipt(root: string, runId: string, receipt: { path: string; sha256: string }): DeploymentEnvironment {
  if (receipt.path !== join(realpathSync(root), `${runId}.json`) || !/^[0-9a-f]{64}$/u.test(receipt.sha256)) throw new Error('BUILD_ENVIRONMENT_RECEIPT_INVALID');
  const stat = lstatSync(receipt.path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0
    || stat.size > 65536 || process.getuid && stat.uid !== process.getuid() || realpathSync(receipt.path) !== receipt.path) {
    throw new Error('BUILD_ENVIRONMENT_RECEIPT_INVALID');
  }
  const text = readFileSync(receipt.path, 'utf8');
  if (createHash('sha256').update(text).digest('hex') !== receipt.sha256) throw new Error('BUILD_ENVIRONMENT_RECEIPT_INVALID');
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('BUILD_ENVIRONMENT_RECEIPT_INVALID');
  const row = value as Record<string, unknown>;
  const runtime = row.runtime as Record<string, unknown> | undefined;
  if (!runtime || typeof runtime.command !== 'string' || typeof runtime.version !== 'string'
    || !Array.isArray(row.builtinModules) || !row.builtinModules.every(item => typeof item === 'string')
    || !Array.isArray(row.testModules) || !row.testModules.every(item => typeof item === 'string')
    || !Array.isArray(row.storageModules) || !row.storageModules.every(item => typeof item === 'string')
    || row.apiSurfaces !== undefined && !Array.isArray(row.apiSurfaces)
    || !Array.isArray(row.installedPackages) || !row.installedPackages.every(item => typeof item === 'string')
    || row.network !== 'off' || row.sandbox !== 'darwin-private-netoff-envempty') throw new Error('BUILD_ENVIRONMENT_RECEIPT_INVALID');
  return value as DeploymentEnvironment;
}
