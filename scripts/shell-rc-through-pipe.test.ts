import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { describe, expect, test } from 'bun:test';

const scriptsDir = resolve(import.meta.dir);

const FORMATTERS = [
  'tail', 'head', 'sed', 'tr', 'cat', 'cut', 'column', 'fmt', 'tee', 'nl', 'rev', 'sort', 'uniq', 'wc', 'jq', 'awk',
] as const;
const JUDGES = ['grep', 'rg', 'egrep', 'fgrep', 'test', '[', 'diff', 'cmp', 'ripgrep'] as const;
const formatterNames = new Set<string>(FORMATTERS);
const judgeNames = new Set<string>(JUDGES);

type SourceRange = { start: number; end: number };
type RcConsumedPipeline = SourceRange & { syntax: string; source: string };

function shellFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return shellFiles(path);
    return entry.isFile() && entry.name.endsWith('.sh') ? [path] : [];
  });
}

function maskShellSyntax(source: string): string {
  const masked = source.split('');
  let quote: "'" | '"' | '`' | undefined;
  let substitutionDepth = 0;
  let atWordBoundary = true;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '\n') {
      atWordBoundary = quote === undefined;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      masked[index] = ' ';
      if (index + 1 < source.length) masked[index + 1] = ' ';
      index += 1;
      atWordBoundary = false;
      continue;
    }
    if (substitutionDepth > 0) {
      masked[index] = ' ';
      if (!quote && (char === "'" || char === '"' || char === '`')) quote = char;
      else if (quote && char === quote) quote = undefined;
      else if (!quote && char === '(') substitutionDepth += 1;
      else if (!quote && char === ')') substitutionDepth -= 1;
      continue;
    }
    if (quote) {
      masked[index] = ' ';
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '$' && source[index + 1] === '(') {
      masked[index] = ' ';
      masked[index + 1] = ' ';
      substitutionDepth = 1;
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      masked[index] = ' ';
      atWordBoundary = false;
      continue;
    }
    if (char === '#' && atWordBoundary) {
      while (index < source.length && source[index] !== '\n') {
        masked[index] = ' ';
        index += 1;
      }
      index -= 1;
      continue;
    }
    atWordBoundary = /\s/.test(char) || ';|&()'.includes(char);
  }

  return masked.join('');
}

function trimmedRange(source: string, start: number, end: number): SourceRange | undefined {
  while (start < end && /\s/.test(source[start])) start += 1;
  while (end > start && /\s/.test(source[end - 1])) end -= 1;
  return start < end ? { start, end } : undefined;
}

function hasPipeline(masked: string, range: SourceRange): boolean {
  for (let index = range.start; index < range.end; index += 1) {
    if (masked[index] === '|' && masked[index - 1] !== '|' && masked[index + 1] !== '|') return true;
  }
  return false;
}

function logicalSegments(masked: string, source: string, range: SourceRange): SourceRange[] {
  const segments: SourceRange[] = [];
  let start = range.start;
  for (let index = range.start; index < range.end - 1; index += 1) {
    const operator = masked.slice(index, index + 2);
    if (operator !== '&&' && operator !== '||') continue;
    const segment = trimmedRange(source, start, index);
    if (segment) segments.push(segment);
    start = index + 2;
    index += 1;
  }
  const final = trimmedRange(source, start, range.end);
  if (final) segments.push(final);
  return segments;
}

function containsStatusRead(line: string): boolean {
  let quote: "'" | '"' | undefined;
  let atWordBoundary = true;
  for (let index = 0; index < line.length - 1; index += 1) {
    const char = line[index];
    if (char === '\\' && quote !== "'") { index += 1; atWordBoundary = false; continue; }
    if (quote === "'") { if (char === "'") quote = undefined; continue; }
    if (quote === '"') {
      if (char === '"') quote = undefined;
      else if (char === '$' && line[index + 1] === '?') return true;
      continue;
    }
    if (char === "'") { quote = char; atWordBoundary = false; continue; }
    if (char === '"') { quote = char; atWordBoundary = false; continue; }
    if (char === '#' && atWordBoundary) return false;
    if (char === '$' && line[index + 1] === '?') return true;
    atWordBoundary = /\s/.test(char) || ';|&()'.includes(char);
  }
  return false;
}

function finalCommand(pipeline: string): string | undefined {
  let lastPipe = -1;
  for (let index = 0; index < pipeline.length; index += 1) {
    if (pipeline[index] === '|' && pipeline[index - 1] !== '|' && pipeline[index + 1] !== '|') lastPipe = index;
  }
  if (lastPipe < 0) return undefined;
  const stage = pipeline.slice(lastPipe + 1).trim();
  const command = stage.match(/^(?:!\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)*(?:\d*>\&?\d+\s+)*(\S+)/)?.[1];
  return command?.replace(/^.*\//, '');
}

function maskHeredocBodies(source: string, masked: string): string {
  const result = masked.split('');
  const lines = source.split(/(?<=\n)/);
  let offset = 0;
  let delimiter: string | undefined;
  let stripTabs = false;

  for (const line of lines) {
    const content = line.replace(/\r?\n$/, '');
    if (delimiter !== undefined) {
      const candidate = stripTabs ? content.replace(/^\t+/, '') : content;
      for (let index = offset; index < offset + line.length; index += 1) {
        if (source[index] !== '\n') result[index] = ' ';
      }
      if (candidate === delimiter) delimiter = undefined;
      offset += line.length;
      continue;
    }
    const sourceLine = source.slice(offset, offset + line.length);
    const match = sourceLine.match(/<<(-)?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/);
    if (match) {
      delimiter = match[3];
      stripTabs = match[1] === '-';
    }
    offset += line.length;
  }
  return result.join('');
}

function rcConsumedPipelines(source: string): RcConsumedPipeline[] {
  if (/^\s*set\s+(?:-[A-Za-z]*o\s+pipefail|-[A-Za-z]*\s+pipefail)\s*$/m.test(source)) return [];
  const masked = maskHeredocBodies(source, maskShellSyntax(source));
  const found = new Map<string, RcConsumedPipeline>();
  const add = (range: SourceRange) => {
    const trimmed = trimmedRange(source, range.start, range.end);
    if (!trimmed || !hasPipeline(masked, trimmed)) return;
    const key = `${trimmed.start}:${trimmed.end}`;
    found.set(key, {
      ...trimmed,
      syntax: masked.slice(trimmed.start, trimmed.end).trim(),
      source: source.slice(trimmed.start, trimmed.end).trim(),
    });
  };

  const conditionPattern = /(^|[;\n])(\s*)(if|while|until)(\s+!?\s*)([\s\S]*?)(;\s*|\n\s*)(then|do)\b/g;
  for (const match of masked.matchAll(conditionPattern)) {
    const control = match[3];
    const terminator = match[7];
    if ((control === 'if' && terminator !== 'then') || (control !== 'if' && terminator !== 'do')) continue;
    const start = (match.index ?? 0) + match[1].length + match[2].length + match[3].length + match[4].length;
    const end = (match.index ?? 0) + match[0].length - match[6].length - match[7].length;
    const condition = { start, end };
    for (const segment of logicalSegments(masked, source, condition)) add(segment);
  }

  let clauseStart = 0;
  for (let index = 0; index <= masked.length; index += 1) {
    if (index < masked.length && masked[index] !== ';' && masked[index] !== '\n') continue;
    const clause = { start: clauseStart, end: index };
    const segments = logicalSegments(masked, source, clause);
    for (const segment of segments.slice(0, -1)) add(segment);
    clauseStart = index + 1;
  }

  const lines = source.split(/\r?\n/);
  let lineStart = 0;
  for (let index = 0; index < lines.length - 1; index += 1) {
    const lineEnd = lineStart + lines[index].length;
    if (containsStatusRead(lines[index + 1]) && !/\$\{?(?:PIPESTATUS|pipestatus)\b/.test(lines[index + 1])) {
      const commands = masked.slice(lineStart, lineEnd).split(';');
      let offset = lineStart;
      const ranges = commands.map((command) => {
        const range = { start: offset, end: offset + command.length };
        offset += command.length + 1;
        return range;
      });
      const finalCommandRange = ranges.reverse().find((range) => trimmedRange(masked, range.start, range.end));
      if (finalCommandRange) {
        const segments = logicalSegments(masked, source, finalCommandRange);
        const finalSegment = segments.at(-1);
        if (finalSegment) add(finalSegment);
      }
    }
    lineStart = lineEnd + 1;
  }

  return [...found.values()]
    .filter((pipeline) => !discardsRcExplicitly(masked, pipeline))
    .sort((left, right) => left.start - right.start);
}

// ⛔⭐ 「rc 를 «일부러» 버린 자리」는 위반이 아니다 — 저자가 «무시하겠다»고 «썼기» 때문이다.
//
// 이 자를 세운 계기는 `#19419`(백업 스크립트가 업로드 실패를 놓쳤다)였고, 거기서 막으려는 것은
// ***「저자는 rc 를 읽으려 했는데 파이프가 먹었다」***다. 아래 둘은 그 반대다:
//
//   ⓐ  <파이프라인> || true          ← 성패와 «무관하게» 계속 가겠다는 «선언»이다
//   ⓑ  if <파이프라인>; then :; fi   ← 몸통이 no-op 다. 결과로 «아무것도 안 한다»
//
// ⚠️ 이 예외는 «좁다»:
//   · ⓐ 는 `|| true` 뿐이다 — `|| echo '⛔ 못 쟀다'` 처럼 «무언가 하는» 대비책은 ***위반이다***
//     (실물: `judge-edition.sh` 가 그 꼴이었고 「못 쟀다」가 원리상 못 떴다 — `#19431`)
//   · ⓑ 는 몸통이 «정확히» `:` 일 때만이다 — 실제 일을 하는 몸통은 그대로 잡힌다
//
// 📏 2026-09-21 저장소 실측: 이 예외에 걸리는 자리는 다섯이고 전부 의도된 것이었다
//   (ios-pro11-install · ios-i16pro-install · botlab/bot-fault-drill · botlab/provision-bot-screens ·
//    webclone/loop/loop-agent).
function discardsRcExplicitly(masked: string, pipeline: RcConsumedPipeline): boolean {
  const after = masked.slice(pipeline.end);
  const trailing = after.match(/^[^\n;]*/)?.[0] ?? '';
  if (/^\s*\|\|\s*true\s*$/.test(trailing)) return true;

  const lineStart = masked.lastIndexOf('\n', pipeline.start) + 1;
  const lineEndIndex = masked.indexOf('\n', pipeline.end);
  const line = masked.slice(lineStart, lineEndIndex === -1 ? masked.length : lineEndIndex);
  return /^\s*if\s+[\s\S]*;\s*then\s*:\s*;\s*fi\s*$/.test(line);
}

function pipelineRole(pipeline: string): 'formatter' | 'judge' | 'unknown' {
  const command = finalCommand(pipeline);
  if (command && formatterNames.has(command)) return 'formatter';
  if (command && judgeNames.has(command)) return 'judge';
  return 'unknown';
}

function shellRcViolations(source: string): string[] {
  return rcConsumedPipelines(source)
    .filter((pipeline) => pipelineRole(pipeline.syntax) === 'formatter')
    .map((pipeline) => pipeline.source);
}

function scanShellFiles(root: string) {
  const files = shellFiles(root);
  if (files.length === 0) throw new Error(`no shell files found under ${root}`);
  return {
    files,
    violations: files.flatMap((file) =>
      shellRcViolations(readFileSync(file, 'utf8')).map((pipeline) => `${relative(root, file)}: ${pipeline}`),
    ),
  };
}

describe('shell rc through pipe', () => {
  test('ratchets all scripts shell files to no swallowed formatter rc', () => {
    const { files, violations } = scanShellFiles(scriptsDir);
    expect(files.length).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });

  test('reports recursive root-relative violations and rejects empty scans', () => {
    const root = mkdtempSync(join(tmpdir(), 'shell-rc-through-pipe-'));
    try {
      mkdirSync(join(root, 'nested'));
      // ⚠️ 몸통을 «실제 일»로 둔다 — `then :; fi`(no-op)는 이제 «의도된 rc 버리기»라는 «뜻»을 갖는다
      writeFileSync(join(root, 'nested', 'bad.sh'), 'if ! cmd | tail -3; then log; fi\n');
      expect(scanShellFiles(root).violations).toEqual(['nested/bad.sh: cmd | tail -3']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    const empty = mkdtempSync(join(tmpdir(), 'shell-rc-through-pipe-empty-'));
    try {
      expect(() => scanShellFiles(empty)).toThrow('no shell files found');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test('detects the four known formatter positives', () => {
    // 알려진 양성
    expect(shellRcViolations('if ! cmd 2>&1 | tail -3; then fail; fi')).toEqual(['cmd 2>&1 | tail -3']);
    expect(shellRcViolations("if ! cmd | sed -n '1p'; then fail; fi")).toEqual(["cmd | sed -n '1p'"]);
    expect(shellRcViolations('while cmd | head -1; do :; done')).toEqual(['cmd | head -1']);
    expect(shellRcViolations('cmd | cut -d: -f1 && echo ok')).toEqual(['cmd | cut -d: -f1']);
  });

  // ⭐ 「rc 를 «일부러» 버린 자리」는 위반이 아니다 — 그리고 그 예외가 «좁다»는 것을 같이 누른다
  test('allows explicit rc discards but still catches a fallback that meant to fire', () => {
    // 음성 — 저자가 「무시하겠다」고 «썼다»
    expect(shellRcViolations('cmd | tail -3 || true')).toEqual([]);
    expect(shellRcViolations('cmd 2>&1 | tee -a "$LOG" || true')).toEqual([]);
    expect(shellRcViolations('if cmd | tee /tmp/out; then :; fi')).toEqual([]);
    // 양성 — 「무언가 하는」 대비책은 «뜨려고» 쓴 것이다 (실물: judge-edition.sh · #19431)
    expect(shellRcViolations("cmd | sed 's/x/y/' || echo '⛔ 못 쟀다'")).toEqual(["cmd | sed 's/x/y/'"]);
    // 양성 — 몸통이 실제 일을 하면 no-op 예외에 안 걸린다
    expect(shellRcViolations('if cmd | tail -3; then rollback; fi')).toEqual(['cmd | tail -3']);
  });

  test('allows the four known judge, non-consuming, repaired, and unknown negatives', () => {
    expect(shellRcViolations('if ! cmd | grep -q PATTERN; then fail; fi')).toEqual([]);
    expect(shellRcViolations('cmd | tail -3')).toEqual([]);
    expect(shellRcViolations("OUT=$(cmd 2>&1); RC=$?; printf '%s\\n' \"$OUT\" | tail -3")).toEqual([]);
    expect(shellRcViolations('if ! cmd | mylocalscript; then fail; fi')).toEqual([]);
  });

  test('detects every requested rc-consuming context and logical-list segment', () => {
    expect(shellRcViolations('if cmd | tail -3; then report; fi')).toEqual(['cmd | tail -3']);
    expect(shellRcViolations('while cmd | head -1; do :; done')).toEqual(['cmd | head -1']);
    expect(shellRcViolations("until cmd | awk '{print $1}'; do :; done")).toEqual(["cmd | awk '{print $1}'"]);
    expect(shellRcViolations("cmd | jq -r .value || echo '⛔ 못 쟀다'")).toEqual(['cmd | jq -r .value']);
    expect(shellRcViolations('cmd | tail -3 || fallback')).toEqual(['cmd | tail -3']);
    expect(shellRcViolations('ready && cmd | cut -d: -f1 && report')).toEqual(['cmd | cut -d: -f1']);
    expect(shellRcViolations('if cmd | tail -3\nthen report; fi')).toEqual(['cmd | tail -3']);
  });

  test('detects any immediate next-line status read while ignoring quoted or delayed reads', () => {
    expect(shellRcViolations('cmd | tr -d x\necho $?')).toEqual(['cmd | tr -d x']);
    expect(shellRcViolations('cmd | tr -d x\nif [ $? -ne 0 ]; then exit 1; fi')).toEqual(['cmd | tr -d x']);
    expect(shellRcViolations('cmd | tr -d x\nRC="$?"')).toEqual(['cmd | tr -d x']);
    expect(shellRcViolations("cmd | tail -3\necho '$?' ")).toEqual([]);
    expect(shellRcViolations('cmd | tail -3\necho later\necho $?')).toEqual([]);
    expect(shellRcViolations('cmd | tail -3\nRC=${PIPESTATUS[0]}')).toEqual([]);
    expect(shellRcViolations('cmd | tail -3\nRC=${pipestatus[1]:-$?}')).toEqual([]);
  });

  test('allows pipelines protected by pipefail', () => {
    expect(shellRcViolations('set -o pipefail\nif ! cmd | tail -3; then :; fi')).toEqual([]);
    expect(shellRcViolations('set -euo pipefail\ncmd | sed s/x/y/ || exit 1')).toEqual([]);
  });

  test('ignores pipelines hidden in comments, quotes, and command substitutions', () => {
    expect(shellRcViolations('# if cmd | tail -3; then :; fi')).toEqual([]);
    expect(shellRcViolations('echo "if cmd | tail -3; then"')).toEqual([]);
    expect(shellRcViolations('if value=$(cmd | awk \'{ print }\'); then :; fi')).toEqual([]);
  });
});
