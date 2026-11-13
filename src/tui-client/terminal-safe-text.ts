/** Remove terminal commands and control bytes from text supplied by a member or app. */
export function terminalSafeText(value: string): string {
  let safe = '';
  for (let index = 0; index < value.length;) {
    const code = value.charCodeAt(index);
    if (code === 0x1b || code === 0x9b || code === 0x9d || code === 0x90
      || code === 0x98 || code === 0x9e || code === 0x9f) {
      const escape = code === 0x1b;
      const next = escape ? value[index + 1] : '';
      if (code === 0x9b || (escape && next === '[')) {
        index += escape ? 2 : 1;
        while (index < value.length) {
          const part = value.charCodeAt(index++);
          if (part >= 0x40 && part <= 0x7e) break;
          if (part < 0x20 || part > 0x3f) { index--; break; }
        }
        continue;
      }
      if (code === 0x9d || code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f
        || (escape && next !== undefined && ']PX^_'.includes(next))) {
        const osc = code === 0x9d || next === ']';
        index += escape ? 2 : 1;
        while (index < value.length) {
          const part = value.charCodeAt(index);
          if ((osc && part === 0x07) || part === 0x9c) { index++; break; }
          if (part === 0x1b && value[index + 1] === '\\') { index += 2; break; }
          index++;
        }
        continue;
      }
      if (escape) {
        index++;
        while (index < value.length) {
          const part = value.charCodeAt(index);
          if (part >= 0x20 && part <= 0x2f) { index++; continue; }
          if (part >= 0x30 && part <= 0x7e) index++;
          break;
        }
        continue;
      }
    }
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) { index++; continue; }
    safe += value[index++];
  }
  return safe;
}
