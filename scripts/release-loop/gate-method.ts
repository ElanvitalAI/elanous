/** File seconds are recorded on the outer testsuite of each JUnit file, not its nested describe suites. */
export function readJunitFileSeconds(xml: string): Map<string, number> {
  const secondsByFile = new Map<string, number>();
  const entities: Record<string, string> = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' };
  let depth = 0;
  let cursor = 0;
  while (cursor < xml.length) {
    const start = xml.indexOf('<', cursor);
    if (start < 0) break;
    if (xml.startsWith('<![CDATA[', start)) {
      const end = xml.indexOf(']]>', start + 9);
      if (end < 0) break;
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith('<!--', start)) {
      const end = xml.indexOf('-->', start + 4);
      if (end < 0) break;
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith('<?', start)) {
      const end = xml.indexOf('?>', start + 2);
      if (end < 0) break;
      cursor = end + 2;
      continue;
    }
    let quote = '';
    let brackets = 0;
    let end = start + 1;
    for (; end < xml.length; end++) {
      const char = xml[end]!;
      if (quote) { if (char === quote) quote = ''; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === '[' && xml.startsWith('<!', start)) brackets++;
      else if (char === ']' && brackets) brackets--;
      else if (char === '>' && !brackets) break;
    }
    if (end === xml.length) break;
    cursor = end + 1;
    const tag = xml.slice(start + 1, end);
    const suite = /^(\/?)testsuite(?=[\s/]|$)/.exec(tag);
    if (!suite) continue;
    if (suite[1]) { depth = Math.max(0, depth - 1); continue; }
    if (depth === 0) {
      const file = /\bfile="([^"]+)"/.exec(tag)?.[1];
      const rawTime = /\btime="([^"]+)"/.exec(tag)?.[1];
      if (file && rawTime !== undefined) {
        const seconds = Number(rawTime);
        if (Number.isFinite(seconds) && seconds >= 0) {
          const path = file.replace(/&(?:amp|quot|apos|lt|gt);/g, (entity) => entities[entity]!);
          secondsByFile.set(path, Math.max(secondsByFile.get(path) ?? 0, seconds));
        }
      }
    }
    if (!/\/\s*$/.test(tag)) depth++;
  }
  return secondsByFile;
}
