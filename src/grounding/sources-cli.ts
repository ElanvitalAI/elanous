// `elanous grounding sources` — registry CLI.
// Does not import src/index.ts. The production entrypoint calls
// registerGroundingSourcesCli(program).

import type { Command } from 'commander';
import { homedir } from 'node:os';
import { basename } from 'node:path';
import { exportMirrorManifest } from './mirror-export.js';
import {
  addGroundingSource,
  discoverReferenceSources,
  GroundingSourceError,
  listGroundingSources,
  removeGroundingSource,
  sourceStatus,
  type GroundingSource,
  type GroundingSourceKind,
  type GroundingSourceSync,
  type GroundingSourcesConfig,
} from './sources.js';
import { getUserConfig, saveUserConfig, type UserConfig } from '../user-config.js';

const KINDS: readonly GroundingSourceKind[] = ['local-repo', 'local-docs', 'web', 'dev-index', 'url'];

export function registerGroundingSourcesCli(program: Command): void {
  const grounding = program
    .command('grounding')
    .description('그라운딩 출처 레지스트리');
  const sources = grounding
    .command('sources')
    .description('등록된 그라운딩 출처를 조회·추가·삭제하고 신선도를 본다');

  sources
    .command('list')
    .description('등록된 출처 목록')
    .option('--json', 'JSON 출력')
    .action((opts: { json?: boolean }) => {
      const listed = listGroundingSources(load());
      if (opts.json) printJson(listed);
      else if (listed.length === 0) console.log('(none)');
      else for (const source of listed) console.log(formatSource(source));
    });

  sources
    .command('add <pathOrUrl>')
    .description('출처를 등록한다')
    .option('--kind <kind>', 'local-repo|local-docs|web|dev-index|url')
    .option('--sync <sync>', 'manual|daily|before-use:<hours>')
    .option('--tag <tag>', '태그를 반복해서 붙인다', collectTag, [] as string[])
    .option('--json', 'JSON 출력')
    .action((pathOrUrl: string, opts: { kind?: string; sync?: string; tag?: string[]; json?: boolean }) => {
      try {
        const kind = parseKind(opts.kind);
        const sync = parseSyncFlag(opts.sync);
        const input = isUrl(pathOrUrl)
          ? { url: pathOrUrl, kind: kind ?? 'url', sync, tags: opts.tag, id: idFromUrl(pathOrUrl) }
          : { path: pathOrUrl, ...(kind ? { kind } : {}), sync, tags: opts.tag, id: basename(pathOrUrl) };
        const next = addGroundingSource(load(), input);
        save(next);
        const added = listGroundingSources(next).at(-1);
        if (opts.json) printJson(added);
        else console.log(`added ${added?.id}`);
      } catch (err) {
        fail(err);
      }
    });

  sources
    .command('remove <id>')
    .description('출처를 id 로 삭제한다')
    .action((id: string) => {
      try {
        const next = removeGroundingSource(load(), id);
        save(next);
        console.log(`removed ${id}`);
      } catch (err) {
        fail(err);
      }
    });

  sources
    .command('discover')
    .description('~/source/ref 와 ~/docs/ref 후보를 찾는다(등록하지 않는다)')
    .option('--json', 'JSON 출력')
    .option('--home <dir>', '홈 디렉터리(기본: os homedir)')
    .action((opts: { json?: boolean; home?: string }) => {
      const found = discoverReferenceSources(opts.home ?? homedir());
      if (opts.json) printJson(found);
      else if (found.length === 0) console.log('(none)');
      else for (const source of found) console.log(formatSource(source));
    });

  sources
    .command('export')
    .description('등록된 local-repo 출처로 거울 목록을 만든다')
    .option('--mirror-manifest', '거울 목록을 내보낸다')
    .option('--discover', '발견 후보를 등록된 출처에 더한다(대체하지 않는다)')
    .option('--json', 'JSON 으로 { accepted, refused }')
    .option('--home <dir>', '발견에 쓸 홈 디렉터리(기본: os homedir)')
    .action((opts: { mirrorManifest?: boolean; discover?: boolean; json?: boolean; home?: string }) => {
      if (!opts.mirrorManifest) {
        console.error('export 는 --mirror-manifest 가 필요하다');
        process.exitCode = 1;
        return;
      }
      const registered = listGroundingSources(load());
      const sources = opts.discover
        ? mergeDiscovered(registered, discoverReferenceSources(opts.home ?? homedir()))
        : registered;
      const exported = exportMirrorManifest(sources);
      const human = humanExportLines(exported);
      if (human) console.error(human);
      if (opts.json) printJson({ accepted: exported.accepted, refused: exported.refused });
      else console.log(exported.list);
    });

  sources
    .command('status [id]')
    .description('local-repo 신선도(로컬 참조만 · fetch/pull 없음)')
    .option('--json', 'JSON 출력')
    .action((id: string | undefined, opts: { json?: boolean }) => {
      const listed = listGroundingSources(load());
      const targets = id ? listed.filter((source) => source.id === id) : listed;
      if (id && targets.length === 0) {
        console.error(`unknown id: ${id}`);
        process.exitCode = 1;
        return;
      }
      const rows = targets.map((source) => sourceStatus(source));
      if (opts.json) printJson(id ? rows[0] : rows);
      else for (const row of rows) {
        console.log(`${row.id} dirty=${String(row.dirty ?? false)} behind=${String(row.behind ?? 'unknown')}${row.branch ? ` branch=${row.branch}` : ''}`);
      }
    });
}

function load(): UserConfig {
  return getUserConfig();
}

function save(next: GroundingSourcesConfig): void {
  const current = getUserConfig();
  saveUserConfig({
    ...current,
    grounding: { sources: listGroundingSources(next) },
  });
}

function collectTag(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseKind(raw: string | undefined): GroundingSourceKind | undefined {
  if (!raw) return undefined;
  if (!(KINDS as readonly string[]).includes(raw)) {
    throw new GroundingSourceError(`unknown kind: ${raw}`);
  }
  return raw as GroundingSourceKind;
}

function parseSyncFlag(raw: string | undefined): GroundingSourceSync {
  if (!raw || raw === 'manual') return 'manual';
  if (raw === 'daily') return 'daily';
  const match = /^before-use:(\d+(?:\.\d+)?)$/.exec(raw);
  if (!match) throw new GroundingSourceError(`unknown sync: ${raw}`);
  const hours = Number(match[1]);
  if (!Number.isFinite(hours) || hours <= 0) throw new GroundingSourceError(`unknown sync: ${raw}`);
  return { beforeUse: { maxAgeHours: hours } };
}

function isUrl(value: string): boolean {
  return /^https?:\/\//.test(value);
}

function idFromUrl(value: string): string {
  try { return new URL(value).hostname || value; } catch { return value; }
}

/** 등록된 출처를 유지하고, 같은 id 가 없는 발견 후보만 뒤에 붙인다. */
function mergeDiscovered(registered: GroundingSource[], discovered: GroundingSource[]): GroundingSource[] {
  const seen = new Set(registered.map((source) => source.id));
  const extra = discovered.filter((source) => !seen.has(source.id));
  return [...registered, ...extra];
}

function humanExportLines(exported: { accepted: readonly { id: string }[]; refused: readonly { id: string; reason: string }[] }): string {
  const accepted = exported.accepted.map((row) => `accepted ${row.id}`);
  const refused = exported.refused.map((row) => `refused ${row.id} ${row.reason}`);
  return [...accepted, ...refused].join('\n');
}

function formatSource(source: GroundingSource): string {
  const where = source.path ?? source.url ?? '';
  const sync = typeof source.sync === 'string'
    ? source.sync
    : `before-use:${source.sync.beforeUse.maxAgeHours}`;
  const tags = source.tags && source.tags.length > 0 ? ` [${source.tags.join(',')}]` : '';
  return `${source.id}\t${source.kind}\t${sync}\t${where}${tags}`;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value));
}

function fail(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exitCode = 1;
}
