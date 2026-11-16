import { loadPluginManifestFromDir } from '../plugins/core/manifest.js';
import type { InstalledPlugin } from '../plugins/install/plugin-install.js';

/** Names only, for stripping inherited credentials; never opens credential storage.
 * Field-name collisions belong to the owning plugin's credential validation.
 * A collision in an unrelated plugin must not stop another graph. */
export function installedCredentialEnvNames(installed: readonly InstalledPlugin[]): string[] {
  const names = new Set<string>();
  for (const plugin of installed) {
    const { manifest } = loadPluginManifestFromDir(plugin.path, { id: plugin.name });
    for (const connector of manifest.contributes.connectors ?? []) {
      const fields = [
        ...(connector.fields ?? []).map(field => ({ name: field.name, env: field.env })),
        ...(connector.userConfig ?? []).map(field => ({ name: field.key, env: field.env })),
      ];
      for (const field of fields) {
        const env = field.env ?? `ELANOUS_PLUGIN_${plugin.name.replaceAll('-', '_').toUpperCase()}_${field.name.replaceAll('-', '_').toUpperCase()}`;
        // These names are only deleted, never injected; the owner validates its own fields.
        if (typeof env === 'string' && env.length > 0) names.add(env);
      }
    }
  }
  return [...names];
}
