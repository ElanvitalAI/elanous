const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_ENV_FILE_BYTES = 1024 * 1024;

export function parseSecretEnvFile(contents: string): Record<string, string> {
  if (Buffer.byteLength(contents, 'utf8') > MAX_ENV_FILE_BYTES) throw new Error('environment file is too large');
  const result: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^export\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) throw new Error('unsupported API-key export syntax');
    const [, name, rawValue] = match;
    if (Object.hasOwn(result, name)) throw new Error('duplicate environment variable name');
    let value: string;
    if (rawValue.startsWith("'") && rawValue.endsWith("'") && rawValue.length >= 2) {
      value = rawValue.slice(1, -1);
      if (value.includes("'") || /[\r\n\0]/.test(value)) throw new Error('unsupported API-key export syntax');
    } else if (rawValue.startsWith('"') && rawValue.endsWith('"') && rawValue.length >= 2) {
      value = rawValue.slice(1, -1);
      if (/[\\$`"\r\n\0]/.test(value)) throw new Error('unsupported API-key export syntax');
    } else {
      value = rawValue;
      if (!value || /[\s'"\\$`;|&<>()[\]{}*?!~\r\n\0]/.test(value)) throw new Error('unsupported API-key export syntax');
    }
    if (!value || value.includes('\0')) throw new Error('unsupported API-key export syntax');
    result[name] = value;
  }
  return result;
}

export function renderSecretEnvExports(secrets: Readonly<Record<string, string>>, requestedNames: readonly string[]): string {
  if (!requestedNames.length) throw new Error('at least one environment variable name is required');
  const seen = new Set<string>();
  for (const name of requestedNames) {
    if (!ENV_NAME.test(name)) throw new Error('invalid environment variable name');
    if (seen.has(name)) throw new Error('duplicate environment variable name');
    seen.add(name);
  }
  const missing = requestedNames.filter((name) => !Object.hasOwn(secrets, name));
  if (missing.length) throw new Error(`missing secrets: ${missing.join(', ')}`);
  return requestedNames.map((name) => `export ${name}='${secrets[name].replace(/'/g, "'\\''")}'\n`).join('');
}
