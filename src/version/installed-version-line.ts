/** Installed builds put the full revision last, with an optional display stamp. */
export function parseInstalledVersionLine(line: string): { version: string; commit: string } | null {
  const match = /^(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?) (?:(?:\d{6}_\d{4}|official) )?([a-fA-F0-9]{40})$/.exec(line);
  return match ? { version: match[1]!, commit: match[2]! } : null;
}
