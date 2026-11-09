import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

export interface InstallOneLinerFailsafeSimulation {
  pass: boolean;
  gatewayTimeout: {
    curlStatus: number | null;
    commandStatus: number | null;
    httpStatus: string;
    installerStarted: boolean;
    installerInvocationCount: number;
    syntaxCheckCount: number;
    temporaryInstallerRemoved: boolean;
  };
  emptyGatewayError: {
    curlStatus: number | null;
    status: number | null;
    installerStarted: boolean;
    installerInvocationCount: number;
    temporaryInstallerRemoved: boolean;
  };
  partialGatewayTimeout: {
    curlStatus: number | null;
    installerStarted: boolean;
    installerInvocationCount: number;
    temporaryInstallerRemoved: boolean;
  };
  success: {
    curlStatus: number | null;
    status: number | null;
    installerArgs: string[];
    installerInvocationCount: number;
    temporaryInstallerRemoved: boolean;
  };
}

function documentedOneLiner(): string {
  const docs = readFileSync(join(import.meta.dir, '../../release/public/docs/install.md'), 'utf8');
  const block = docs.match(/## One line\s+```bash\n([\s\S]*?)\n```/);
  if (!block?.[1]) throw new Error('release install documentation has no one-line installer block');
  return block[1];
}

function runCase(root: string, mode: '504' | 'empty-504' | 'partial-504' | 'success', command: string) {
  const caseRoot = join(root, mode);
  const bin = join(caseRoot, 'bin');
  const installerPath = join(caseRoot, 'downloaded-install.sh');
  const curlLog = join(caseRoot, 'curl-http-status.txt');
  const httpLog = join(caseRoot, 'http-status.txt');
  const bashLog = join(caseRoot, 'installer-args.txt');
  const bashInvocationLog = join(caseRoot, 'bash-installer-invocations.txt');
  const syntaxCheckLog = join(caseRoot, 'bash-syntax-checks.txt');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'mktemp'), '#!/bin/sh\n: > "$INSTALL_TMP_FILE"\nprintf \'%s\\n\' "$INSTALL_TMP_FILE"\n', { mode: 0o755 });
  writeFileSync(join(bin, 'curl'), [
    '#!/bin/sh',
    'out=""',
    'has_fail=0',
    'while [ "$#" -gt 0 ]; do case "$1" in -*) case "$1" in *f*) has_fail=1 ;; esac ;; esac; if [ "$1" = "-o" ]; then out="$2"; shift 2; else shift; fi; done',
    'if [ "$SIM_MODE" = "504" ] || [ "$SIM_MODE" = "partial-504" ]; then',
    '  if [ "$has_fail" -eq 1 ]; then',
    '    if [ "$SIM_MODE" = "partial-504" ]; then printf \'partial installer bytes\' > "$out"; else : > "$out"; fi',
    '    printf \'504\\n\' > "$SIM_HTTP_LOG"; printf \'22\\n\' > "$SIM_CURL_LOG"; echo "curl: (22) The requested URL returned error: 504" >&2; exit 22',
    '  fi',
    '  printf \'504\\n\' > "$SIM_HTTP_LOG"; printf \'504\\n\' > "$out"; printf \'0\\n\' > "$SIM_CURL_LOG"; exit 0',
    'fi',
    'if [ "$SIM_MODE" = "empty-504" ]; then : > "$out"; printf \'504\\n\' > "$SIM_HTTP_LOG"; printf \'0\\n\' > "$SIM_CURL_LOG"; exit 0; fi',
    'printf \'%s\\n\' \'#!/bin/bash\' \'printf "%s\\n" "$@" > "$SIM_BASH_LOG"\' > "$out"',
    'printf \'200\\n\' > "$SIM_HTTP_LOG"; printf \'0\\n\' > "$SIM_CURL_LOG"',
    'exit 0',
    '',
  ].join('\n'), { mode: 0o755 });
  writeFileSync(join(bin, 'bash'), [
    '#!/bin/sh',
    'if [ "$1" = "-n" ]; then printf \'%s\\n\' "$*" >> "$SIM_BASH_SYNTAX_LOG"; exec /bin/bash "$@"; fi',
    'printf \'%s\\n\' "$*" >> "$SIM_BASH_INVOKE_LOG"',
    'exec /bin/bash "$@"',
    '',
  ].join('\n'), { mode: 0o755 });
  const result = spawnSync('/bin/bash', ['-c', command], {
    cwd: caseRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: caseRoot,
      SIM_MODE: mode,
      SIM_CURL_LOG: curlLog,
      SIM_HTTP_LOG: httpLog,
      SIM_BASH_LOG: bashLog,
      SIM_BASH_INVOKE_LOG: bashInvocationLog,
      SIM_BASH_SYNTAX_LOG: syntaxCheckLog,
      INSTALL_TMP_FILE: installerPath,
    },
  });
  return {
    status: result.status,
    curlStatus: Number(readFileSync(curlLog, 'utf8').trim()),
    httpStatus: readFileSync(httpLog, 'utf8').trim(),
    installerStarted: existsSync(bashLog),
    installerInvocationCount: existsSync(bashInvocationLog) ? readFileSync(bashInvocationLog, 'utf8').trim().split('\n').length : 0,
    syntaxCheckCount: existsSync(syntaxCheckLog) ? readFileSync(syntaxCheckLog, 'utf8').trim().split('\n').length : 0,
    installerArgs: existsSync(bashLog) ? readFileSync(bashLog, 'utf8').trim().split('\n') : [],
    temporaryInstallerRemoved: !existsSync(installerPath),
  };
}

export async function runInstallOneLinerFailsafeSimulation(): Promise<InstallOneLinerFailsafeSimulation> {
  const root = mkdtempSync(join(tmpdir(), 'ux-sim-install-one-liner-'));
  try {
    const command = documentedOneLiner();
    const failed = runCase(root, '504', command);
    const emptyError = runCase(root, 'empty-504', command);
    const partialFailed = runCase(root, 'partial-504', command);
    const success = runCase(root, 'success', command);
    const gatewayTimeout = {
      curlStatus: failed.curlStatus,
      commandStatus: failed.status,
      httpStatus: failed.httpStatus,
      installerStarted: failed.installerStarted,
      installerInvocationCount: failed.installerInvocationCount,
      syntaxCheckCount: failed.syntaxCheckCount,
      temporaryInstallerRemoved: failed.temporaryInstallerRemoved,
    };
    const emptyGatewayError = {
      curlStatus: emptyError.curlStatus,
      status: emptyError.status,
      installerStarted: emptyError.installerStarted,
      installerInvocationCount: emptyError.installerInvocationCount,
      temporaryInstallerRemoved: emptyError.temporaryInstallerRemoved,
    };
    const partialGatewayTimeout = {
      curlStatus: partialFailed.curlStatus,
      installerStarted: partialFailed.installerStarted,
      installerInvocationCount: partialFailed.installerInvocationCount,
      temporaryInstallerRemoved: partialFailed.temporaryInstallerRemoved,
    };
    return {
      pass: failed.curlStatus === 22 && failed.status === 22 && failed.httpStatus === '504' && !failed.installerStarted
        && failed.installerInvocationCount === 0 && failed.temporaryInstallerRemoved
        && emptyError.curlStatus === 0 && emptyError.status !== 0 && !emptyError.installerStarted
        && emptyError.installerInvocationCount === 0 && emptyError.temporaryInstallerRemoved
        && partialFailed.curlStatus === 22 && partialFailed.status === 22 && !partialFailed.installerStarted
        && partialFailed.installerInvocationCount === 0 && partialFailed.temporaryInstallerRemoved
        && success.status === 0 && success.installerArgs.includes('--yes') && success.temporaryInstallerRemoved,
      gatewayTimeout,
      emptyGatewayError,
      partialGatewayTimeout,
      success: { curlStatus: success.curlStatus, status: success.status, installerArgs: success.installerArgs,
        installerInvocationCount: success.installerInvocationCount, temporaryInstallerRemoved: success.temporaryInstallerRemoved },
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
