import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { loadLlmPolicy, type LoadedLlmPolicy } from '../policy/llm-policy.js';
import { judge } from '../llm/judge-layer.js';
import type { UserConfig } from '../user-config/types.js';
import { inspectBundle } from './bundle.js';
import { readDefinitionYaml } from './yaml.js';

/** Only a freshly-created temporary universe; no production installer or runtime is invoked. */
export function installSimulationBundle(bundle: string): { root: string; installed: string[] } {
  const source = realpathSync(bundle);
  const manifestPath = join(source, 'elanous.package.yaml');
  if (lstatSync(manifestPath).isSymbolicLink()) throw new Error('manifest symlink is not allowed');
  const inspected = inspectBundle(source);
  if (inspected.errors.length) throw new Error(inspected.errors.join('\n'));
  const manifest = readDefinitionYaml(join(source, 'elanous.package.yaml')).doc.toJS() as { name: string; version: string };
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(manifest.name)) throw new Error('invalid package name');
  const root = mkdtempSync(join(tmpdir(), 'elanous-bundle-sim-'));
  const target = join(root, 'defs', 'packages', manifest.name);
  mkdirSync(target, { recursive: true });
  copyFileSync(join(source, 'elanous.package.yaml'), join(target, 'elanous.package.yaml'));
  for (const unit of inspected.units) {
    const entry = unit.slice(unit.indexOf(':') + 1);
    const file = realpathSync(resolve(source, entry));
    const safe = relative(source, file);
    if (!safe || safe === '..' || safe.startsWith(`..${sep}`) || isAbsolute(safe)) throw new Error('path escapes bundle');
    // Preserve the declared path; never follow source symlinks in the destination.
    const destination = resolve(target, entry);
    const rel = relative(target, destination);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('invalid destination path');
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(file, destination);
    if (unit.startsWith('agents:')) {
      const agent = readDefinitionYaml(file).doc.toJS() as { identity?: { soul?: unknown }; memory?: { knowhow?: unknown }; subs?: Array<{ knowhow?: unknown }> };
      const refs = [agent.identity?.soul, agent.memory?.knowhow, ...(Array.isArray(agent.subs) ? agent.subs.map(s => s?.knowhow) : [])];
      for (const ref of new Set(refs.filter((v): v is string => typeof v === 'string' && v.length > 0))) {
        if (isAbsolute(ref)) throw new Error('agent reference must be relative');
        const declaredAsset = resolve(dirname(file), ref);
        const declaredRelative = relative(dirname(file), declaredAsset);
        if (!declaredRelative || declaredRelative === '..' || declaredRelative.startsWith(`..${sep}`) || isAbsolute(declaredRelative)) throw new Error('agent reference escapes agent directory');
        let component = dirname(file);
        for (const part of declaredRelative.split(sep)) {
          component = join(component, part);
          if (lstatSync(component).isSymbolicLink()) throw new Error('agent reference symlink is not allowed');
        }
        const asset = realpathSync(declaredAsset);
        const insideAgent = relative(dirname(file), asset);
        const insideBundle = relative(source, asset);
        if (!insideAgent || insideAgent === '..' || insideAgent.startsWith(`..${sep}`) || isAbsolute(insideAgent) || !insideBundle || insideBundle === '..' || insideBundle.startsWith(`..${sep}`) || isAbsolute(insideBundle) || !statSync(asset).isFile()) throw new Error('agent reference escapes bundle or agent directory');
        const assetTarget = resolve(dirname(destination), ref);
        const relTarget = relative(dirname(destination), assetTarget);
        if (!relTarget || relTarget === '..' || relTarget.startsWith(`..${sep}`) || isAbsolute(relTarget)) throw new Error('agent reference escapes staging directory');
        mkdirSync(dirname(assetTarget), { recursive: true });
        try { writeFileSync(assetTarget, readFileSync(asset), { flag: 'wx' }); }
        catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || !readFileSync(assetTarget).equals(readFileSync(asset))) throw e;
        }
      }
    }
  }
  // Validate the installed bytes, not merely the source inspected before copying.
  const staged = inspectBundle(target);
  if (staged.errors.length || JSON.stringify(staged.units) !== JSON.stringify(inspected.units)) throw new Error(`installed snapshot failed validation: ${staged.errors.join('; ')}`);
  const ledger = { simulation: true, packages: [{ name: manifest.name, version: manifest.version, units: staged.units }] };
  writeFileSync(join(root, 'defs', 'installed.json'), JSON.stringify(ledger, null, 2) + '\n', { flag: 'wx' });
  return { root, installed: staged.units };
}

/** Read the installed snapshot, without consulting the source bundle or user configuration. */
export function loadInstalledSimulationBundlePolicy(root: string): { root: string; loaded: LoadedLlmPolicy } {
  const ledger = JSON.parse(readFileSync(join(root, 'defs', 'installed.json'), 'utf8')) as {
    simulation?: boolean; packages?: Array<{ name?: string; units?: string[] }>;
  };
  const pkg = ledger.packages?.[0];
  if (ledger.simulation !== true || ledger.packages?.length !== 1 || !pkg?.name || !/^[a-z0-9][a-z0-9._-]*$/.test(pkg.name)) throw new Error('invalid simulation ledger');
  const target = join(root, 'defs', 'packages', pkg.name);
  const inspected = inspectBundle(target);
  const policies = inspected.units.filter(unit => unit.startsWith('policies:'));
  if (inspected.errors.length || policies.length !== 1 || JSON.stringify(inspected.units) !== JSON.stringify(pkg.units)) throw new Error('simulation requires exactly one valid installed policy');
  const policyPath = resolve(target, policies[0]!.slice('policies:'.length));
  const loaded = loadLlmPolicy({ configDir: root, path: policyPath, legacyConfig: {} });
  if (loaded.errors.length) throw new Error(`installed policy failed to load: ${loaded.errors.join('; ')}`);
  return { root, loaded };
}

/** Install once and exercise the real policy loader against that snapshot. */
export function loadSimulationBundlePolicy(bundle: string): { root: string; loaded: LoadedLlmPolicy } {
  const { root } = installSimulationBundle(bundle);
  return loadInstalledSimulationBundlePolicy(root);
}

/** Run the real judge resolver with installed roles and a mandatory injected transport.
 * This is an isolated simulation entry point, not the production runtime.
 */
export async function judgeSimulationBundle<T = string>(
  bundle: string,
  call: NonNullable<Parameters<typeof judge>[0]['call']>,
  options: { prompt?: string; schema?: (value: unknown) => T | null; signal?: AbortSignal } = {},
) {
  const { root } = installSimulationBundle(bundle);
  return judgeInstalledSimulationBundle(root, call, options);
}

/** Run the real judge against an already-installed simulation snapshot. */
export async function judgeInstalledSimulationBundle<T = string>(
  root: string,
  call: NonNullable<Parameters<typeof judge>[0]['call']>,
  options: { prompt?: string; schema?: (value: unknown) => T | null; signal?: AbortSignal } = {},
) {
  const { loaded } = loadInstalledSimulationBundlePolicy(root);
  const classify = loaded.policy.roles.classify;
  if (!classify?.provider || !classify.model) throw new Error('simulation requires an explicit classify provider and model');
  const config = { roleLlm: loaded.policy.roles } as UserConfig;
  const result = await judge<T>({ site: 'simulation.bundle', prompt: options.prompt ?? 'classify', schema: options.schema, signal: options.signal, config, call });
  return { root, result };
}
