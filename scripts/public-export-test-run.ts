#!/usr/bin/env bun
/** Compare tests in an exported checkout with the same tests in the source checkout. */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { privateRedactionsPath, run as exportRun } from './public-export.js';

export interface Comparison {
  exportOnly: string[];
  preexisting: string[];
  notExported: string[];
  exportRan: number;
  privateRan: number;
}

function command(bin: string, args: string[], cwd: string) {
  const result = spawnSync(bin, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  return result;
}

function testFiles(root: string, dir = root): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === '.git' || entry.name === 'node_modules') return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return testFiles(root, path);
    return entry.isFile() && entry.name.endsWith('.test.ts') ? [relative(root, path)] : [];
  });
}

function measure(root: string, files: string[]): { ran: number; failures: Set<string> } | undefined {
  const result = command('bun', ['test', ...files], root);
  const output = `${result.stdout}\n${result.stderr}`;
  const summary = output.match(/^Ran (\d+) tests?\b/mu);
  const failed = [...output.matchAll(/^\s*\(fail\)\s+(.+?)\s*$/gmu)].map((match) => match[1]!.replace(/\s+\[\d+(?:\.\d+)?m?s\]$/u, ''));
  const failures = new Set(failed);
  const reportedFails = output.match(/^\s*(\d+) fail\s*$/mu);
  if (!summary || result.status === null ||
      /Unhandled error between tests/u.test(output) || /^\s*\d+ errors?\s*$/mu.test(output) ||
      (result.status !== 0 && (!reportedFails || Number(reportedFails[1]) !== failed.length)) ||
      (result.status === 0 && failed.length > 0)) {
    console.error(`measurement failed in ${root}: ${output.trim()}`);
    return undefined;
  }
  return { ran: Number(summary[1]), failures };
}

/** CLI entrypoint; root is injectable for isolated fixture repositories. */
export function run(argv: readonly string[], root = resolve(import.meta.dir, '..')): number {
  let json = false;
  let keep = false;
  let list: string | undefined;
  const args: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--json') json = true;
    else if (arg === '--keep') keep = true;
    else if (arg === '--files') {
      list = argv[++i];
      if (!list) { console.error('--files needs a list file'); return 2; }
    } else if (arg.startsWith('--')) { console.error(`unknown option: ${arg}`); return 2; }
    else args.push(arg);
  }
  const temporary = mkdtempSync(join(tmpdir(), 'public-export-test-run-'));
  const exported = join(temporary, 'export');
  try {
    // The exporter reports leak hits as status 1 even after successfully copying the tree.
    // Its stdout is not part of the comparison JSON contract.
    const log = console.log;
    let exportStatus: number;
    try {
      console.log = (...parts: unknown[]) => { console.error(...parts); };
      exportStatus = exportRun(['--out', exported], root);
    } finally { console.log = log; }
    if (exportStatus === 2 || !existsSync(exported)) return 2;
    const git = (params: string[]) => {
      const result = command('git', params, exported);
      if (result.status !== 0) throw new Error(`git ${params[0]}: ${result.stderr}`);
    };
    git(['init', '-q']);
    git(['add', '-A']);
    git(['-c', 'user.name=Export Test', '-c', 'user.email=export-test@example.com', 'commit', '-qm', 'Export test fixture', '--allow-empty']);
    const modules = existsSync(join(root, 'node_modules')) ? join(root, 'node_modules') : resolve(import.meta.dir, '../node_modules');
    symlinkSync(modules, join(exported, 'node_modules'), 'dir');

    const requested = [...(list ? readFileSync(resolve(root, list), 'utf8').split(/\r?\n/u).map((s) => s.trim()).filter(Boolean) : []), ...args];
    if (list !== undefined && requested.length === 0) { console.error('measurement failed: empty --files selection'); return 2; }
    const normalized = [...new Set((list === undefined && args.length === 0 ? testFiles(exported) : requested).map((file) => {
      const path = relative(root, resolve(root, file));
      if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) throw new Error(`test outside repository: ${file}`);
      return path;
    }))];
    const notExported = normalized.filter((file) => !existsSync(join(exported, file)));
    const files = normalized.filter((file) => existsSync(join(exported, file)));
    if (!files.length) { console.error('measurement failed: no exported tests selected'); return 2; }
    const exactFiles = files.map((file) => `./${file}`);
    const publicResult = measure(exported, exactFiles);
    const privateResult = measure(root, exactFiles);
    if (!publicResult || !privateResult) return 2;
    const exportOnly = [...publicResult.failures].filter((name) => !privateResult.failures.has(name));
    const preexisting = [...publicResult.failures].filter((name) => privateResult.failures.has(name));
    const comparison: Comparison = { exportOnly, preexisting, notExported, exportRan: publicResult.ran, privateRan: privateResult.ran };
    if (json) console.log(JSON.stringify(comparison));
    else {
      console.log(`export-only (${exportOnly.length}): ${exportOnly.join(', ')}`);
      console.log(`preexisting (${preexisting.length}): ${preexisting.join(', ')}`);
      console.log(`not-exported (${notExported.length}): ${notExported.join(', ')}`);
      console.log(`Ran ${publicResult.ran} exported / ${privateResult.ran} private tests`);
    }
    return exportOnly.length ? 1 : 0;
  } catch (error) {
    console.error(error);
    return 2;
  } finally {
    if (keep) console.error(`kept export: ${temporary}`);
    else rmSync(temporary, { recursive: true, force: true });
  }
}

// GATE-REMOTE (10-06): `--remote [host]` runs the same commit on that host and prints its result (JSON gains host · remote:true);
//   `--local` forces this machine. Without either, a busy machine (1-min load > gateRemote.loadThreshold) dispatches on its own.
if (import.meta.main) void (async () => {
  const { extractGateRemoteFlags, dispatchHeavyCheck, unreproducibleArgs, relativizeArgs } = await import('../src/self-implement/gate-remote.js');
  const flags = extractGateRemoteFlags(process.argv.slice(2));
  if (flags.error) { console.error(flags.error); process.exit(2); }
  const repo = resolve(import.meta.dir, '..');
  // The private redaction table changes exported file contents — the remote export must use the same one or the comparison differs.
  const table = privateRedactionsPath();
  const payloadFiles = existsSync(table) ? [{ env: 'ELANOUS_EXPORT_REDACTIONS', content: readFileSync(table, 'utf8') }] : [];
  // File arguments, the --files list and its entries resolve against the repository root (as run() does).
  const paths = flags.rest.filter((arg) => !arg.startsWith('--'));
  const listIndex = flags.rest.indexOf('--files');
  const list = listIndex >= 0 ? flags.rest[listIndex + 1] : undefined;
  // List entries reach the host verbatim (only positional arguments are rewritten), so an absolute entry is not portable.
  const absoluteEntries: string[] = [];
  if (list) {
    try {
      const entries = readFileSync(resolve(repo, list), 'utf8').split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
      absoluteEntries.push(...entries.filter((entry) => isAbsolute(entry)));
      paths.push(...entries);
    } catch { /* run() reports it */ }
  }
  process.exitCode = await dispatchHeavyCheck({
    payloadFiles,
    localOnlyReason: (() => {
      // Each must be a tracked file inside the repository, or the remote checkout would measure something else.
      const bad = [...new Set([...absoluteEntries, ...unreproducibleArgs(paths, repo)])];
      return bad.length ? `file argument not reproducible on the host (outside the repository or not tracked at HEAD): ${bad.join(' ')}` : undefined;
    })(),
    tool: 'public-export-test-run', repo, flags, json: flags.rest.includes('--json'),
    installPwa: paths.some((arg) => arg.includes('apps/pwa')),
    remoteArgv: ['bun', 'scripts/public-export-test-run.ts', '--local', ...relativizeArgs(flags.rest, repo)],
    runLocal: () => run(flags.rest),
  });
})();
