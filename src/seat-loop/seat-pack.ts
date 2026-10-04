import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { userInfo } from 'node:os';
import { DEFAULT_CONCURRENT_PODS, DEFAULT_DAILY_GOALS } from '../org/seat-budget.js';

export interface SeatPackManifest {
  name: string;
  version: string;
  files: Array<{ path: string; sha256: string }>;
}

export class SeatPackLeakError extends Error {
  constructor(file: string, line: number, marker: string) {
    super(`${file}:${line}: public leak (${marker})`);
  }
}

function regularFile(path: string): boolean {
  return lstatSync(path).isFile();
}

function walk(directory: string, root: string): string[] {
  if (!existsSync(directory)) return [];
  if (!lstatSync(directory).isDirectory()) throw new Error(`not a directory: ${relative(root, directory)}`);
  return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`symlink in seat pack: ${relative(root, path)}`);
      return entry.isDirectory() ? walk(path, root) : entry.isFile() ? [relative(root, path)] : [];
    });
}

function scan(file: string, body: string): void {
  const usernames = new Set([userInfo().username, process.env.ELANOUS_LEAK_HOME_USER].filter((name): name is string => Boolean(name)));
  const accountPatterns = [...usernames].map((name) => new RegExp(`(?<![A-Za-z0-9._-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9._-])`, 'iu'));
  const patterns: Array<[string, RegExp]> = [
    ['royal marker', /\u{1F451}/u],
    ['track marker', /(?:🅞|🅣|🅢|🅕|\*\*\[(?:OP|TC|MK|UX|S|T|O|F)\]\*\*|\[(?:OP|TC|MK|UX|S|T|O|F)\])/u],
    ['absolute user path', /\/Users\/[A-Za-z0-9._-]+/u],
    ...accountPatterns.map((pattern): [string, RegExp] => ['account name', pattern]),
  ];
  for (const [index, line] of body.split(/\r?\n/u).entries()) {
    for (const [marker, pattern] of patterns) {
      if (pattern.test(line)) throw new SeatPackLeakError(file, index + 1, marker);
    }
  }
}

/** Build from charters, explicitly referenced seat graphs and the seat's own `graphs/<seat>/` folder; never copy an entire shared graph directory by default. */
export function exportSeatPack(seat: string, out: string, root = resolve(import.meta.dir, '../..')): SeatPackManifest {
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/u.test(seat)) throw new Error(`invalid seat: ${seat}`);
  const repo = resolve(root);
  const output = resolve(out);
  const roles = join(repo, 'docs', 'roles');
  const charter = join(roles, `${seat}.md`);
  if (!existsSync(charter) || !regularFile(charter)) throw new Error(`seat charter not found: docs/roles/${seat}.md`);
  const roleFiles = [`docs/roles/${seat}.md`, ...walk(join(roles, seat), repo).filter((file) => file.endsWith('.md'))];
  const graphFiles = new Set<string>();
  const contents = new Map<string, Buffer>();
  for (const file of roleFiles) {
    const body = readFileSync(join(repo, file));
    contents.set(file, body);
    for (const match of body.toString('utf8').matchAll(/graphs\/([A-Za-z0-9_./-]+(?:\.ya?ml|\/\*\*))/gu)) {
      const ref = `graphs/${match[1]!}`;
      if (ref.split('/').includes('..')) throw new Error(`invalid seat graph: ${ref}`);
      if (ref.endsWith('/**')) {
        if (!existsSync(join(repo, ref.slice(0, -3)))) throw new Error(`seat graph not found: ${ref}`);
        for (const graph of walk(join(repo, ref.slice(0, -3)), repo)) {
          if (/\.ya?ml$/u.test(graph)) graphFiles.add(graph);
        }
      } else graphFiles.add(ref);
    }
  }
  // A seat's own graph folder (`graphs/<seat in lower case>/`) belongs to the seat even when the
  // charter no longer mentions it — inclusion must not hinge on a text reference that can be edited away.
  const ownGraphs = join(repo, 'graphs', seat.toLowerCase());
  if (existsSync(ownGraphs)) {
    for (const graph of walk(ownGraphs, repo)) if (/\.ya?ml$/u.test(graph)) graphFiles.add(graph);
  }
  for (const file of graphFiles) {
    const path = join(repo, file);
    if (!existsSync(path) || !regularFile(path)) throw new Error(`seat graph not found: ${file}`);
    contents.set(file, readFileSync(path));
  }
  const verdicts = roleFiles.flatMap((file) => contents.get(file)!.toString('utf8').split(/\r?\n/u)
    .filter((line) => /\|\s*판정선\s*\|/u.test(line)).map((line) => ({ source: file, text: line.split('|').slice(2, -1).join('|').trim() })));
  for (const file of roleFiles) {
    const charter = contents.get(file)!.toString('utf8');
    for (const match of charter.matchAll(/(?:^|\n)\s*[-*]\s*\*\*(?:관문|판정선)\*\*\s*[—:-]\s*([^\n]+)/gu)) {
      verdicts.push({ source: file, text: match[1]!.trim() });
    }
    let inGateSection = false;
    for (const line of charter.split(/\r?\n/u)) {
      if (/^##\s+\d+\.\s+관문(?:\s|\(|$)/u.test(line)) { inGateSection = true; continue; }
      if (/^##\s/u.test(line)) inGateSection = false;
      if (!inGateSection) continue;
      const bullet = line.match(/^\s*[-*]\s+(.+)$/u);
      if (bullet) verdicts.push({ source: file, text: bullet[1]!.trim() });
    }
  }
  if (verdicts.length === 0) throw new Error(`seat verdict not found for ${seat}`);
  contents.set('verdicts.json', Buffer.from(`${JSON.stringify(verdicts, null, 2)}\n`));
  contents.set('budget.json', Buffer.from(`${JSON.stringify({ dailyGoals: DEFAULT_DAILY_GOALS, concurrentPods: DEFAULT_CONCURRENT_PODS }, null, 2)}\n`));
  const version = (JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as { version: string }).version;
  const files = [...contents].sort(([a], [b]) => a.localeCompare(b)).map(([path, body]) => ({
    path, sha256: createHash('sha256').update(body).digest('hex'),
  }));
  const manifest: SeatPackManifest = { name: seat, version, files };
  const manifestBody = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  for (const [file, body] of [...contents, ['manifest.json', manifestBody] as [string, Buffer]]) scan(file, body.toString('utf8'));
  if (existsSync(output)) {
    if (!lstatSync(output).isDirectory() || readdirSync(output).length > 0) throw new Error(`output must be an empty directory: ${output}`);
  }
  const sources = [roles, join(repo, 'graphs')];
  if (output === repo || sources.some((source) => output === source || source.startsWith(`${output}${sep}`) || output.startsWith(`${source}${sep}`))) {
    throw new Error('output overlaps seat pack sources');
  }
  mkdirSync(output, { recursive: true });
  for (const [file, body] of contents) {
    const dest = join(output, file);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, body);
  }
  writeFileSync(join(output, 'manifest.json'), manifestBody);
  return manifest;
}
