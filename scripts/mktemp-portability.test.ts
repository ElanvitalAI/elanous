import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, test } from 'bun:test';

const scriptsDir = resolve(import.meta.dir);

type ShellToken = { kind: 'word' | 'separator'; value: string };

const commandPositionKeywords = new Set(['if', 'then']);

function shellFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...shellFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.sh')) files.push(path);
  }
  return files;
}

function doubleQuotedCommandSubstitutions(source: string): string[] {
  const substitutions: string[] = [];
  let index = 0;
  let atWordBoundary = true;

  while (index < source.length) {
    const current = source[index];
    if (current === '#' && atWordBoundary) {
      while (index < source.length && source[index] !== '\n') index += 1;
      atWordBoundary = true;
      continue;
    }
    if (current === "'") {
      index += 1;
      while (index < source.length && source[index] !== "'") index += 1;
      index += 1;
      atWordBoundary = false;
      continue;
    }
    if (current !== '"') {
      if (current === '\\') {
        index += 2;
        atWordBoundary = false;
      } else {
        atWordBoundary = /\s/.test(current) || ';|&()'.includes(current);
        index += 1;
      }
      continue;
    }

    index += 1;
    while (index < source.length && source[index] !== '"') {
      if (source[index] === '\\') {
        index += 2;
        continue;
      }
      if (source[index] !== '$' || source[index + 1] !== '(') {
        index += 1;
        continue;
      }

      const start = index + 2;
      let cursor = start;
      let depth = 1;
      let quote: "'" | '"' | undefined;
      let atWordBoundary = true;
      while (cursor < source.length && depth > 0) {
        const current = source[cursor];
        if (current === '\\' && quote !== "'") {
          cursor += 2;
          atWordBoundary = false;
          continue;
        }
        if (quote) {
          if (current === quote) quote = undefined;
          atWordBoundary = false;
        } else if (current === '#' && atWordBoundary) {
          while (cursor < source.length && source[cursor] !== '\n') cursor += 1;
          atWordBoundary = true;
          continue;
        } else if (current === "'" || current === '"') {
          quote = current;
          atWordBoundary = false;
        } else if (current === '(') {
          depth += 1;
          atWordBoundary = true;
        } else if (current === ')') {
          depth -= 1;
          atWordBoundary = true;
        } else {
          atWordBoundary = /\s/.test(current) || ';|&'.includes(current);
        }
        cursor += 1;
      }
      if (depth === 0) substitutions.push(source.slice(start, cursor - 1));
      index = cursor;
    }
    index += 1;
  }

  return substitutions;
}

function shellTokens(source: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let index = 0;
  let atWordBoundary = true;

  while (index < source.length) {
    const char = source[index];
    if (/\s/.test(char)) {
      if (char === '\n') tokens.push({ kind: 'separator', value: '\n' });
      atWordBoundary = true;
      index += 1;
      continue;
    }
    if (char === '#' && atWordBoundary) {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (';|&()'.includes(char)) {
      const next = source[index + 1];
      const separator = (char === '&' && next === '&') || (char === '|' && next === '|') ? char + next : char;
      tokens.push({ kind: 'separator', value: separator });
      index += separator.length;
      atWordBoundary = true;
      continue;
    }

    let word = '';
    while (index < source.length) {
      const current = source[index];
      if (/\s/.test(current) || ';|&()'.includes(current)) break;
      if (current === '\\') {
        word += current + (source[index + 1] ?? '');
        index += 2;
        continue;
      }
      if (current === "'" || current === '"') {
        const quote = current;
        word += quote;
        index += 1;
        while (index < source.length) {
          const quoted = source[index];
          word += quoted;
          index += 1;
          if (quoted === '\\' && quote === '"' && index < source.length) {
            word += source[index];
            index += 1;
          } else if (quoted === quote) {
            break;
          }
        }
        continue;
      }
      word += current;
      index += 1;
    }
    if (word) tokens.push({ kind: 'word', value: word });
    atWordBoundary = false;
  }

  return tokens;
}

function mktempViolations(source: string): string[] {
  const tokens = shellTokens(source);
  const violations = doubleQuotedCommandSubstitutions(source).flatMap(mktempViolations);

  let commandStart = true;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind === 'separator') {
      commandStart = true;
      continue;
    }
    if (!commandStart || token.value !== 'mktemp') {
      if (commandStart && !commandPositionKeywords.has(token.value) && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token.value)) {
        commandStart = false;
      }
      continue;
    }
    const arguments_: string[] = [];
    let cursor = index + 1;
    while (cursor < tokens.length && tokens[cursor].kind === 'word') {
      arguments_.push(tokens[cursor].value);
      cursor += 1;
    }
    const templates = arguments_.filter((argument) => !argument.startsWith('-'));
    if (templates.length > 0 && !templates.some((template) => template.includes('XXXXXX'))) {
      violations.push(['mktemp', ...arguments_].join(' '));
    }
  }

  return violations;
}

function scanShellFiles(root: string) {
  const files = shellFiles(root);
  if (files.length === 0) throw new Error(`no shell files found under ${root}`);
  return {
    files,
    violations: files.flatMap((file) =>
      mktempViolations(readFileSync(file, 'utf8')).map((call) => `${relative(root, file)}: ${call}`),
    ),
  };
}

describe('mktemp portability', () => {
  test('every scripts shell call with arguments uses an XXXXXX template', () => {
    const { files, violations } = scanShellFiles(scriptsDir);
    expect(files.length).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });

  test('detects mktemp calls with arguments that lack an XXXXXX template at shell command boundaries', () => {
    expect(mktempViolations('tmp=$(mktemp -t foo)')).toEqual(['mktemp -t foo']);
    expect(mktempViolations('TMP="$(mktemp -t foo)"')).toEqual(['mktemp -t foo']);
    expect(mktempViolations("# don't regress\nTMP=\"$(mktemp -t foo)\"")).toEqual(['mktemp -t foo']);
    expect(mktempViolations('tag=foo#bar; TMP="$(mktemp -t foo)"')).toEqual(['mktemp -t foo']);
    expect(mktempViolations('TMP="$( # don\'t regress\nmktemp -t foo\n)"')).toEqual(['mktemp -t foo']);
    expect(mktempViolations('TMP="$(mktemp -t foo.XXXXXX)"')).toEqual([]);
    expect(mktempViolations('TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/foo.XXXXXX")"')).toEqual([]);
    expect(mktempViolations('TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/foo")"')).toEqual(['mktemp -d "${TMPDIR:-/tmp}/foo"']);
    expect(mktempViolations('TMP="$(mktemp \\"${TMPDIR:-/tmp}/a b.XXXXXX\\")"')).toEqual([]);
    expect(mktempViolations("TMP='$(mktemp -t foo)' ")).toEqual([]);
    expect(mktempViolations('  mktemp foo')).toEqual(['mktemp foo']);
    expect(mktempViolations('true && mktemp foo')).toEqual(['mktemp foo']);
    expect(mktempViolations('if mktemp -t foo; then :; fi')).toEqual(['mktemp -t foo']);
    expect(mktempViolations('then mktemp -t foo')).toEqual(['mktemp -t foo']);
    expect(mktempViolations('echo mktemp foo')).toEqual([]);
    expect(mktempViolations('tmp=$(mktemp "${TMPDIR:-/tmp}/foo")')).toEqual(['mktemp "${TMPDIR:-/tmp}/foo"']);
  });

  test('does not let comments or a neighboring portable call mask a violation', () => {
    expect(mktempViolations('tmp=$(mktemp -t foo) # XXXXXX')).toEqual(['mktemp -t foo']);
    expect(mktempViolations('good=$(mktemp "${TMPDIR:-/tmp}/good.XXXXXX"); bad=$(mktemp foo)')).toEqual(['mktemp foo']);
  });

  test('allows portable quoted templates and argumentless mktemp', () => {
    expect(mktempViolations('mktemp "/tmp/a b.XXXXXX"\nmktemp')).toEqual([]);
  });

  test('scans a shell file outside the implementation target list', () => {
    const nested = mkdtempSync(join(scriptsDir, 'mktemp-portability-outside-'));
    const file = join(nested, 'outside.sh');
    try {
      writeFileSync(file, 'mktemp foo\n');
      const { violations } = scanShellFiles(scriptsDir);
      expect(violations).toContain(`${relative(scriptsDir, file)}: mktemp foo`);
    } finally {
      rmSync(nested, { recursive: true, force: true });
    }
  });

  test('does not treat an empty shell-file scan as clean', () => {
    const empty = mkdtempSync(join(tmpdir(), 'mktemp-portability-empty-'));
    try {
      expect(() => scanShellFiles(empty)).toThrow('no shell files found');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test('coord-post retains all three mktemp failure handlers', () => {
    const source = readFileSync(join(scriptsDir, 'coord-post.sh'), 'utf8');
    expect(source.match(/mktemp[^\n]*\|\| \{[^\n]*exit 7; \}/g)).toHaveLength(3);
  });
});
