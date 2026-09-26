import { visibleWidth } from '../tui.js';

export interface WrapOptions {
  urlAware?: boolean;
}

interface Unit {
  raw: string;
  plain: string;
  width: number;
}

const OSC_TERMINATOR = '\x1b\\';
const URL_RE = /^(https?:\/\/|www\.)/i;

function isOsc8Sequence(raw: string): boolean {
  return raw.startsWith('\x1b]8;;');
}

function readEscapeSequence(input: string, start: number): { raw: string; next: number } {
  if (input[start] !== '\x1b') return { raw: input[start] ?? '', next: start + 1 };
  const next = input[start + 1];
  if (next === '[') {
    let i = start + 2;
    while (i < input.length) {
      const ch = input[i]!;
      if (ch >= '@' && ch <= '~') { i++; break; }
      i++;
    }
    return { raw: input.slice(start, i), next: i };
  }
  if (next === ']') {
    const bel = input.indexOf('\x07', start + 2);
    const st = input.indexOf(OSC_TERMINATOR, start + 2);
    if (bel >= 0 && (st < 0 || bel < st)) return { raw: input.slice(start, bel + 1), next: bel + 1 };
    if (st >= 0) return { raw: input.slice(start, st + OSC_TERMINATOR.length), next: st + OSC_TERMINATOR.length };
  }
  return { raw: input.slice(start, Math.min(input.length, start + 2)), next: Math.min(input.length, start + 2) };
}

function toUnits(input: string): Unit[] {
  const units: Unit[] = [];
  let pendingEsc = '';
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (ch === '\x1b') {
      const esc = readEscapeSequence(input, i);
      if (isOsc8Sequence(esc.raw)) units.push({ raw: esc.raw, plain: '', width: 0 });
      else pendingEsc += esc.raw;
      i = esc.next - 1;
      continue;
    }
    const cp = input.codePointAt(i)!;
    const plain = String.fromCodePoint(cp);
    const raw = pendingEsc + plain;
    pendingEsc = '';
    units.push({ raw, plain, width: visibleWidth(plain) });
    if (cp > 0xFFFF) i++;
  }
  if (pendingEsc) units.push({ raw: pendingEsc, plain: '', width: 0 });
  return units;
}

function appendUnit(target: Unit[], unit: Unit): void {
  if (unit.plain === '' && unit.width === 0 && target.length > 0) {
    target[target.length - 1]!.raw += unit.raw;
    return;
  }
  target.push({ ...unit });
}

function tokenPlain(units: Unit[]): string {
  return units.map(u => u.plain).join('');
}

function tokenWidth(units: Unit[]): number {
  return units.reduce((sum, unit) => sum + unit.width, 0);
}

function splitTokens(units: Unit[]): Unit[][] {
  const tokens: Unit[][] = [];
  let current: Unit[] = [];
  let currentIsSpace: boolean | null = null;
  let pendingPrefixRaw = '';
  for (const unit of units) {
    if (unit.plain === '' && unit.width === 0) {
      if (current.length > 0 && currentIsSpace === false) current[current.length - 1]!.raw += unit.raw;
      else pendingPrefixRaw += unit.raw;
      continue;
    }
    const isSpace = /^\s$/.test(unit.plain);
    const nextUnit = pendingPrefixRaw
      ? { ...unit, raw: pendingPrefixRaw + unit.raw }
      : { ...unit };
    pendingPrefixRaw = '';
    if (current.length === 0 || currentIsSpace === isSpace) {
      appendUnit(current, nextUnit);
      currentIsSpace = isSpace;
      continue;
    }
    tokens.push(current);
    current = [nextUnit];
    currentIsSpace = isSpace;
  }
  if (pendingPrefixRaw) {
    if (current.length > 0) current[current.length - 1]!.raw += pendingPrefixRaw;
    else current.push({ raw: pendingPrefixRaw, plain: '', width: 0 });
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

function tokensToRaw(tokens: Unit[][]): string {
  return tokens.flat().map(unit => unit.raw).join('');
}

function trimLeadingSpace(tokens: Unit[][]): Unit[][] {
  let idx = 0;
  while (idx < tokens.length && /^\s+$/.test(tokenPlain(tokens[idx]!))) idx++;
  return tokens.slice(idx);
}

function splitTokenByWidth(token: Unit[], maxWidth: number): Unit[][] {
  if (tokenWidth(token) <= maxWidth || maxWidth <= 0) return [token];
  const out: Unit[][] = [];
  let current: Unit[] = [];
  let width = 0;
  for (const unit of token) {
    if (unit.width === 0) {
      appendUnit(current, unit);
      continue;
    }
    if (current.length > 0 && width + unit.width > maxWidth) {
      out.push(current);
      current = [];
      width = 0;
    }
    appendUnit(current, unit);
    width += unit.width;
  }
  if (current.length > 0) out.push(current);
  return out;
}

export function urlAwareWrap(text: string, cols: number, opts: WrapOptions = {}): string[] {
  const width = Math.max(1, cols);
  const urlAware = opts.urlAware === true;
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    const tokens = splitTokens(toUnits(paragraph));
    if (tokens.length === 0) {
      lines.push('');
      continue;
    }
    let current: Unit[][] = [];
    let currentWidth = 0;
    const flush = (): void => {
      lines.push(tokensToRaw(current));
      current = [];
      currentWidth = 0;
    };
    for (let idx = 0; idx < tokens.length; idx++) {
      const token = tokens[idx]!;
      const plain = tokenPlain(token);
      const tokenIsSpace = /^\s+$/.test(plain);
      const tokenIsUrl = urlAware && URL_RE.test(plain);
      const widthNeeded = tokenWidth(token);
      if (current.length === 0 && tokenIsSpace) continue;
      if (tokenIsUrl && current.length > 0 && currentWidth + widthNeeded > width) {
        flush();
      }
      if (current.length === 0) {
        if (!tokenIsUrl && widthNeeded > width && !tokenIsSpace) {
          const chunks = splitTokenByWidth(token, width);
          for (let c = 0; c < chunks.length; c++) {
            const chunk = chunks[c]!;
            if (c < chunks.length - 1) lines.push(tokensToRaw([chunk]));
            else {
              current = [chunk];
              currentWidth = tokenWidth(chunk);
            }
          }
          continue;
        }
        current = [token];
        currentWidth = widthNeeded;
        continue;
      }
      if (currentWidth + widthNeeded <= width) {
        current.push(token);
        currentWidth += widthNeeded;
        continue;
      }
      if (tokenIsSpace) {
        flush();
        continue;
      }
      flush();
      const nextTokens = trimLeadingSpace([token]);
      if (nextTokens.length === 0) continue;
      const nextToken = nextTokens[0]!;
      const nextIsUrl = urlAware && URL_RE.test(tokenPlain(nextToken));
      if (!nextIsUrl && tokenWidth(nextToken) > width) {
        const chunks = splitTokenByWidth(nextToken, width);
        for (let c = 0; c < chunks.length; c++) {
          const chunk = chunks[c]!;
          if (c < chunks.length - 1) lines.push(tokensToRaw([chunk]));
          else {
            current = [chunk];
            currentWidth = tokenWidth(chunk);
          }
        }
      } else {
        current = [nextToken];
        currentWidth = tokenWidth(nextToken);
      }
    }
    if (current.length > 0) flush();
  }
  return lines;
}
