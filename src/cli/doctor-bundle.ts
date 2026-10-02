import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, lstatSync, mkdtempSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, platform, arch } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { getElanousConfigDir } from '../elanous-config-dir.js';
import { resolveCurrentInstance } from '../instance/current.js';
import { LogStore, logsDbPath, type LogStoreRow } from '../mss/logging/log-store.js';
import { cliVersion, codeRevision, packageVersion } from '../version/code-revision.js';
import { runDoctor, defaultReadInstallPrefix, type DoctorOptions, type DoctorReport } from './doctor-cli.js';

const REDACTED = '<redacted>';

/** Recursively redact named secrets and secret-shaped text before serialization. */
export function redactForBundle(value: unknown, home: string = homedir(), redactNamedFields: boolean = true): unknown {
  if (typeof value === 'string') {
    let text = value;
    if (home && home !== sep) {
      // Match the home as a path component, including JSON-escaped slashes.
      const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      text = text.replace(new RegExp(`${escaped}(?=[/\\\\]|$)`, 'g'), '~');
    }
    // By kind, not by the last example found: headers that carry credentials, credentials inside URLs,
    // known token shapes, and any `name=value` / `"name": "value"` whose name says it is a credential.
    return text
      .replace(/\b((?:Proxy-)?Authorization\s*:\s*)[^\r\n"']+/gi, `$1${REDACTED}`)
      .replace(/\b((?:Set-)?Cookie\s*:\s*)[^\r\n"']+/gi, `$1${REDACTED}`)
      .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@"'<>]+@/gi, `$1${REDACTED}@`)
      .replace(/(["']?(?:[\w-]*(?:token|key|secret|password|passwd|pwd|cookie|session|credential|auth))["']?\s*[:=]\s*["']?)[^\s"',}&]+/gi, `$1${REDACTED}`)
      .replace(/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/g, `$1 ${REDACTED}`)
      .replace(/\b(?:sk-[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|glpat-[A-Za-z0-9_-]+|xox[a-z]-[A-Za-z0-9-]+|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35})\b/g, REDACTED)
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED);
  }
  if (Array.isArray(value)) return value.map((entry) => redactForBundle(entry, home, redactNamedFields));
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = Object.create(null);
    for (const [key, entry] of Object.entries(value)) {
      const safeKey = redactForBundle(key, home) as string;
      result[safeKey] = redactNamedFields && /(?:token|key|secret|password|passwd|pwd|authorization|cookie|session|credential|auth)/i.test(key)
        ? REDACTED : redactForBundle(entry, home, redactNamedFields);
    }
    return result;
  }
  return value;
}

export interface DoctorBundleOptions {
  outDir: string;
  now?: Date;
  /** Read-only doctor seams for isolated tests. */
  doctorOptions?: DoctorOptions;
  home?: string;
  configDir?: string;
  logDbPath?: string;
  doctorReport?: DoctorReport;
}

export interface DoctorBundleResult { path: string; files: string[]; bytes: number }

/** Bundle only generated, redacted entries. Never put an unprocessed source file into tar. */
export function buildDoctorBundle({ outDir, now = new Date(), doctorOptions = {}, home = homedir(), configDir = getElanousConfigDir(), logDbPath = logsDbPath(), doctorReport }: DoctorBundleOptions): DoctorBundleResult {
  const instant = now.toISOString();
  const stamp = instant.replace(/[-:]/g, '').slice(0, 15).replace('T', '-');
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const destination = resolve(outDir, `elanous-diagnostics-${stamp}.tar.gz`);
  if (existsSync(destination)) throw new Error('diagnostics archive already exists');
  const work = mkdtempSync(join(outDir, '.elanous-diagnostics-'));
  const files: string[] = [];
  const put = (name: string, data: unknown): void => {
    writeFileSync(join(work, name), JSON.stringify(redactForBundle(data, home, name === 'config.redacted.json' || name === 'onboarding.json'), null, 2) + '\n', { mode: 0o600 });
    files.push(name);
  };
  try {
    const report = doctorReport ?? runDoctor(doctorOptions);
    const universe = resolveCurrentInstance({ cwd: () => process.cwd() });
    const packageRoot = resolve(import.meta.dir, '../..');
    const installPrefix = doctorOptions.readInstallPrefix?.() ?? defaultReadInstallPrefix(packageRoot, existsSync);
    let logs: LogStoreRow[] = [];
    let logStatus: 'ok' | 'no-store' = 'no-store';
    if (existsSync(logDbPath)) {
      try {
        const store = LogStore.openReadOnly(logDbPath);
        try {
          logs = store.query({ sinceMs: now.getTime() - 86_400_000, untilMs: now.getTime(), limit: 500 });
          logStatus = 'ok';
        } finally { store.close(); }
      } catch { /* Unreadable store: export no unverified log bytes. */ }
    }
    put('summary.json', {
      version: packageVersion(), sha: codeRevision() ?? 'unknown', cliVersion: cliVersion(),
      os: platform(), arch: arch(), node: process.version, bun: typeof Bun === 'undefined' ? null : Bun.version,
      installPath: installPrefix ?? packageRoot,
      universe: { kind: universe.kind, root: universe.root }, createdAt: instant, logs: logStatus,
    });
    put('doctor.json', report);
    let config: unknown = {};
    const configPath = doctorOptions.configPath ?? join(configDir, 'config.json');
    try {
      if (lstatSync(configPath).isFile()) config = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch { config = { status: 'unavailable' }; }
    put('config.redacted.json', config);
    put('credentials.json', report.credentials.map(({ name, resolved, source }) => ({ name, present: resolved, source })));
    writeFileSync(join(work, 'logs-recent.jsonl'), logs.map((row) => {
      const entry = row as { data: string | null };
      let data = entry.data;
      if (data) {
        try { data = JSON.stringify(redactForBundle(JSON.parse(data), home)); }
        catch { /* Non-JSON log bodies are redacted as plain text below. */ }
      }
      return JSON.stringify(redactForBundle({ ...row, data }, home, false));
    }).join('\n') + (logs.length ? '\n' : ''), { mode: 0o600 });
    files.push('logs-recent.jsonl');
    const onboardingPath = join(configDir, 'onboarding.json');
    try {
      if (lstatSync(onboardingPath).isFile()) put('onboarding.json', JSON.parse(readFileSync(onboardingPath, 'utf8')));
    } catch { /* An absent or unreadable optional record is not exported. */ }
    const archiveFd = openSync(destination, 'wx', 0o600);
    let tarSucceeded = false;
    try {
      const tar = spawnSync('tar', ['-czf', '-', '-C', work, ...files], { stdio: ['ignore', archiveFd, 'pipe'], timeout: 30_000 });
      tarSucceeded = !tar.error && tar.status === 0;
    } finally {
      closeSync(archiveFd);
      if (!tarSucceeded) rmSync(destination, { force: true });
    }
    if (!tarSucceeded) throw new Error('could not create diagnostics archive');
    return { path: destination, files, bytes: statSync(destination).size };
  } finally { rmSync(work, { recursive: true, force: true }); }
}
