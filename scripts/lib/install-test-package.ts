import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function packageFixture(destination: string, version: string): string {
  const pkg = join(destination, 'package');
  mkdirSync(join(pkg, 'bin'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'elanous', version, bin: { elanous: './bin/elanous.cjs', eln: './bin/elanous.cjs' } }));
  writeFileSync(join(pkg, 'bin', 'elanous.mjs'), fakeCliSource());
  const archive = join(destination, 'elanous-fixture.tgz');
  const packed = spawnSync('tar', ['-czf', archive, '-C', destination, 'package'], { encoding: 'utf8' });
  if (packed.status !== 0) throw new Error(`could not create fake installer package: ${packed.stderr}`);
  return archive;
}

export function packageVersionFromSource(source: string | undefined, fallback: string): string {
  if (!source || /^https?:/.test(source)) return fallback;
  const result = spawnSync('tar', ['-xzOf', source, 'package/package.json'], { encoding: 'utf8' });
  try { return JSON.parse(result.stdout).version ?? fallback; } catch { return fallback; }
}

function fakeCliSource(): string {
  return [
    'const version = JSON.parse(await Bun.file(new URL("../package.json", import.meta.url)).text()).version;',
    'const args = process.argv.slice(2);',
    'if (args[0] === "--version") console.log(`elanous ${version}`);',
    'else if (args[0] === "where" && args.includes("--json")) console.log(JSON.stringify({ kind: "prod", layer: "installed" }));',
    'else if (args[0] === "argv-probe") console.log(JSON.stringify({ entry: process.argv[1], args: args.slice(1) }));',
    'else if (args[0] === "setup") console.log("Setup: external command check");',
  ].join('\n') + '\n';
}
