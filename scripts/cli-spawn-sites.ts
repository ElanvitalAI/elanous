import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const POSSIBLE_CLI_LAUNCH = /(?:child_process|childProcess|Bun\s*\.\s*spawn|\b(?:spawn(?:Sync)?|exec(?:File)?(?:Sync)?)\b)/;

export function cliSpawnSites(source: string, file: string): string[] {
  if (file === 'test/rules-contract.test.ts') return [];
  const lines = source.split('\n');
  const isCode = (line: string) => !/^\s*(?:\/\/|\*|\/\*)/.test(line);
  const codeLines = lines.map((line) => isCode(line) ? line : '');
  const code = codeLines.join('\n');
  const launchNames = new Set(['spawn', 'spawnSync', 'exec', 'execFile', 'execFileSync', 'execSync']);
  for (const match of code.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"](?:node:)?child_process['"]/g)) {
    for (const specifier of match[1]!.split(',')) {
      const [imported, local] = specifier.trim().replace(/^type\s+/, '').split(/\s+as\s+/);
      if (launchNames.has(imported!)) launchNames.add(local || imported!);
    }
  }
  for (const match of code.matchAll(/(?:const|let|var)\s*\{([^}]+)\}\s*=\s*require\(['"](?:node:)?child_process['"]\)/g)) {
    for (const specifier of match[1]!.split(',')) {
      const [imported, local] = specifier.trim().split(/\s*:\s*/);
      if (launchNames.has(imported!)) launchNames.add(local || imported!);
    }
  }
  for (const match of code.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*(?:(\w+)\s*\.\s*)?(spawn|spawnSync|exec|execFile|execFileSync|execSync)\b/g)) {
    const owner = match[2];
    const imported = match[3]!;
    if (launchNames.has(imported) && (!owner || owner === 'childProcess' || owner === 'child_process' || owner === 'cp' || launchNames.has(owner))) {
      launchNames.add(match[1]!);
    }
  }
  const namespace = /import\s+\*\s+as\s+(\w+)\s+from\s*['"](?:node:)?child_process['"]/.exec(code)?.[1]
    ?? /(?:const|let|var)\s+(\w+)\s*=\s*require\(['"](?:node:)?child_process['"]\)/.exec(code)?.[1];
  const names = [...launchNames].map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const call = new RegExp(`(?:\\b(?:${names.join('|')})\\s*\\(|${namespace ? `\\b${namespace}\\s*\\.\\s*(?:spawn|spawnSync|exec|execFile|execFileSync|execSync)\\s*\\(` : '(?!)'}|\\bBun\\s*\\.\\s*spawn(?:Sync)?\\s*\\()`, 'g');
  const entryPath = /bin[\\/]elanous\.(?:mjs|cjs)|['"]bin['"]\s*,\s*['"]elanous\.(?:mjs|cjs)['"]/;
  const entryVariables = new Set<string>();
  for (const match of code.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*join\([\s\S]{0,240}?['"]bin['"]\s*,\s*['"]elanous\.(?:mjs|cjs)['"]/g)) {
    entryVariables.add(match[1]!);
  }
  for (let index = 0; index < codeLines.length; index += 1) {
    if (!entryPath.test(codeLines[index]!)) continue;
    const declaration = /(?:const|let|var)\s+(\w+)\s*=/.exec(codeLines[index]!);
    if (declaration) entryVariables.add(declaration[1]!);
  }
  // Follow a small number of local aliases (entry -> script -> spawn args).
  for (let pass = 0; pass < 3; pass += 1) {
    let grew = false;
    for (let index = 0; index < codeLines.length; index += 1) {
      const declaration = /(?:const|let|var)\s+(\w+)\s*=/.exec(codeLines[index]!);
      if (!declaration || entryVariables.has(declaration[1]!)) continue;
      const indent = /^\s*/.exec(codeLines[index]!)?.[0].length ?? 0;
      const assignment: string[] = [];
      for (let cursor = index; cursor < codeLines.length; cursor += 1) {
        if (cursor > index) {
          const next = /(?:const|let|var)\s+\w+\s*=/.exec(codeLines[cursor]!);
          const nextIndent = /^\s*/.exec(codeLines[cursor]!)?.[0].length ?? 0;
          if (next && nextIndent <= indent) break;
        }
        assignment.push(codeLines[cursor]!);
        if (cursor - index >= 20) break;
      }
      if ([...entryVariables].some((name) => new RegExp(`\\b${name}\\b`).test(assignment.join('\n')))) {
        entryVariables.add(declaration[1]!);
        grew = true;
      }
    }
    if (!grew) break;
  }
  const sites: string[] = [];
  for (const match of code.matchAll(call)) {
    const open = code.indexOf('(', match.index!);
    let depth = 0;
    let quote = '';
    let escaped = false;
    let end = open;
    for (; end < code.length; end += 1) {
      const character = code[end]!;
      if (quote) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === quote) quote = '';
        continue;
      }
      if (character.charCodeAt(0) === 39 || character === '"' || character === '`') { quote = character; continue; }
      if (character === '(') depth += 1;
      else if (character === ')' && --depth === 0) break;
    }
    const args = code.slice(open + 1, end);
    if (entryPath.test(args) || [...entryVariables].some((name) => new RegExp(`\\b${name}\\b`).test(args))) {
      const line = code.slice(0, match.index!).split('\n').length;
      sites.push(`${file}:${line}`);
    }
  }
  return sites;
}

export interface CliSpawnScan { readonly files: string[]; readonly counts: Map<string, number> }

/** Read tracked TS and TSX tests once; a lexical sieve avoids parsing unrelated files. */
export function scanTrackedCliSpawnSites(repoRoot: string): CliSpawnScan {
  const files = execFileSync('git', ['ls-files', '-z', '--', '*.test.ts', '*.test.tsx'], { cwd: repoRoot, encoding: 'utf8' }).split('\0').filter(Boolean);
  const counts = new Map<string, number>();
  for (const file of files) {
    const source = readFileSync(join(repoRoot, file), 'utf8');
    if (!POSSIBLE_CLI_LAUNCH.test(source)) continue;
    for (const site of cliSpawnSites(source, file)) {
      const name = site.slice(0, site.lastIndexOf(':'));
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return { files, counts };
}
