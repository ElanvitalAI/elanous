import { execFileSync } from 'node:child_process';
import { networkInterfaces } from 'node:os';

export function isPrivateIpv4(addr: string): boolean {
  const parts = addr.split('.');
  if (parts.length !== 4 || parts.some(part => !/^(0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)) return false;
  const [a, b] = parts.map(Number);
  return a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168);
}

export function defaultRouteInterface(platform: NodeJS.Platform = process.platform): string | undefined {
  try {
    if (platform === 'darwin') {
      return /^\s*interface:\s*(\S+)/m.exec(execFileSync('route', ['-n', 'get', 'default'], { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] }))?.[1];
    }
    if (platform === 'linux') {
      return /^default\s+.*?\bdev\s+(\S+)/m.exec(execFileSync('ip', ['route', 'show', 'default'], { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] }))?.[1];
    }
  } catch { /* Route lookup is optional. */ }
  return undefined;
}

export function pickLanAddress({ interfaces, defaultRouteInterface: route }: {
  interfaces: ReturnType<typeof networkInterfaces>;
  defaultRouteInterface?: string | (() => string | undefined);
}): string | null {
  const candidates: { name: string; address: string }[] = [];
  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const info of addresses ?? []) {
      if (info.family === 'IPv4' && !info.internal && isPrivateIpv4(info.address)) {
        candidates.push({ name, address: info.address });
      }
    }
  }
  if (candidates.length === 0) return null;
  let preferred: string | undefined;
  try { preferred = typeof route === 'function' ? route() : route ?? defaultRouteInterface(); } catch { /* Use sorted candidates. */ }
  candidates.sort((a, b) => a.name.localeCompare(b.name) || a.address.localeCompare(b.address));
  return (candidates.find(candidate => candidate.name === preferred) ?? candidates[0])?.address ?? null;
}

export function isLanReachableBind(httpHost: string | undefined): boolean {
  const host = httpHost?.trim() ?? '';
  return host === '' || host === '0.0.0.0' || host === '::' || host === '[::]' || isPrivateIpv4(host);
}
