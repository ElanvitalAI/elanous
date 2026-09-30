import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { elanousStateRoot } from '../../autopilot/state-paths.js';
import { loadPluginManifestFromDir } from '../core/manifest.js';
import { listInstalledPlugins, withLedgerLock } from './plugin-install.js';

const PLUGIN_NAME = /^[a-z0-9][a-z0-9-]{1,39}$/;
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

type FieldStatus = { name: string; env: string; set: boolean };

function credentialPath(name: string, root: string): string {
  if (!PLUGIN_NAME.test(name)) throw new Error('invalid plugin name');
  return join(root, 'plugins', 'credentials', `${name}.json`);
}

function declaredFields(name: string, root: string): Array<{ name: string; env: string }> {
  if (!PLUGIN_NAME.test(name)) throw new Error('invalid plugin name');
  const installed = listInstalledPlugins(root).filter(plugin => plugin.name === name);
  if (installed.length === 0) throw new Error(`plugin not installed: ${name}`);
  const fields = new Map<string, string>();
  for (const plugin of installed) {
    const manifest = loadPluginManifestFromDir(plugin.path, { id: plugin.name }).manifest;
    for (const connector of manifest.contributes.connectors ?? []) {
      for (const field of [
        ...(connector.fields ?? []).map(item => ({ name: item.name, env: item.env })),
        ...(connector.userConfig ?? []).map(item => ({ name: item.key, env: item.env })),
      ]) {
        if (!FIELD_NAME.test(field.name)) throw new Error('invalid plugin credential field name');
        const env = field.env === undefined
          ? `ELANOUS_PLUGIN_${name.replaceAll('-', '_').toUpperCase()}_${field.name.replaceAll('-', '_').toUpperCase()}`
          : field.env;
        if (typeof env !== 'string' || !ENV_NAME.test(env)) throw new Error('invalid plugin credential environment name');
        if (fields.has(field.name) && fields.get(field.name) !== env) throw new Error('conflicting plugin credential environment name');
        fields.set(field.name, env);
      }
    }
  }
  if (new Set(fields.values()).size !== fields.size) throw new Error('duplicate plugin credential environment name');
  return [...fields].map(([fieldName, env]) => ({ name: fieldName, env })).sort((a, b) => a.name.localeCompare(b.name));
}

function readCredentials(path: string): Record<string, string> {
  if (!existsSync(path)) return Object.create(null) as Record<string, string>;
  if (!lstatSync(path).isFile()) throw new Error('invalid plugin credential file');
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error('invalid plugin credential file'); }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)
    || Object.entries(parsed).some(([key, value]) => !FIELD_NAME.test(key) || typeof value !== 'string')) {
    throw new Error('invalid plugin credential file');
  }
  return Object.assign(Object.create(null) as Record<string, string>, parsed);
}

/** Update one installed plugin's declared fields. null removes a field; omitted fields remain intact. */
export function setPluginCredentials(name: string, fields: Record<string, string | null>, root = elanousStateRoot()): { set: string[] } {
  const path = credentialPath(name, root);
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('invalid plugin credential fields');
  const allowed = new Set(declaredFields(name, root).map(field => field.name));
  for (const [key, value] of Object.entries(fields)) {
    if (!allowed.has(key) || (typeof value !== 'string' && value !== null) || (typeof value === 'string' && value.includes('\0'))) {
      throw new Error('invalid plugin credential field');
    }
  }
  return withLedgerLock(root, () => {
    const current = readCredentials(path);
    for (const [key, value] of Object.entries(fields)) {
      if (value === null) delete current[key];
      else current[key] = value;
    }
    if (Object.keys(fields).length === 0) return { set: [] };
    mkdirSync(join(root, 'plugins', 'credentials'), { recursive: true, mode: 0o700 });
    const temp = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      const fd = openSync(temp, 'wx', 0o600);
      try {
        fchmodSync(fd, 0o600);
        writeFileSync(fd, JSON.stringify(current));
        fsyncSync(fd);
      } finally { closeSync(fd); }
      renameSync(temp, path);
    } finally { rmSync(temp, { force: true }); }
    return { set: Object.keys(fields).filter(key => Object.hasOwn(current, key)).sort() };
  });
}

/** Public metadata only: values never leave the credential store. */
export function credentialStatus(name: string, root = elanousStateRoot()): { fields: FieldStatus[] } {
  const declared = declaredFields(name, root);
  const saved = readCredentials(credentialPath(name, root));
  return { fields: declared.map(field => ({ ...field, set: Object.hasOwn(saved, field.name) })) };
}

/** Environment entries intended only for this plugin's child process. */
export function pluginEnv(name: string, root = elanousStateRoot()): Record<string, string> {
  const declared = declaredFields(name, root);
  const saved = readCredentials(credentialPath(name, root));
  const env = Object.create(null) as Record<string, string>;
  for (const field of declared) {
    if (Object.hasOwn(saved, field.name)) env[field.env] = saved[field.name]!;
  }
  return env;
}
