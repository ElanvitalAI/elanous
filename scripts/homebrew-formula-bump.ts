#!/usr/bin/env bun
import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat, writeFile, chmod, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { debug } from '../src/debug/log.js';

const usage = 'usage: bun scripts/homebrew-formula-bump.ts --version <v> [--tarball <local tgz>] [--formula <path>] [--dry-run]';
const urlLine = /^([ \t]*url "https:\/\/registry\.npmjs\.org\/elanous\/-\/elanous-)(\d+\.\d+\.\d+)(\.tgz"[ \t]*)(?=\r?$)/gm;
const shaLine = /^([ \t]*sha256 ")[0-9a-f]{64}("[ \t]*)(?=\r?$)/gm;
let from: string | undefined;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const options: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (flag === '--dry-run' && !Object.hasOwn(options, flag)) { options[flag] = 'true'; continue; }
    if (!['--version', '--tarball', '--formula'].includes(flag) || Object.hasOwn(options, flag) || !args[i + 1] || args[i + 1]!.startsWith('--')) throw new Error(usage);
    options[flag] = args[++i]!;
  }
  const version = options['--version'];
  if (!version || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error(usage);
  const formulaPath = resolve(options['--formula'] ?? join(import.meta.dir, '..', 'integrations', 'homebrew', 'elanous.rb'));
  const original = await readFile(formulaPath, 'utf8');
  const urls = [...original.matchAll(urlLine)];
  const hashes = [...original.matchAll(shaLine)];
  from = urls.length === 1 ? urls[0]![2] : undefined;
  if (urls.length !== 1 || hashes.length !== 1) throw new Error('formula must contain exactly one npm url and one sha256 line');
  const source = options['--tarball'] ? 'tarball' : 'npm';
  const bytes = options['--tarball']
    ? await readFile(options['--tarball'])
    : await (async () => {
        const response = await fetch(`https://registry.npmjs.org/elanous/-/elanous-${version}.tgz`);
        if (!response.ok) throw new Error(`npm tarball download failed: HTTP ${response.status}`);
        return Buffer.from(await response.arrayBuffer());
      })();
  const sha = createHash('sha256').update(bytes).digest('hex');
  const nextUrl = `${urls[0]![1]}${version}${urls[0]![3]}`;
  const nextSha = `${hashes[0]![1]}${sha}${hashes[0]![2]}`;
  const updated = original.replace(urlLine, () => nextUrl).replace(shaLine, () => nextSha);
  if (options['--dry-run']) {
    console.log(nextUrl);
    console.log(nextSha);
  } else {
    const temporary = join(dirname(formulaPath), `.elanous.rb.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, updated);
      await chmod(temporary, (await stat(formulaPath)).mode);
      await rename(temporary, formulaPath);
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    }
  }
  debug.log('release.homebrew', 'bumped', { from, to: version, source, reason: options['--dry-run'] ? 'dry-run' : 'updated' });
  console.log(`formula: ${from} → ${version} · sha256 ${sha.slice(0, 12)}`);
}

main().catch((error: unknown) => {
  const reason = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ');
  const args = process.argv.slice(2);
  debug.log('release.homebrew', 'failed', {
    from,
    to: args.includes('--version') ? args[args.indexOf('--version') + 1] : undefined,
    source: args.includes('--tarball') ? 'tarball' : 'npm',
    reason,
  });
  console.error(reason);
  process.exitCode = 1;
});
