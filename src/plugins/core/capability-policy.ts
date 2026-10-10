import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { ExecutionSurfaceSpec } from '../../display/index.js';
import type { PluginCapability, PluginSource } from './manifest.js';

export type CapabilityDecision =
  | { ok: true }
  | { ok: false; reason: string };

export interface CapabilityPolicyContext {
  pluginId: string;
  source: PluginSource;
  capabilities: PluginCapability[];
  workspaceTrusted?: boolean;
  userTrusted?: boolean;
}

export class PluginCapabilityPolicy {
  constructor(private readonly defaults: { userTrusted?: boolean; workspaceTrusted?: boolean } = {}) {}

  canReadFile(ctx: CapabilityPolicyContext, path: string): CapabilityDecision {
    const trust = this.checkTrust(ctx);
    if (!trust.ok) return trust;
    if (ctx.source === 'builtin') return { ok: true };
    return fileCapabilityDecision(ctx, 'fs:read', path);
  }

  canWriteFile(ctx: CapabilityPolicyContext, path: string): CapabilityDecision {
    const trust = this.checkTrust(ctx);
    if (!trust.ok) return trust;
    if (ctx.source === 'builtin') return { ok: true };
    return fileCapabilityDecision(ctx, 'fs:write', path);
  }

  canNetwork(ctx: CapabilityPolicyContext, url: string): CapabilityDecision {
    const trust = this.checkTrust(ctx);
    if (!trust.ok) return trust;
    if (ctx.source === 'builtin') return { ok: true };
    const host = safeHost(url);
    if (!host) return deny(ctx.pluginId, `invalid network URL: ${url}`);
    const grants = ctx.capabilities.filter(isNetworkCapability);
    if (grants.length === 0) return deny(ctx.pluginId, 'network access requires capability "network"');
    if (grants.some(grant => networkGrantAllows(grant, host))) return { ok: true };
    return deny(ctx.pluginId, `network host "${host}" is not allowed by plugin capabilities`);
  }

  canClipboard(ctx: CapabilityPolicyContext, mode: 'read' | 'write'): CapabilityDecision {
    const trust = this.checkTrust(ctx);
    if (!trust.ok) return trust;
    if (ctx.source === 'builtin') return { ok: true };
    const grants = ctx.capabilities.filter(cap =>
      cap.kind === 'clipboard'
      || cap.kind === `clipboard:${mode}`
    );
    if (grants.length > 0) return { ok: true };
    return deny(ctx.pluginId, `clipboard ${mode} requires capability "clipboard:${mode}"`);
  }

  canSpawnProcess(ctx: CapabilityPolicyContext, spec: ExecutionSurfaceSpec): CapabilityDecision {
    const trust = this.checkTrust(ctx);
    if (!trust.ok) return trust;

    if (ctx.source === 'builtin') return { ok: true };

    const command = requestedCommand(spec);
    const grants = ctx.capabilities.filter(isProcessCapability);
    if (grants.length === 0) {
      return deny(ctx.pluginId, `process execution requires capability "process:spawn"`);
    }

    if (!command) return { ok: true };
    if (grants.some(grant => processGrantAllows(grant, command))) return { ok: true };

    return deny(ctx.pluginId, `process command "${command}" is not allowed by plugin capabilities`);
  }

  private checkTrust(ctx: CapabilityPolicyContext): CapabilityDecision {
    if (ctx.source === 'workspace' && !(ctx.workspaceTrusted ?? this.defaults.workspaceTrusted ?? false)) {
      return deny(ctx.pluginId, 'workspace plugin is not trusted');
    }
    if (ctx.source === 'user' && !(ctx.userTrusted ?? this.defaults.userTrusted ?? true)) {
      return deny(ctx.pluginId, 'user plugin is not trusted');
    }
    return { ok: true };
  }
}

export type PluginScanLevel = 'safe' | 'caution' | 'dangerous';
export interface PluginSecurityFinding { level: Exclude<PluginScanLevel, 'safe'>; code: string }
export interface PluginSecurityDecision {
  scan: PluginScanLevel;
  findings: PluginSecurityFinding[];
  integrity: string;
  license: 'redistributable' | 'restricted' | 'unknown';
}

/** Scan bytes before consent or installation. Only non-identifying codes leave this boundary. */
export function inspectPluginSecurity(dir: string): PluginSecurityDecision {
  const findings: PluginSecurityFinding[] = [];
  const hash = createHash('sha256');
  let license: PluginSecurityDecision['license'] = 'unknown';
  // Code files are collected first; import/exec checks run after we know which files are reachable at runtime.
  const code = new Map<string, { text: string; test: boolean }>();
  const entrypoints: string[] = [];
  const visit = (folder: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const file = join(folder, entry.name);
      const rel = relative(dir, file).replaceAll('\\', '/');
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
        findings.push({ level: 'dangerous', code: 'unsafe-entry' });
        hash.update(rel).update('!\0');
        continue;
      }
      if (entry.isDirectory()) { hash.update(rel).update('/\0'); visit(file); continue; }
      hash.update(rel).update('\0');
      // Size is checked before reading so an oversized import cannot exhaust memory in the scanner.
      const size = statSync(file).size;
      if (size > 2_000_000) {
        hash.update(String(size)).update('\0').update('oversize');
        findings.push({ level: 'dangerous', code: 'unscannable-file' });
        continue;
      }
      const bytes = readFileSync(file);
      hash.update(String(bytes.length)).update('\0').update(bytes);
      if (/(?:^|\/)(?:\.env(?:\.|$)|id_rsa$|credentials?\.json$)/i.test(rel)) {
        findings.push({ level: 'dangerous', code: 'credential-file' });
      }
      if (/(?:api[_-]?key|secret|token)\s*[:=]\s*[A-Za-z0-9_-]{16,}/i.test(rel)) {
        findings.push({ level: 'dangerous', code: 'credential-filename' });
      }
      if (/^(?:LICENSE|LICENCE)(?:\.[^/]*)?$/i.test(rel)) {
        if (/\b(?:MIT License|Apache License, Version 2\.0|BSD [23]-Clause|ISC License)\b/i.test(bytes.toString('utf8'))) license = 'redistributable';
        else if (license !== 'redistributable') license = 'restricted';
      }
      if (bytes.includes(0)) {
        findings.push({ level: 'dangerous', code: 'unscannable-file' });
        continue;
      }
      const text = bytes.toString('utf8');
      if (/^plugin\.json$/.test(rel)) {
        try {
          const manifest: unknown = JSON.parse(text);
          if (manifest && typeof manifest === 'object' && !Array.isArray(manifest)) {
            const raw = manifest as Record<string, unknown>;
            const ext = raw.extensions && typeof raw.extensions === 'object' ? (raw.extensions as Record<string, unknown>)['ai.elanous'] : undefined;
            for (const main of [raw.main, ext && typeof ext === 'object' ? (ext as Record<string, unknown>).main : undefined]) {
              if (typeof main === 'string' && main.trim()) entrypoints.push(resolve(dir, main));
            }
            if (typeof raw.license === 'string' && raw.license.trim()) {
              license = /^(?:MIT|Apache-2\.0|BSD-2-Clause|BSD-3-Clause|ISC|0BSD|CC0-1\.0)$/.test(raw.license.trim())
                ? 'redistributable' : 'restricted';
            }
            const contributes = raw.contributes ?? (ext && typeof ext === 'object' ? (ext as Record<string, unknown>).contributes : undefined);
            if (contributes && typeof contributes === 'object' && Array.isArray((contributes as Record<string, unknown>).hooks)
              && ((contributes as Record<string, unknown>).hooks as unknown[]).length) {
              findings.push({ level: 'caution', code: 'hooks-disabled' });
            }
          }
        } catch { findings.push({ level: 'dangerous', code: 'invalid-manifest' }); }
      }
      // Quotes may be JSON-escaped (a value nested inside a JSON string field), so allow a backslash before them.
      const sensitive = /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:\\?["'])?(?:api[_-]?key|secret|token)(?:\\?["'])?\s*[:=]\s*(\\?["'])?([A-Za-z0-9_\-]{16,})(\(?))/gi;
      // Two narrow non-secrets: a documented placeholder (`tvly-YOUR_API_KEY`, `xxxxxxxx…`, `REPLACE_ME`) and an
      // unquoted call result (`apiKey = getUpstageApiKey()`). Anything else that matches — quoted or not — still counts.
      // Both exemptions look at the WHOLE value: a placeholder shape (optional vendor prefix), or a digit-free
      // camelCase function name immediately called. A key with `xxxxxxxx` or `YOUR_` inside it still counts.
      const placeholder = /^(?:[A-Za-z0-9]+[_-])*(?:YOUR[_-][A-Za-z_-]+|PLACEHOLDER[A-Za-z_-]*|REPLACE[_-]?ME[A-Za-z_-]*|x{8,})$/i;
      const callee = /^[a-z_$][A-Za-z_$]*[a-z][A-Z][A-Za-z_$]*$/;
      const hasSecret = [...text.matchAll(sensitive)].some(([, quote, value, call]) => value === undefined
        || !(placeholder.test(value) || (!quote && call === '(' && callee.test(value))));
      if (/(?:^|\/)(?:knowledge|knowledge-packs?)(?:\/|$)/i.test(rel) && hasSecret) {
        findings.push({ level: 'dangerous', code: 'knowledge-dlp' });
      } else if (hasSecret && !/\.lock$/.test(rel)) {
        findings.push({ level: 'dangerous', code: 'embedded-secret' });
      }
      if (/\.[cm]?[jt]sx?$/.test(rel)) code.set(resolve(file), { text, test: /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/.test(rel) });
      if (/(?:curl|wget)\b[^\n|]*\|\s*(?:sh|bash)\b|\b(?:rm\s+-rf|sudo)\b/i.test(text)) {
        findings.push({ level: 'dangerous', code: 'unsafe-command' });
      }
    }
  };
  visit(dir);
  if (!entrypoints.length) entrypoints.push(resolve(dir, 'plugin.ts'));
  // Shipped test fixtures are skipped only while nothing executable reaches them: the manifest `main`
  // and every non-test code file are roots, and any test file they import (transitively) is scanned too.
  const importsOf = (text: string): string[] =>
    [...text.matchAll(/\b(?:import|export)\s*(?:[\s\S]*?\s+from\s*)?["']([^"']+)["']|\b(?:import|require)\s*\(\s*["']([^"']+)["']/g)]
      .map(match => match[1] ?? match[2] ?? '').filter(Boolean);
  const resolveLocal = (from: string, target: string): string | undefined => {
    if (!target.startsWith('.')) return undefined;
    const base = resolve(from, '..', target);
    const swapped = base.replace(/\.([cm]?)js(x?)$/, '.$1ts$2');
    return [base, swapped, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`, join(base, 'index.ts'), join(base, 'index.js')]
      .find(candidate => code.has(candidate));
  };
  const reachable = new Set<string>();
  const queue = [...entrypoints.filter(path => code.has(path)), ...[...code].filter(([, info]) => !info.test).map(([path]) => path)];
  while (queue.length) {
    const file = queue.pop()!;
    if (reachable.has(file)) continue;
    reachable.add(file);
    for (const target of importsOf(code.get(file)!.text)) {
      const next = resolveLocal(file, target);
      if (next && !reachable.has(next)) queue.push(next);
    }
  }
  for (const file of reachable) {
    const text = code.get(file)!.text;
    if (/\b(?:eval\s*\(|new\s+Function\s*\(|child_process\b|Bun\.spawn\s*\()/i.test(text)) {
      findings.push({ level: 'caution', code: 'executable-code' });
    }
    for (const target of importsOf(text)) {
      // A relative or absolute import must stay inside the package; the package's own `./src/…` is fine,
      // while `../…/src/`, `/abs/…/src/` or a `file:` URL that can leave the package root is unsafe.
      if (/^file:/i.test(target)
        || ((target.startsWith('.') || target.startsWith('/')) && !resolve(file, '..', target).startsWith(`${resolve(dir)}${sep}`))) {
        findings.push({ level: 'dangerous', code: 'unsafe-import' });
      }
    }
  }
  if ((license as PluginSecurityDecision['license']) !== 'redistributable') findings.push({ level: 'caution', code: 'private-only-license' });
  return { scan: findings.some(f => f.level === 'dangerous') ? 'dangerous' : findings.length ? 'caution' : 'safe',
    findings, integrity: hash.digest('hex'), license };
}

export function assertCapability(decision: CapabilityDecision): void {
  if (!decision.ok) throw new Error(decision.reason);
}

export function requestedCommand(spec: ExecutionSurfaceSpec): string | null {
  const raw = spec.command?.trim() || spec.shell?.trim() || '';
  if (!raw) return null;
  const match = raw.match(/^"([^"]+)"|'([^']+)'|(\S+)/);
  const first = match?.[1] ?? match?.[2] ?? match?.[3] ?? '';
  if (!first) return null;
  const parts = first.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? first;
}

function isProcessCapability(cap: PluginCapability): boolean {
  return cap.kind === 'process:spawn' || cap.kind === 'process:exec';
}

function fileCapabilityDecision(ctx: CapabilityPolicyContext, kind: 'fs:read' | 'fs:write', path: string): CapabilityDecision {
  const grants = ctx.capabilities.filter(cap => cap.kind === kind);
  if (grants.length === 0) return deny(ctx.pluginId, `${kind} requires capability "${kind}"`);
  if (grants.some(grant => fileGrantAllows(grant, path))) return { ok: true };
  return deny(ctx.pluginId, `file path is not allowed by plugin capabilities: ${path}`);
}

function fileGrantAllows(cap: PluginCapability, path: string): boolean {
  const roots = 'roots' in cap && Array.isArray(cap.roots) ? cap.roots : [];
  if (roots.length === 0) return true;
  return roots.some(root => {
    if (typeof root !== 'string' || !root) return false;
    return path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`);
  });
}

function isNetworkCapability(cap: PluginCapability): boolean {
  return cap.kind === 'network' || cap.kind === 'network:fetch';
}

function networkGrantAllows(cap: PluginCapability, host: string): boolean {
  const hosts = 'hosts' in cap && Array.isArray(cap.hosts)
    ? cap.hosts
    : 'host' in cap && typeof cap.host === 'string'
      ? [cap.host]
      : [];
  if (hosts.length === 0) return true;
  return hosts.some(item => item === '*' || item === host);
}

function safeHost(url: string): string | null {
  try { return new URL(url).host; }
  catch { return null; }
}

function processGrantAllows(cap: PluginCapability, command: string): boolean {
  const commands = processCapabilityCommands(cap);
  if (commands.length === 0) return true;
  return commands.includes(command) || commands.includes('*');
}

function processCapabilityCommands(cap: PluginCapability): string[] {
  const raw = 'commands' in cap ? cap.commands : 'command' in cap ? [cap.command] : [];
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map(item => item.trim());
}

function deny(pluginId: string, reason: string): CapabilityDecision {
  return { ok: false, reason: `plugin "${pluginId}": ${reason}` };
}
