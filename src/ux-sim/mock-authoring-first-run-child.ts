// N08 child: exercise the production first-run boundary without host credentials.
import { readFileSync } from 'node:fs';
import { buildUserConfig } from '../user-config.js';
import { runFirstRun } from '../onboarding/first-run.js';
import { detectProviders, type DetectedProvider } from '../llm/provider-detect.js';
import { resolveProviderCredential } from '../llm/provider-credentials.js';

const [fixturePath, configPath, runId] = process.argv.slice(2);
if (!fixturePath || !configPath || !runId) throw new Error('N08 child requires fixture, config path and runId');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
  detected?: Array<{ provider: string; auth: DetectedProvider['auth'] }>;
};
const lines: string[] = [];
const fixtureDetected: DetectedProvider[] | undefined = fixture.detected?.map((item) => ({
  provider: item.provider, auth: item.auth, available: true, source: 'n08-fixture', rank: 0,
}));
let detectedProviders: string[] | null = null;
const detect = async (): Promise<DetectedProvider[]> => {
  const found = fixtureDetected ?? await detectProviders();
  detectedProviders = found.filter(item => item.available).map(item => item.provider);
  return found;
};
const result = await runFirstRun({ path: configPath, isTTY: false,
  detectProviders: detect, print: line => { lines.push(line); } });
const config = buildUserConfig(configPath);
const credentialSource = config.llm.provider === 'auto' ? 'not-selected'
  : resolveProviderCredential({ provider: config.llm.provider, rotation: config.llm.rotation,
      baseProvider: config.llm.provider, baseApiKey: config.llm.apiKey }).source;
console.log('N08_EVIDENCE=' + JSON.stringify({
  runId, outcome: result.outcome, provider: result.provider ?? null, inputs: result.inputs,
  configReady: config.onboarding.ready === true, credentialSource, lines,
  detectionMode: fixtureDetected === undefined ? 'real' : 'fixture', detectedProviders,
  home: process.env.HOME, stateDir: process.env.ELANOUS_STATE_DIR,
  stateDirSource: process.env.ELANOUS_STATE_DIR_SOURCE,
}));
