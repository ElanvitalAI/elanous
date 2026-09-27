export function safeName(text: string): string {
  const compact = String(text || 'untitled')
    .replace(/[\\/:*?"<>|#^\[\]]/g, ' ')
    .replace(/[^0-9A-Za-z가-힣\s_-]/g, ' ')
    .replace(/\s+/g, '_')
    .trim();
  if (!compact) return 'untitled';
  return compact.length <= 60 ? compact : compact.substring(0, 60).replace(/_$/, '');
}

export function dateStamp(d = new Date()): string {
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('');
}

export function nowISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function nowFull(): string {
  const d = new Date();
  return `${nowISO()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function escapeQuotes(text: string): string {
  return String(text || '').replace(/"/g, '\\"');
}

export function compactText(text: string, maxLen = 18000): string {
  if (text.length <= maxLen) return text;
  const headLen = Math.floor(maxLen * 0.65);
  const tailLen = maxLen - headLen;
  return text.slice(0, headLen) + '\n\n[...중간 생략...]\n\n' + text.slice(-tailLen);
}
