/** Ratchet for daemon port literals in non-test TypeScript source. */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const BASELINE_FILE = 'scripts/daemon-port-baseline.txt';
const PORT = '31415';

type Hit = { lineNumber: number; line: string };
type DaemonPortGateIo = {
  args?: readonly string[];
  cwd?: string;
  scan?: () => Map<string, Hit[]>;
  loadBaseline?: () => Map<string, number>;
  writeBaseline?: (entries: Map<string, number>) => void;
  log?: (message: string) => void;
  error?: (message: string) => void;
};

/** Only comment-only lines are ignored; executable code with trailing comments is counted. */
export function scanDaemonPortSource(source: string): Hit[] {
  let inBlockComment = false;
  let quote: "'" | '"' | null = null;
  const frames: Array<{ kind: 'template' } | { kind: 'expression'; depth: number }> = [];
  return source.split('\n').flatMap((line, index) => {
    let code = '';
    for (let offset = 0; offset < line.length;) {
      const char = line[offset]!;
      const next = line[offset + 1];
      const frame = frames.at(-1);
      if (frame?.kind === 'template') {
        if (char === '\\' && next !== undefined) {
          code += char + next;
          offset += 2;
        } else if (char === '$' && next === '{') {
          code += '${';
          frames.push({ kind: 'expression', depth: 0 });
          offset += 2;
        } else {
          code += char;
          if (char === '`') frames.pop();
          offset++;
        }
      } else if (inBlockComment) {
        if (char === '*' && next === '/') {
          inBlockComment = false;
          offset += 2;
        } else offset++;
      } else if (quote) {
        code += char;
        if (char === '\\' && next !== undefined) {
          code += next;
          offset += 2;
        } else {
          if (char === quote) quote = null;
          offset++;
        }
      } else if (char === '/' && next === '*') {
        inBlockComment = true;
        offset += 2;
      } else if (char === '/' && next === '/') {
        break;
      } else {
        code += char;
        if (char === "'" || char === '"') quote = char;
        else if (char === '`') frames.push({ kind: 'template' });
        else if (frame?.kind === 'expression') {
          if (char === '{') frame.depth++;
          else if (char === '}' && --frame.depth < 0) frames.pop();
        }
        offset++;
      }
    }
    quote = null;
    const trimmed = line.trim();
    return code.trim() && code.includes(PORT)
      ? [{ lineNumber: index + 1, line: trimmed }]
      : [];
  });
}

export function scanDaemonPorts(root = ROOT): Map<string, Hit[]> {
  const entries = new Map<string, Hit[]>();
  const src = join(root, 'src');
  if (!existsSync(src)) return entries;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.spec.ts')) {
        const hits = scanDaemonPortSource(readFileSync(path, 'utf8'));
        if (hits.length) entries.set(relative(root, path), hits);
      }
    }
  };
  walk(src);
  return entries;
}

export function readDaemonPortBaseline(text: string): Map<string, number> {
  const baseline = new Map<string, number>();
  for (const line of text.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const match = /^(\d+)\t(src\/[^\t]+\.ts)$/.exec(line);
    if (!match) throw new Error(`Invalid daemon port baseline row: ${line}`);
    baseline.set(match[2]!, Number(match[1]));
  }
  return baseline;
}

export function renderDaemonPortBaseline(entries: Map<string, number>): string {
  const lines = [...entries].sort(([a], [b]) => a.localeCompare(b)).map(([file, count]) => `${count}\t${file}`);
  const total = [...entries.values()].reduce((sum, count) => sum + count, 0);
  return [
    '# Daemon port literal baseline: non-comment lines in non-test src/**/*.ts, per file.',
    '# New files and increases fail. Migrate callers to the daemon endpoint resolver, then --update.',
    `# total=${total} files=${entries.size}`,
    ...lines,
    '',
  ].join('\n');
}

export function runDaemonPortGate(io: DaemonPortGateIo = {}): number {
  const args = io.args ?? process.argv.slice(2);
  const log = io.log ?? console.log;
  const error = io.error ?? console.error;
  const root = io.cwd ?? ROOT;
  if (args.some(arg => arg !== '--update')) {
    error('[daemon-port-gate] FAIL — only --update is supported; the gate always scans all source files.');
    return 1;
  }
  const current = io.scan ? io.scan() : scanDaemonPorts(root);
  const count = [...current.values()].reduce((sum, hits) => sum + hits.length, 0);
  log(`[daemon-port-gate] observed ${count} line(s) in ${current.size} file(s).`);
  const baselinePath = join(root, BASELINE_FILE);
  if (args.includes('--update')) {
    const counts = new Map([...current].map(([file, hits]) => [file, hits.length]));
    (io.writeBaseline ?? ((entries) => writeFileSync(baselinePath, renderDaemonPortBaseline(entries))))(counts);
    log(`[daemon-port-gate] baseline updated: ${count} line(s) in ${current.size} file(s).`);
    return 0;
  }
  if (!io.loadBaseline && !existsSync(baselinePath)) {
    error(`[daemon-port-gate] FAIL — missing baseline: ${baselinePath}; run --update to measure it.`);
    return 1;
  }
  const baseline = io.loadBaseline ? io.loadBaseline() : readDaemonPortBaseline(readFileSync(baselinePath, 'utf8'));
  let violations = 0;
  for (const [file, hits] of current) {
    const allowed = baseline.get(file) ?? 0;
    if (hits.length <= allowed) continue;
    violations++;
    error(`  ${file}: ${allowed} → ${hits.length} (+${hits.length - allowed} daemon port line(s))`);
    for (const hit of hits) error(`    ${file}:${hit.lineNumber}: ${hit.line.slice(0, 160)}`);
  }
  if (violations) {
    error('[daemon-port-gate] FAIL — replace new daemon port literals with resolveDaemonEndpoint (src/nexus/daemon-endpoint.ts).');
    return 1;
  }
  log('[daemon-port-gate] PASS — no new daemon port literals.');
  return 0;
}

if (import.meta.main) process.exit(runDaemonPortGate());
