import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { debug } from '../../src/debug/log.js';

export interface WarmControlForwardOptions {
  context: string;
  namespace: string;
  service: string;
  remotePort: number;
  kubectl?: string;
  startupTimeoutMs?: number;
}

export interface WarmControlForward {
  url: string;
  stop(): Promise<void>;
}

/** A single-flight startup cache owned by one gate-run lifecycle. A rejected start
 * is shared by that run's shards, while a later run gets a fresh instance and retries. */
export function createRunScopedWarmControlForward(start: () => Promise<WarmControlForward>): {
  ensure(): Promise<WarmControlForward>;
  stop(): Promise<void>;
} {
  let starting: Promise<WarmControlForward> | null = null;
  return {
    ensure() {
      starting ??= start();
      return starting;
    },
    async stop() {
      const pending = starting;
      starting = null;
      const forward = pending ? await pending.catch(() => null) : null;
      if (forward) await forward.stop();
    },
  };
}

type ForwardExit = { code: number | null; signal: NodeJS.Signals | null };

function exitWithin(exited: Promise<ForwardExit>, timeoutMs: number): Promise<ForwardExit | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([exited, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); })])
    .finally(() => { if (timer) clearTimeout(timer); });
}

function ephemeralLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('warm control forward could not reserve a loopback port'));
        return;
      }
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

function cleanKubectlEnv(): NodeJS.ProcessEnv {
  // Port-forward carries control credentials and task payloads; never route the tunnel through ambient proxies.
  const env = { ...process.env };
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) delete env[key];
  return env;
}

/** Start a run-owned, loopback-only tunnel. No remote interface is ever bound. */
async function startWarmControlPortForwardAt(options: WarmControlForwardOptions, localPort: number): Promise<WarmControlForward> {
  const child = spawn(options.kubectl ?? 'kubectl', [
    '--context', options.context, '-n', options.namespace, 'port-forward',
    '--address', '127.0.0.1', `service/${options.service}`, `${localPort}:${options.remotePort}`,
  ], { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: cleanKubectlEnv() });
  let stdout = '';
  let stderr = '';
  let stopRequested = false;
  let failStartup: ((error: Error) => void) | undefined;
  const startedAt = Date.now();
  const stopGroup = (signal: NodeJS.Signals) => {
    if (child.pid) {
      try { process.kill(-child.pid, signal); } catch { child.kill(signal); }
    } else child.kill(signal);
  };
  const exited = new Promise<ForwardExit>(resolve => {
    child.once('close', (code, signal) => resolve({ code, signal }));
    child.once('error', () => resolve({ code: null, signal: null }));
  });
  child.stderr?.on('data', chunk => {
    stderr = `${stderr}${String(chunk)}`.slice(-8192);
    if (/address already in use/i.test(stderr)) failStartup?.(new Error('warm control local port was claimed before kubectl bound it'));
  });

  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => finish(new Error('warm control port-forward startup timed out')), options.startupTimeoutMs ?? 15_000);
      const ready = (chunk: Buffer | string) => {
        if (new RegExp(`Forwarding from 127\\.0\\.0\\.1:${localPort} -> ${options.remotePort}`).test(stdout)) finish();
      };
      const capture = (chunk: Buffer | string) => { stdout = `${stdout}${String(chunk)}`.slice(-8192); };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        failStartup = undefined;
        clearTimeout(timer);
        child.stdout?.off('data', ready);
        if (error) reject(error); else resolve();
      };
      failStartup = finish;
      child.stdout?.on('data', capture);
      child.stdout?.on('data', ready);
      void exited.then(({ code, signal }) => finish(new Error(`warm control port-forward exited before ready (code=${code}, signal=${signal})`)));
      child.once('error', error => finish(error));
    });
  } catch (error) {
    stopRequested = true;
    if (child.exitCode === null && child.signalCode === null) stopGroup('SIGTERM');
    let final = await exitWithin(exited, 2_000);
    if (final === null) {
      stopGroup('SIGKILL');
      final = await exitWithin(exited, 2_000);
    }
    debug.log('pod.warm.control-forward', 'start-failed', { context: options.context, namespace: options.namespace,
      service: options.service, localPort, elapsedMs: Date.now() - startedAt,
      reason: error instanceof Error ? error.message : String(error), stderr: stderr.slice(-1000), orphaned: final === null },
    { level: final === null ? 'error' : 'warn' });
    if (final === null) debug.log('pod.warm.control-forward', 'orphan-detected', { context: options.context,
      namespace: options.namespace, service: options.service, localHost: '127.0.0.1', localPort }, { level: 'error' });
    throw error;
  }
  void exited.then(result => {
    if (!stopRequested) debug.log('pod.warm.control-forward', 'exited-unexpectedly', {
      context: options.context, namespace: options.namespace, service: options.service,
      localHost: '127.0.0.1', localPort, exitCode: result.code, exitSignal: result.signal,
    }, { level: 'error' });
  });
  debug.log('pod.warm.control-forward', 'started', { context: options.context, namespace: options.namespace,
    service: options.service, localHost: '127.0.0.1', localPort, remotePort: options.remotePort });

  return {
    url: `http://127.0.0.1:${localPort}/`,
    async stop() {
      if (stopRequested) return;
      stopRequested = true;
      if (child.exitCode === null && child.signalCode === null) stopGroup('SIGTERM');
      const result = await exitWithin(exited, 2_000);
      if (result === null) stopGroup('SIGKILL');
      const final = result ?? await exitWithin(exited, 2_000);
      const orphaned = final === null;
      debug.log('pod.warm.control-forward', orphaned ? 'orphan-detected' : 'stopped', {
        context: options.context, namespace: options.namespace, service: options.service,
        localHost: '127.0.0.1', localPort, remotePort: options.remotePort,
        elapsedMs: Date.now() - startedAt, exitCode: final?.code ?? null, exitSignal: final?.signal ?? null,
      }, { level: orphaned ? 'error' : 'info' });
      if (orphaned) throw new Error('warm control port-forward process survived gate cleanup');
    },
  };
}

export async function startWarmControlPortForward(options: WarmControlForwardOptions): Promise<WarmControlForward> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(options.context)
    || !/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(options.namespace)
    || !/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(options.service)
    || !Number.isSafeInteger(options.remotePort) || options.remotePort < 1 || options.remotePort > 65535)
    throw new Error('invalid warm control forward target');
  for (let attempt = 0; attempt < 2; attempt++) {
    const localPort = await ephemeralLoopbackPort();
    try { return await startWarmControlPortForwardAt(options, localPort); }
    catch (error) {
      if (attempt === 0 && error instanceof Error && /local port was claimed/i.test(error.message)) continue;
      throw error;
    }
  }
  throw new Error('warm control port-forward could not claim a loopback port');
}
