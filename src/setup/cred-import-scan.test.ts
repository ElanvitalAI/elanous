import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { scanCredentialImports } from './cred-import-scan.js';

test('fake home scan proposes names, paths and catalog slots without exposing values; only selected values are returned', () => {
  const root = mkdtempSync(join(tmpdir(), 'cred-import-scan-'));
  const home = join(root, 'home');
  const project = join(root, 'project');
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  const envSecret = 'fixture-env-$bang!#literal-never-render';
  const quotedSecret = 'quoted-"-key-$bang!-never-render';
  const singleQuotedSecret = "single-'-key-$literal-never-render";
  const escapedBackslashSecret = 'double-\\n-literal-never-render';
  const configSecret = 'fixture-config-secret-never-render';
  const shellSecret = 'shell-openrouter-secret-never-render';
  const finalShellSecret = 'final-shell-openrouter-secret-never-render';
  const splitShellSecret = 'split-shell-export-secret-never-render';
  const envPath = join(project, '.env');
  const configPath = join(home, '.elanous', 'config.json');
  mkdirSync(join(home, '.elanous'), { recursive: true });
  writeFileSync(envPath, String.raw`# comment
export EODHD_API_KEY=${envSecret}
ELEVENLABS_API_KEY="quoted-\"-key-$bang!-never-render"
TOSSINVEST_CLIENT_ID='single-\'-key-$literal-never-render'
TOSSINVEST_CLIENT_SECRET="double-\\n-literal-never-render"
TOSSINVEST_ACCOUNT_SEQ=fixture-toss-account
TOSSINVEST_BASE_URL=https://api.example.test
FDS_API_KEY=fixture-fds-key
TWELVEDATA_API_KEY=fixture-twelve-key
KRX_API_KEY=fixture-krx-key
KIS_APP_KEY=fixture-kis-app
KIS_APP_SECRET=fixture-kis-secret
KIS_ACCOUNT=fixture-kis-account
UNKNOWN_TOKEN=ignore-this
`);
  writeFileSync(join(home, '.zshrc'), `export OPENROUTER_API_KEY='${shellSecret}'\nexport OPENROUTER_API_KEY='${finalShellSecret}'\n`);
  writeFileSync(join(home, '.bashrc'), `OPENROUTER_API_KEY='${splitShellSecret}'\nexport OPENROUTER_API_KEY\n`);
  writeFileSync(join(home, '.profile'), "export OPENROUTER_API_KEY='revoked-shell-key'\nunset OPENROUTER_API_KEY\nexport OPENROUTER_API_KEY\n");
  writeFileSync(configPath, JSON.stringify({ llm: { provider: 'openai', apiKey: configSecret } }));

  try {
    const scan = scanCredentialImports({ homeDir: home, cwd: project, configPath });
    expect(scan.proposals.map(({ name, sourcePath, slot }) => ({ name, sourcePath, slot }))).toEqual([
      { name: 'EODHD_API_KEY', sourcePath: envPath, slot: 'cred:eodhd.api_key' },
      { name: 'ELEVENLABS_API_KEY', sourcePath: envPath, slot: 'cred:elevenlabs.api_key' },
      { name: 'TOSSINVEST_CLIENT_ID', sourcePath: envPath, slot: 'cred:toss.client_id' },
      { name: 'TOSSINVEST_CLIENT_SECRET', sourcePath: envPath, slot: 'cred:toss.client_secret' },
      { name: 'TOSSINVEST_ACCOUNT_SEQ', sourcePath: envPath, slot: 'cred:toss.account_seq' },
      { name: 'TOSSINVEST_BASE_URL', sourcePath: envPath, slot: 'cred:toss.base_url' },
      { name: 'FDS_API_KEY', sourcePath: envPath, slot: 'cred:fds.api_key' },
      { name: 'TWELVEDATA_API_KEY', sourcePath: envPath, slot: 'cred:twelvedata.api_key' },
      { name: 'KRX_API_KEY', sourcePath: envPath, slot: 'cred:krx.api_key' },
      { name: 'KIS_APP_KEY', sourcePath: envPath, slot: 'cred:kis.app_key' },
      { name: 'KIS_APP_SECRET', sourcePath: envPath, slot: 'cred:kis.app_secret' },
      { name: 'KIS_ACCOUNT', sourcePath: envPath, slot: 'cred:kis.account' },
      { name: 'OPENROUTER_API_KEY', sourcePath: join(home, '.zshrc'), slot: 'cred:openrouter.api_key' },
      { name: 'OPENROUTER_API_KEY', sourcePath: join(home, '.bashrc'), slot: 'cred:openrouter.api_key' },
      { name: 'OPENROUTER_API_KEY', sourcePath: join(home, '.profile'), slot: 'cred:openrouter.api_key' },
      { name: 'llm.apiKey', sourcePath: `${configPath}#llm.apiKey`, slot: 'cred:openai.api_key' },
    ]);
    const proposalMetadata = JSON.stringify(scan.proposals);
    for (const secret of [envSecret, quotedSecret, singleQuotedSecret, escapedBackslashSecret, 'fixture-toss-account',
      'https://api.example.test', 'fixture-fds-key', 'fixture-twelve-key', 'fixture-krx-key', 'fixture-kis-app',
      'fixture-kis-secret', 'fixture-kis-account', configSecret, shellSecret, finalShellSecret, splitShellSecret]) {
      expect(proposalMetadata).not.toContain(secret);
    }
    const [envCandidate, quotedCandidate, singleQuotedCandidate, escapedBackslashCandidate, tossAccountCandidate, tossBaseUrlCandidate,
      fdsCandidate, twelveCandidate, krxCandidate, kisKeyCandidate, kisSecretCandidate, kisAccountCandidate] = scan.proposals;
    const configCandidate = scan.proposals.find(proposal => proposal.sourcePath === `${configPath}#llm.apiKey`)!;
    const shellCandidate = scan.proposals.find(proposal => proposal.sourcePath === join(home, '.zshrc'))!;
    const splitShellCandidate = scan.proposals.find(proposal => proposal.sourcePath === join(home, '.bashrc'))!;
    expect(scan.readSelected([configCandidate!.id])).toEqual({ 'cred:openai.api_key': configSecret });
    expect(scan.readSelected([shellCandidate.id])).toEqual({ 'cred:openrouter.api_key': finalShellSecret });
    expect(scan.readSelected([splitShellCandidate.id])).toEqual({ 'cred:openrouter.api_key': splitShellSecret });
    expect(scan.proposals.filter(proposal => proposal.sourcePath === join(home, '.zshrc'))).toHaveLength(1);
    const profileCandidate = scan.proposals.find(proposal => proposal.sourcePath === join(home, '.profile'))!;
    expect(profileCandidate.reason).toContain('shell syntax mentioning this key is not interpreted');
    expect(() => scan.readSelected([profileCandidate.id])).toThrow('credential import candidate is unresolved');
    expect(scan.readSelected([envCandidate!.id])).toEqual({ 'cred:eodhd.api_key': envSecret });
    expect(scan.readSelected([quotedCandidate.id])).toEqual({ 'cred:elevenlabs.api_key': quotedSecret });
    expect(scan.readSelected([singleQuotedCandidate!.id])).toEqual({ 'cred:toss.client_id': singleQuotedSecret });
    expect(scan.readSelected([escapedBackslashCandidate!.id])).toEqual({ 'cred:toss.client_secret': escapedBackslashSecret });
    expect(scan.readSelected([tossAccountCandidate!.id])).toEqual({ 'cred:toss.account_seq': 'fixture-toss-account' });
    expect(scan.readSelected([tossBaseUrlCandidate!.id])).toEqual({ 'cred:toss.base_url': 'https://api.example.test' });
    expect(scan.readSelected([fdsCandidate!.id])).toEqual({ 'cred:fds.api_key': 'fixture-fds-key' });
    expect(scan.readSelected([twelveCandidate!.id])).toEqual({ 'cred:twelvedata.api_key': 'fixture-twelve-key' });
    expect(scan.readSelected([krxCandidate!.id])).toEqual({ 'cred:krx.api_key': 'fixture-krx-key' });
    expect(scan.readSelected([kisKeyCandidate!.id])).toEqual({ 'cred:kis.app_key': 'fixture-kis-app' });
    expect(scan.readSelected([kisSecretCandidate!.id])).toEqual({ 'cred:kis.app_secret': 'fixture-kis-secret' });
    expect(scan.readSelected([kisAccountCandidate!.id])).toEqual({ 'cred:kis.account': 'fixture-kis-account' });
    expect(() => scan.readSelected([envCandidate!.id, envCandidate!.id])).toThrow('duplicate credential slot selection');
    expect(() => scan.readSelected(['unknown'])).toThrow('unknown credential import selection');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fake home scan omits already-populated slots and config keys for a different provider', () => {
  const root = mkdtempSync(join(tmpdir(), 'cred-import-scan-'));
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const configPath = join(home, 'config.json');
  writeFileSync(join(home, '.env'), 'OPENAI_API_KEY=fixture-openai-secret\nELEVENLABS_API_KEY=fixture-voice-secret\n');
  writeFileSync(configPath, JSON.stringify({ llm: { provider: 'anthropic', apiKey: 'fixture-other-provider-secret' } }));
  try {
    const scan = scanCredentialImports({ homeDir: home, cwd: join(root, 'empty-project'), configPath, existingSlots: ['cred:openai.api_key'] });
    expect(scan.proposals.map(({ name, sourcePath, slot }) => ({ name, sourcePath, slot }))).toEqual([
      { name: 'ELEVENLABS_API_KEY', sourcePath: join(home, '.env'), slot: 'cred:elevenlabs.api_key' },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('OpenRouter dotenv and effective provider config are import candidates for the canonical slot', () => {
  const root = mkdtempSync(join(tmpdir(), 'cred-import-openrouter-'));
  const home = join(root, 'home');
  const project = join(root, 'project');
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  const envSecret = 'dotenv-openrouter-secret';
  const configSecret = 'config-openrouter-secret';
  const envPath = join(project, '.env');
  const configPath = join(home, 'config.json');
  writeFileSync(envPath, `OPENROUTER_API_KEY=${envSecret}\n`);
  writeFileSync(configPath, JSON.stringify({ llm: { provider: 'openrouter', apiKey: configSecret,
    rotation: [{ provider: 'openrouter', apiKey: 'rotation-openrouter-secret' }] } }));
  try {
    const scan = scanCredentialImports({ homeDir: home, cwd: project, configPath, existingSlots: [] });
    expect(scan.proposals.map(({ name, sourcePath, slot }) => ({ name, sourcePath, slot }))).toEqual([
      { name: 'OPENROUTER_API_KEY', sourcePath: envPath, slot: 'cred:openrouter.api_key' },
      { name: 'llm.apiKey', sourcePath: `${configPath}#llm.apiKey`, slot: 'cred:openrouter.api_key' },
      { name: 'llm.rotation[].apiKey', sourcePath: `${configPath}#llm.rotation[0].apiKey`, slot: 'cred:openrouter.api_key' },
    ]);
    expect(scan.readSelected([scan.proposals[0]!.id])).toEqual({ 'cred:openrouter.api_key': envSecret });
    expect(scan.readSelected([scan.proposals[1]!.id])).toEqual({ 'cred:openrouter.api_key': configSecret });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('shell startup scan tracks final exported literals and preserves ambiguous reassignments as non-importable', () => {
  const root = mkdtempSync(join(tmpdir(), 'cred-import-shell-final-'));
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const shellPath = join(home, '.zshrc');
  const scan = () => scanCredentialImports({ homeDir: home, cwd: join(root, 'project'), configPath: join(root, 'missing.json') });
  try {
    writeFileSync(shellPath, 'export OPENROUTER_API_KEY=first-literal\nOPENROUTER_API_KEY=second-literal\n');
    let result = scan();
    const proposal = result.proposals.find(item => item.sourcePath === shellPath);
    expect(proposal).toBeDefined();
    expect(result.readSelected([proposal!.id])).toEqual({ 'cred:openrouter.api_key': 'second-literal' });

    writeFileSync(shellPath, 'export OPENROUTER_API_KEY=first-literal\nOPENROUTER_API_KEY=$LATER_VALUE\n');
    result = scan();
    const dynamicProposal = result.proposals.find(item => item.sourcePath === shellPath);
    expect(dynamicProposal?.reason).toContain('dynamic or compound key assignment');
    expect(() => result.readSelected([dynamicProposal!.id])).toThrow('credential import candidate is unresolved');

    writeFileSync(shellPath, 'export OPENROUTER_API_KEY=first-literal\nOPENROUTER_API_KEY+=suffix\n');
    result = scan();
    const appendProposal = result.proposals.find(item => item.sourcePath === shellPath);
    expect(appendProposal?.reason).toContain('dynamic or compound key assignment');
    expect(() => result.readSelected([appendProposal!.id])).toThrow('credential import candidate is unresolved');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('shell startup scan ignores a changed exported value with shell control syntax', () => {
  const root = mkdtempSync(join(tmpdir(), 'cred-import-shell-control-'));
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const shellPath = join(home, '.profile');
  try {
    writeFileSync(shellPath, 'export OPENROUTER_API_KEY=literal\nOPENROUTER_API_KEY=other; export SECONDARY=value\n');
    const scan = scanCredentialImports({ homeDir: home, cwd: join(root, 'project'), configPath: join(root, 'missing.json') });
    const proposal = scan.proposals.find(item => item.sourcePath === shellPath);
    expect(proposal?.reason).toContain('dynamic or compound key assignment');
    expect(() => scan.readSelected([proposal!.id])).toThrow('credential import candidate is unresolved');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('shell startup scan removes an exported candidate when unset names it after other variables', () => {
  const root = mkdtempSync(join(tmpdir(), 'cred-import-shell-unset-many-'));
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const shellPath = join(home, '.bashrc');
  try {
    writeFileSync(shellPath, 'export OPENROUTER_API_KEY=literal-key\nunset OTHER_VARIABLE OPENROUTER_API_KEY\n');
    const scan = scanCredentialImports({ homeDir: home, cwd: join(root, 'project'), configPath: join(root, 'missing.json') });
    expect(scan.proposals.some(item => item.sourcePath === shellPath)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('shell startup scan preserves a key after function-only unset and harmless echo', () => {
  const root = mkdtempSync(join(tmpdir(), 'cred-import-shell-unset-function-'));
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const shellPath = join(home, '.zshrc');
  try {
    writeFileSync(shellPath, 'export OPENROUTER_API_KEY=literal-key\nunset -f OPENROUTER_API_KEY\necho ready\n');
    const scan = scanCredentialImports({ homeDir: home, cwd: join(root, 'project'), configPath: join(root, 'missing.json') });
    const proposal = scan.proposals.find(item => item.sourcePath === shellPath);
    expect(proposal).toBeDefined();
    expect(scan.readSelected([proposal!.id])).toEqual({ 'cred:openrouter.api_key': 'literal-key' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('shell startup scan preserves and marks an unset line with trailing shell syntax unresolved', () => {
  const root = mkdtempSync(join(tmpdir(), 'cred-import-shell-unset-function-comment-'));
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const shellPath = join(home, '.zshrc');
  try {
    writeFileSync(shellPath, 'export OPENROUTER_API_KEY=literal-key\nunset -f OPENROUTER_API_KEY # function only; variable remains\n');
    const scan = scanCredentialImports({ homeDir: home, cwd: join(root, 'project'), configPath: join(root, 'missing.json') });
    const proposal = scan.proposals.find(item => item.sourcePath === shellPath);
    expect(proposal?.reason).toContain('compound or quoted unset syntax');
    expect(() => scan.readSelected([proposal!.id])).toThrow('credential import candidate is unresolved');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('shell startup scan removes an exported candidate when separate unset flags include variable removal', () => {
  const root = mkdtempSync(join(tmpdir(), 'cred-import-shell-unset-separate-flags-'));
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const shellPath = join(home, '.zshrc');
  try {
    writeFileSync(shellPath, 'export OPENROUTER_API_KEY=literal-key\nunset -f -v OPENROUTER_API_KEY\n');
    const scan = scanCredentialImports({ homeDir: home, cwd: join(root, 'project'), configPath: join(root, 'missing.json') });
    expect(scan.proposals.some(item => item.sourcePath === shellPath)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('shell startup scan preserves a key candidate and marks a compound unset line unresolved', () => {
  const root = mkdtempSync(join(tmpdir(), 'cred-import-shell-unset-compound-'));
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const shellPath = join(home, '.zshrc');
  try {
    writeFileSync(shellPath, "export OPENROUTER_API_KEY=literal-key\nunset -f 'foo # bar'; unset OPENROUTER_API_KEY\n");
    const scan = scanCredentialImports({ homeDir: home, cwd: join(root, 'project'), configPath: join(root, 'missing.json') });
    const proposal = scan.proposals.find(item => item.sourcePath === shellPath);
    expect(proposal?.reason).toContain('compound or quoted unset syntax');
    expect(JSON.stringify(proposal)).not.toContain('literal-key');
    expect(() => scan.readSelected([proposal!.id])).toThrow('credential import candidate is unresolved');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('shell startup scan preserves key candidates as non-importable when control flow is present', () => {
  const root = mkdtempSync(join(tmpdir(), 'cred-import-shell-conditional-'));
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const shellPath = join(home, '.zshrc');
  try {
    writeFileSync(shellPath, 'export OPENROUTER_API_KEY=old-literal\nif true; then OPENROUTER_API_KEY=new-literal; fi\n');
    const scan = scanCredentialImports({ homeDir: home, cwd: join(root, 'project'), configPath: join(root, 'missing.json') });
    const proposal = scan.proposals.find(item => item.sourcePath === shellPath);
    expect(proposal?.reason).toContain('shell control flow is not interpreted');
    expect(() => scan.readSelected([proposal!.id])).toThrow('credential import candidate is unresolved');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('shell startup scan marks an unparsed sourced command as unresolved after a key candidate', () => {
  const root = mkdtempSync(join(tmpdir(), 'cred-import-shell-source-command-'));
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const shellPath = join(home, '.profile');
  try {
    writeFileSync(shellPath, 'export OPENROUTER_API_KEY=literal-key\nsource ~/.profile.local\n');
    const scan = scanCredentialImports({ homeDir: home, cwd: join(root, 'project'), configPath: join(root, 'missing.json') });
    const proposal = scan.proposals.find(item => item.sourcePath === shellPath);
    expect(proposal?.reason).toContain('shell command is not interpreted');
    expect(JSON.stringify(proposal)).not.toContain('literal-key');
    expect(() => scan.readSelected([proposal!.id])).toThrow('credential import candidate is unresolved');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('default dotenv and config sources follow the effective instance root', () => {
  const root = mkdtempSync(join(tmpdir(), 'cred-import-instance-root-'));
  const home = join(root, 'home');
  const project = join(root, 'project');
  const instance = join(root, 'isolated-instance');
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  mkdirSync(instance, { recursive: true });
  writeFileSync(join(instance, '.env'), 'FDS_API_KEY=instance-root-key\n');
  writeFileSync(join(instance, 'config.json'), JSON.stringify({ llm: { provider: 'openai', apiKey: 'instance-root-config-key' } }));
  setElanousConfigDir(instance);
  try {
    const scan = scanCredentialImports({ homeDir: home, cwd: project });
    expect(scan.proposals.map(({ name, sourcePath, slot }) => ({ name, sourcePath, slot }))).toEqual([
      { name: 'FDS_API_KEY', sourcePath: join(instance, '.env'), slot: 'cred:fds.api_key' },
      { name: 'llm.apiKey', sourcePath: `${join(instance, 'config.json')}#llm.apiKey`, slot: 'cred:openai.api_key' },
    ]);
    expect(scan.readSelected([scan.proposals[0]!.id])).toEqual({ 'cred:fds.api_key': 'instance-root-key' });
  } finally {
    resetElanousConfigDir();
    rmSync(root, { recursive: true, force: true });
  }
});
