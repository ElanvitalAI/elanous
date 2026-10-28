import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface TuiRegressFailureEvidence {
  runId: string;
  event: string;
  verificationCommand: string;
  artifactRoot: string;
  configDir: string;
  check: { id: string; title: string; role: string };
  screens: Record<string, string>;
  pty: { cols: number; rows: number; bootMs: number };
  environment: {
    driveTui: string;
    nodeEnv: string | null;
    credentialVariablesPresent: string[];
  };
  verdict: { ok: boolean; reason: string };
}

function redactConfig(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactConfig);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      key,
      /api.?key|token|secret|password|credential/i.test(key) ? '[REDACTED]' : redactConfig(child),
    ]));
  }
  return value;
}

export function preserveTuiRegressFailure(input: TuiRegressFailureEvidence): string {
  mkdirSync(input.artifactRoot, { recursive: true });
  const artifactDir = mkdtempSync(join(input.artifactRoot, `${input.check.id}-`));
  const screensDir = join(artifactDir, 'screens');
  mkdirSync(screensDir);
  for (const [name, screen] of Object.entries(input.screens)) writeFileSync(join(screensDir, `${name}.txt`), screen);

  const configPath = join(input.configDir, 'config.json');
  let effectiveConfig: unknown = { unavailable: !existsSync(configPath) };
  if (existsSync(configPath)) {
    try { effectiveConfig = redactConfig(JSON.parse(readFileSync(configPath, 'utf8'))); }
    catch (error) { effectiveConfig = { parseError: String(error), bytes: readFileSync(configPath).byteLength }; }
  }
  writeFileSync(join(artifactDir, 'effective-config.json'), `${JSON.stringify(effectiveConfig, null, 2)}\n`);
  writeFileSync(join(artifactDir, 'run.json'), `${JSON.stringify({
    runId: input.runId,
    event: input.event,
    verificationCommand: input.verificationCommand,
    check: input.check,
    pty: input.pty,
    environment: input.environment,
    verdict: input.verdict,
  }, null, 2)}\n`);
  return artifactDir;
}
