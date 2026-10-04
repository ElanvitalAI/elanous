#!/usr/bin/env bun
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { debug } from '../../src/debug/log.js';

type Scope = 'public-docs' | 'release-notes' | 'site' | 'deck' | 'skill' | 'any';
type Kind = 'forbid' | 'require-form' | 'korean-in-english' | 'number-needs-source';
type Rule = { id: string; kind: Kind; pattern: string; flags?: string; scope: Scope[]; why: string; source: string; allowInCode?: boolean; allowPattern?: string; sourcePattern?: string };
type Finding = { file: string; line: number; id: string; match: string };
type GlossaryEntry = { internal: string; public: string; publicForbidden: boolean };
const scopes: Scope[] = ['public-docs', 'release-notes', 'site', 'deck', 'skill', 'any'];
const kinds: Kind[] = ['forbid', 'require-form', 'korean-in-english', 'number-needs-source'];
const defaultRules = join(import.meta.dir, '../../docs/brand/brand-rules.yaml');

function loadRules(path: string): Rule[] {
  const document = parseYaml(readFileSync(path, 'utf8')) as unknown;
  if (!document || typeof document !== 'object' || !('rules' in document) || !Array.isArray(document.rules)) throw new Error(`invalid brand rules: ${path}`);
  const glossary = 'glossary' in document ? document.glossary : [];
  if (!Array.isArray(glossary) || !glossary.every((entry: unknown) => entry && typeof entry === 'object'
    && typeof (entry as GlossaryEntry).internal === 'string' && typeof (entry as GlossaryEntry).public === 'string'
    && typeof (entry as GlossaryEntry).publicForbidden === 'boolean')) throw new Error(`invalid brand glossary: ${path}`);
  const ids = new Set<string>();
  const rules: Rule[] = document.rules.map((candidate: unknown) => {
    if (!candidate || typeof candidate !== 'object') throw new Error(`invalid brand rule: ${path}`);
    const rule = candidate as Partial<Rule>;
    if (typeof rule.id !== 'string' || !rule.id || ids.has(rule.id) || !kinds.includes(rule.kind as Kind)
      || typeof rule.pattern !== 'string' || !rule.pattern || typeof rule.why !== 'string' || !rule.why
      || typeof rule.source !== 'string' || !rule.source || !Array.isArray(rule.scope) || !rule.scope.length
      || !rule.scope.every((scope) => scopes.includes(scope)) || (rule.flags !== undefined && typeof rule.flags !== 'string')
      || (rule.allowInCode !== undefined && typeof rule.allowInCode !== 'boolean')
      || (rule.allowPattern !== undefined && typeof rule.allowPattern !== 'string')
      || (rule.kind === 'number-needs-source' && (typeof rule.sourcePattern !== 'string' || !rule.sourcePattern))) throw new Error(`invalid brand rule: ${path}`);
    new RegExp(rule.pattern, rule.flags);
    if (rule.sourcePattern) new RegExp(rule.sourcePattern, rule.flags);
    if (rule.allowPattern) new RegExp(rule.allowPattern, rule.flags);
    ids.add(rule.id);
    return rule as Rule;
  });
  for (const entry of glossary as GlossaryEntry[]) {
    if (!entry.publicForbidden) continue;
    const id = `GLOSSARY-${entry.internal}`;
    if (!entry.internal || ids.has(id)) throw new Error(`invalid brand glossary: ${path}`);
    ids.add(id);
    const literal = entry.internal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = `(?<![가-힣])${literal}(?![가-힣])`;
    rules.push({ id, kind: 'forbid', pattern, scope: ['any'], why: `Use ${entry.public} instead of the internal term.`, source: `${path}#glossary` });
  }
  return rules;
}

function filesAt(paths: string[]): string[] {
  const files = new Set<string>();
  const visit = (path: string): void => {
    const stat = statSync(path);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isDirectory() || entry.isFile()) visit(join(path, entry.name));
      }
    } else if (stat.isFile()) files.add(path);
  };
  for (const path of paths) visit(resolve(path));
  return [...files].sort();
}

function maskUiStrings(line: string): string {
  const ui = /^\s*(?:>\s*`?\s*)?(?:(?:const|let|var)\s+)?(?:label|title|button|placeholder|ariaLabel|aria-label|tooltip|caption|uiText|uiMessage)\s*[:=]\s*(["'`])([^"'`\n]*[가-힣][^"'`\n]*)\1/;
  const chars = line.split('');
  const match = ui.exec(line);
  if (match) {
    const value = match[2]!;
    const start = match.index + match[0].indexOf(value);
    for (let i = start; i < start + value.length; i++) chars[i] = ' ';
  }
  return chars.join('');
}

function htmlVisible(content: string): string {
  const blank = (text: string) => text.replace(/[^\r\n]/g, ' ');
  return content.replace(/<!--[\s\S]*?-->|<(?:script|style)\b[^>]*>[\s\S]*?<\/\s*(?:script|style)\s*>/gi, blank)
    .replace(/<(?:[^>"']|"[^"]*"|'[^']*')*>/g, (tag) => {
      if (!/^<img\b/i.test(tag)) return blank(tag);
      const alt = /\balt\s*=\s*(["'])(.*?)\1/is.exec(tag);
      if (!alt) return blank(tag);
      const offset = alt.index + alt[0].indexOf(alt[2]!);
      return blank(tag.slice(0, offset)) + alt[2] + blank(tag.slice(offset + alt[2].length));
    });
}

function isEnglishDocument(content: string, file: string, scope: Scope): boolean {
  const html = ['.html', '.htm'].includes(extname(file).toLowerCase());
  const frontmatter = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1];
  const language = html
    ? /<html\b[^>]*\blang\s*=\s*["']?([a-z]{2,}(?:-[a-z]+)*)/i.exec(content)?.[1]
      ?? /<meta\b[^>]*\b(?:http-equiv\s*=\s*["']?content-language|name\s*=\s*["']?language)[^>]*\bcontent\s*=\s*["']?([a-z]{2,})/i.exec(content)?.[1]
    : frontmatter ? /^lang(?:uage)?\s*:\s*["']?([a-z]{2,}(?:-[a-z]+)*)/im.exec(frontmatter)?.[1] : undefined;
  if (language) return /^en(?:-|$)/i.test(language);
  // Language-suffixed filenames are an explicit declaration, even without frontmatter.
  if (/(?:^|[._-])(?:en|ko)(?:-[a-z]+)?\.[^.]+$/i.test(file)) return /(?:^|[._-])en(?:-[a-z]+)?\.[^.]+$/i.test(file);
  if (scope !== 'site') return false;
  const body = (html ? htmlVisible(content) : content.replace(/^---\s*\r?\n[\s\S]*?\r?\n---/, ''))
    .replace(/\bElanous\b/gi, '');
  return /\b[A-Za-z]{2,}(?:\s+[A-Za-z]{2,}){2,}\b/.test(body);
}

function findInFile(file: string, rules: Rule[], scope: Scope): Finding[] {
  const findings: Finding[] = [];
  const content = readFileSync(file, 'utf8');
  const html = ['.html', '.htm'].includes(extname(file).toLowerCase());
  const englishDocument = isEnglishDocument(content, file, scope);
  const markdown = ['.md', '.mdx'].includes(extname(file).toLowerCase());
  const bodyLines = html ? htmlVisible(content).split(/\r?\n/) : [];
  let fence: { marker: string; length: number } | undefined;
  const allLines = content.split(/\r?\n/);
  for (const [index, line] of allLines.entries()) {
    const lineFindings: Finding[] = [];
    const marker = markdown ? /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1] : undefined;
    if (marker) {
      if (!fence) fence = { marker: marker[0]!, length: marker.length };
      else if (marker[0] === fence.marker && marker.length >= fence.length) fence = undefined;
    }
    const quoted = markdown && /^\s*>/.test(line);
    const inCode = Boolean(fence || marker || quoted);
    for (const rule of rules) {
      if (rule.kind === 'korean-in-english' && !englishDocument) continue;
      const text = rule.kind === 'korean-in-english' && html ? bodyLines[index]! : line;
      const visible = rule.allowInCode && inCode ? maskUiStrings(text) : text;
      const allowed = rule.allowPattern ? [...line.matchAll(new RegExp(rule.allowPattern, [...new Set(`${rule.flags ?? ''}g`)].join('')))] : [];
      const matches = visible.matchAll(new RegExp(rule.pattern, [...new Set(`${rule.flags ?? ''}g`)].join('')));
      // B4: a measured number must carry its source marker on the same line or a neighbouring one.
      const sourced = rule.kind === 'number-needs-source'
        && [index - 1, index, index + 1].some((i) => i >= 0 && i < allLines.length && new RegExp(rule.sourcePattern!, rule.flags).test(allLines[i]!));
      for (const match of matches) {
        if (sourced) break;
        if (allowed.some((exception) => exception.index! <= match.index! && match.index! < exception.index! + exception[0].length)) continue;
        lineFindings.push({ file, line: index + 1, id: rule.id, match: match[0] });
        if (rule.kind === 'korean-in-english') break;
      }
    }
    findings.push(...lineFindings.filter((finding) => finding.id !== 'B11'
      || !lineFindings.some((other) => other.id === 'BRAND-AUTONOMY' && other.match.includes(finding.match))));
  }
  return findings;
}

export function checkBrand(scope: Scope, paths: string[], rulesPath = defaultRules): { files: number; findings: Finding[]; rules: number; missing: boolean } {
  if (!existsSync(rulesPath)) {
    debug.log('brand.check', 'run', { scope, files: 0, findings: 0, rules: 0 });
    return { files: 0, findings: [], rules: 0, missing: true };
  }
  const applicable = loadRules(rulesPath).filter((rule) => scope === 'any' || rule.scope.includes('any') || rule.scope.includes(scope));
  const files = filesAt(paths);
  const findings = files.flatMap((file) => findInFile(file, applicable, scope));
  debug.log('brand.check', 'run', { scope, files: files.length, findings: findings.length, rules: applicable.length });
  return { files: files.length, findings, rules: applicable.length, missing: false };
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    let scope: Scope | undefined;
    let rulesPath = defaultRules;
    let json = false;
    const paths: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (arg === '--scope') scope = args[++i] as Scope;
      else if (arg === '--rules') rulesPath = args[++i] ?? '';
      else if (arg === '--json') json = true;
      else if (arg.startsWith('--')) throw new Error(`unknown option: ${arg}`);
      else paths.push(arg);
    }
    if (!scope || !scopes.includes(scope) || !paths.length || !rulesPath) throw new Error('usage: bun scripts/brand/check.ts --scope <scope> <file|folder...> [--rules <path>] [--json]');
    const result = checkBrand(scope, paths, rulesPath);
    if (result.missing) console.log(json ? JSON.stringify({ ...result, message: '규칙 없음' }) : '규칙 없음');
    else if (json) console.log(JSON.stringify({ scope, ...result }));
    else {
      for (const finding of result.findings) console.log(`${finding.file}:${finding.line}:${finding.id}:${finding.match}`);
      console.log(`brand-check ${scope} files=${result.files} findings=${result.findings.length} rules=${result.rules}`);
    }
    if (result.findings.length) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
