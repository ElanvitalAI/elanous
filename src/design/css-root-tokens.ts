import type { DeclaredToken } from './design-tokens.js';

export interface CssRootTokens {
  readonly palette: readonly DeclaredToken[];
  readonly typography: readonly DeclaredToken[];
  readonly motion: readonly DeclaredToken[];
  readonly other: readonly DeclaredToken[];
}

/** Only the first :root rule contributes tokens; selectors and comments are not declarations. */
export function readCssRootTokens(css: string): CssRootTokens {
  const result: {
    palette: DeclaredToken[];
    typography: DeclaredToken[];
    motion: DeclaredToken[];
    other: DeclaredToken[];
  } = { palette: [], typography: [], motion: [], other: [] };

  // Mask comments and strings without shifting indices, then inspect rule preludes only.
  const masked = css.replace(/\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, (part) => ' '.repeat(part.length));
  const frames = [{ ruleList: true, start: 0 }];
  let opening = -1;
  let parentheses = 0;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === '\\' && i + 1 < masked.length) { i++; continue; }
    if (c === '(') { parentheses++; continue; }
    if (c === ')') { parentheses = Math.max(0, parentheses - 1); continue; }
    if (parentheses > 0) continue;
    const frame = frames[frames.length - 1];
    if (c === '{') {
      const prelude = masked.slice(frame.start, i).trim();
      if (frame.ruleList && /(?:^|,)\s*:root\s*(?=,|$)/.test(prelude)) { opening = i; break; }
      frames.push({ ruleList: frame.ruleList && /^@(?:media|supports|container|layer|scope|document)\b/.test(prelude), start: i + 1 });
    } else if (c === '}') {
      if (frames.length > 1) frames.pop();
      frames[frames.length - 1].start = i + 1;
    } else if (c === ';') {
      frame.start = i + 1;
    }
  }
  if (opening < 0) return result;

  // Walk the rule rather than stopping at the first brace inside a quoted or nested value.
  let depth = 1;
  let quote = '';
  let comment = false;
  let value = '';
  let parens = 0;
  const add = (declaration: string) => {
    const match = /^\s*(--[\w\u0080-\uffff-]+)\s*:\s*([\s\S]*)$/.exec(declaration);
    if (!match) return;
    const token: DeclaredToken = { name: match[1], value: match[2].trim() };
    const name = token.name.toLowerCase();
    if (/^(?:#[\da-f]{3,8}\b|(?:rgb|hsl|oklch|lab|lch|color)\()/i.test(token.value)
      || /^--(?:color|colour|accent|ink|ground|background|foreground|brand|surface|border|muted|bg|fg|primary|secondary)(?:-|_|$)/.test(name)) result.palette.push(token);
    else if (/^--(?:font|typography|type|text|line-height|letter-spacing)(?:-|_|$)/.test(name)) result.typography.push(token);
    else if (/^--(?:motion|duration|ease|easing|transition|animation|delay)(?:-|_|$)/.test(name)) result.motion.push(token);
    else result.other.push(token);
  };
  for (let i = opening + 1; i < css.length && depth > 0; i++) {
    const c = css[i];
    const next = css[i + 1];
    if (comment) {
      if (c === '*' && next === '/') { comment = false; i++; }
      else if (c === '\n') value += ' ';
      continue;
    }
    if (quote) {
      value += c;
      if (c === '\\' && next !== undefined) value += css[++i];
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '/' && next === '*') { comment = true; i++; value += ' '; continue; }
    if (c === '\\' && next !== undefined) { value += c; value += next; i++; continue; }
    if (c === '"' || c === "'") { quote = c; value += c; continue; }
    if (c === '(') parens++;
    else if (c === ')' && parens > 0) parens--;
    if (parens === 0 && c === '{') depth++;
    if (parens === 0 && c === '}') {
      depth--;
      if (depth === 0) { add(value); break; }
    }
    if (depth === 1 && parens === 0 && c === ';') { add(value); value = ''; }
    else if (depth > 0) value += c;
  }
  return result;
}
