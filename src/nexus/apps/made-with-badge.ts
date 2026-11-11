const BADGE_STYLE = 'all:revert!important;display:block!important;font:14px/1.4 sans-serif!important;color:#555!important;background:transparent!important;height:auto!important;max-height:none!important;min-height:1em!important;overflow:visible!important;width:auto!important;max-width:100%!important;text-indent:0!important;visibility:visible!important;opacity:1!important;position:static!important;clip:auto!important;clip-path:none!important;transform:none!important';
const BADGE_MARKUP = `<footer data-elanous-made-with-badge="true" class="elanous-made-with-badge" style="${BADGE_STYLE}">made with elanous</footer>`;
export const MADE_WITH_BADGE_ENTITLEMENT = 'nexus.app.attribution';

interface HtmlTag {
  readonly start: number;
  readonly end: number;
  readonly name: string;
  readonly closing: boolean;
  readonly selfClosing: boolean;
  readonly attributes: string;
  readonly unclosedRawText?: boolean;
}

function findTagEnd(html: string, start: number): number {
  let quote = '';
  for (let index = start; index < html.length; index += 1) {
    const character = html[index]!;
    if (quote) {
      if (character === quote) quote = '';
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return index + 1;
    }
  }
  return -1;
}

function* htmlTags(html: string, skipTemplateContent = true): Generator<HtmlTag> {
  const rawTextElements = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes']);
  let index = 0;
  while (index < html.length) {
    const start = html.indexOf('<', index);
    if (start < 0) return;
    if (html.startsWith('<!--', start)) {
      const commentEnd = html.indexOf('-->', start + 4);
      index = commentEnd < 0 ? html.length : commentEnd + 3;
      continue;
    }
    const end = findTagEnd(html, start + 1);
    if (end < 0) return;
    const source = html.slice(start, end);
    const match = /^<\s*(\/?)\s*([a-z][\w:-]*)\b([\s\S]*?)\s*(\/?)>$/i.exec(source);
    if (!match) {
      index = start + 1;
      continue;
    }
    index = end;
    const closing = match[1] === '/';
    const name = match[2]!.toLowerCase();
    yield { start, end, name, closing, selfClosing: match[4] === '/', attributes: match[3]! };
    if (!closing && name === 'template' && skipTemplateContent) {
      let depth = 1;
      let templateEnd = -1;
      for (const nested of htmlTags(html.slice(end), false)) {
        if (nested.name !== 'template') continue;
        if (!nested.closing) depth += 1;
        else if (nested.closing && --depth === 0) {
          templateEnd = end + nested.end;
          break;
        }
      }
      if (templateEnd < 0) return;
      index = templateEnd;
      continue;
    }
    if (!closing && name === 'plaintext') {
      yield { start, end, name, closing, selfClosing: false, attributes: match[3]!, unclosedRawText: true };
      return;
    }
    if (!closing && rawTextElements.has(name)) {
      const closingTag = new RegExp(`<\\/${name}[\\t\\n\\f\\r ]*>`, 'ig');
      closingTag.lastIndex = end;
      const closingMatch = closingTag.exec(html);
      if (!closingMatch) {
        yield { start, end, name, closing, selfClosing: false, attributes: match[3]!, unclosedRawText: true };
        return;
      }
      yield { start: closingMatch.index, end: closingTag.lastIndex, name, closing: true, selfClosing: false, attributes: '' };
      index = closingTag.lastIndex;
    }
  }
}

function hasOwnedBadgeMarker(attributes: string): boolean {
  let index = 0;
  while (index < attributes.length) {
    while (/\s/.test(attributes[index] ?? '')) index += 1;
    const nameStart = index;
    while (index < attributes.length && !/[\s=/>]/.test(attributes[index]!)) index += 1;
    if (index === nameStart) { index += 1; continue; }
    const name = attributes.slice(nameStart, index).toLowerCase();
    while (/\s/.test(attributes[index] ?? '')) index += 1;
    if (attributes[index] !== '=') continue;
    index += 1;
    while (/\s/.test(attributes[index] ?? '')) index += 1;
    const quote = attributes[index] === '"' || attributes[index] === "'" ? attributes[index++] : undefined;
    const valueStart = index;
    if (quote) {
      while (index < attributes.length && attributes[index] !== quote) index += 1;
    } else {
      while (index < attributes.length && !/[\s>]/.test(attributes[index]!)) index += 1;
    }
    const value = attributes.slice(valueStart, index);
    if (quote && attributes[index] === quote) index += 1;
    if (name === 'data-elanous-made-with-badge' && value.toLowerCase() === 'true') return true;
  }
  return false;
}

/** Finds a real meta charset declaration, ignoring comments and raw-text examples. */
export function detectDeclaredHtmlCharset(html: string): string | undefined {
  for (const tag of htmlTags(html)) {
    if (tag.closing || tag.name !== 'meta') continue;
    const charset = readHtmlAttribute(tag.attributes, 'charset');
    if (charset) return charset.trim();
    if (!/^(?:content-type)$/i.test(readHtmlAttribute(tag.attributes, 'http-equiv') ?? '')) continue;
    const value = readHtmlAttribute(tag.attributes, 'content') ?? '';
    const contentCharset = /(?:^|[;\s])charset\s*=\s*["']?\s*([a-z0-9._-]+)/i.exec(value)?.[1];
    if (contentCharset) return contentCharset.trim();
  }
  return undefined;
}

function readHtmlAttribute(attributes: string, targetName: string): string | undefined {
  const pattern = /(?:^|\s)([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (const match of attributes.matchAll(pattern)) {
    if (match[1]?.toLowerCase() !== targetName) continue;
    return match[2] ?? match[3] ?? match[4];
  }
  return undefined;
}

function stripOwnedBadges(html: string): string {
  const tags = [...htmlTags(html)];
  const removals: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < tags.length; index += 1) {
    const tag = tags[index]!;
    if (tag.closing || tag.name !== 'footer' || !hasOwnedBadgeMarker(tag.attributes)) continue;
    let depth = 1;
    let matchedClosingTag = false;
    for (const candidate of tags.slice(index + 1)) {
      if (candidate.name !== 'footer') continue;
      if (!candidate.closing) depth += 1;
      if (candidate.closing && --depth === 0) {
        removals.push({ start: tag.start, end: candidate.end });
        matchedClosingTag = true;
        break;
      }
    }
    if (!matchedClosingTag) {
      const nextMarkup = html.indexOf('<', tag.end);
      removals.push({ start: tag.start, end: nextMarkup < 0 ? html.length : nextMarkup });
    }
  }
  const merged: Array<{ start: number; end: number }> = [];
  for (const removal of removals.sort((a, b) => a.start - b.start)) {
    const prior = merged.at(-1);
    if (prior && removal.start <= prior.end) prior.end = Math.max(prior.end, removal.end);
    else merged.push({ ...removal });
  }
  for (const removal of merged.reverse()) html = html.slice(0, removal.start) + html.slice(removal.end);
  return html;
}

/** Adds the attribution at the page bottom and keeps exactly one owned badge. */
export function applyMadeWithBadge(html: string, entitlements?: Readonly<Record<string, unknown>>): string {
  const withoutPriorBadge = stripOwnedBadges(html);
  // Source: 내부 문서 `nexus-revenue-and-market` §2③⑤ — managed plans can remove the free attribution.
  if (entitlements?.[MADE_WITH_BADGE_ENTITLEMENT] === 0) return withoutPriorBadge;

  let bodyClose = -1;
  let htmlClose = -1;
  let plaintextStart = -1;
  const openElements: string[] = [];
  const voidElements = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  let bodyChildrenToClose = '';
  for (const tag of htmlTags(withoutPriorBadge)) {
    if (tag.unclosedRawText) {
      plaintextStart = tag.start;
      break;
    }
    if (!tag.closing && tag.name === 'plaintext') {
      plaintextStart = tag.start;
      break;
    }
    if (tag.closing) {
      if (tag.name === 'body') {
        bodyClose = tag.start;
        const bodyIndex = openElements.lastIndexOf('body');
        // Source: Array.prototype.lastIndexOf returns -1 when the open body tag is absent.
        if (bodyIndex >= 0) bodyChildrenToClose = openElements.slice(bodyIndex + 1).reverse().map(name => `</${name}>`).join('');
      }
      if (tag.name === 'html') htmlClose = tag.start;
      const openIndex = openElements.lastIndexOf(tag.name);
      // Source: Array.prototype.lastIndexOf returns -1 when the matching open tag is absent.
      if (openIndex >= 0) openElements.splice(openIndex);
      continue;
    }
    if (tag.name !== 'template' && !voidElements.has(tag.name)) openElements.push(tag.name);
  }
  const insertionPoint = bodyClose >= 0 ? bodyClose
    : htmlClose >= 0 ? htmlClose
      : plaintextStart >= 0 ? plaintextStart
        : withoutPriorBadge.length;
  if (bodyClose < 0) {
    const bodyIndex = openElements.lastIndexOf('body');
    // Source: Array.prototype.lastIndexOf returns -1 when the open body tag is absent.
    if (bodyIndex >= 0) bodyChildrenToClose = openElements.slice(bodyIndex + 1).reverse().map(name => `</${name}>`).join('');
  }
  const closingTags = insertionPoint === bodyClose || bodyClose < 0
    ? bodyChildrenToClose
    : '';
  return `${withoutPriorBadge.slice(0, insertionPoint)}${closingTags}${BADGE_MARKUP}${withoutPriorBadge.slice(insertionPoint)}`;
}
