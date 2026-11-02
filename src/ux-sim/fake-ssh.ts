import type { SimClock } from './fake-clock.js';

/** Structural contract of the existing GateTools.ssh injection seam. */
type GateSshTransport = (host: string, script: string, limitMs?: number) => {
  rc: number;
  output: string;
  timedOut?: boolean;
};

interface FakeSshHost {
  /** Fixed observed fixture snapshot; the device does not add sessions or run concurrent connections. */
  activeSessions: number;
  /** Deterministic MaxStartups full threshold; a connection at/above it is refused. */
  maxStartups: number;
  /** MaxSessions threshold for the broker channel simulator. */
  maxSessions?: number;
  /** At/above this session count, inject the configured banner delay/deadline outcome. */
  bannerTimeoutAt?: number;
  /** Virtual banner-exchange delay after the session threshold is reached. */
  bannerDelayMs?: number;
  /** OpenSSH banner deadline; exceeding it returns a protocol timeout. */
  bannerTimeoutMs?: number;
  /** Inject a transport reset only when the remote command is scp. */
  scpDisconnect?: boolean;
}

interface FakeSshCall {
  host: string;
  script: string;
  activeSessions: number | null;
  limitMs?: number;
}

interface FakeSshDevice {
  /** Open a bounded concurrent channel and release it when the returned promise settles. */
  openChannel(host: string, script: string, holdMs?: number): Promise<{ rc: number; output: string }>;
  channelStats(host: string): { active: number; peak: number; refused: number };
  /** Compatible with the existing GateTools.ssh seam; no SSH process or network call is made. */
  ssh: GateSshTransport;
  calls: FakeSshCall[];
}

function validateHost(host: string, config: FakeSshHost): void {
  if (!Number.isInteger(config.activeSessions) || config.activeSessions < 0)
    throw new Error(`fake-ssh ${host}: activeSessions must be a nonnegative integer`);
  if (!Number.isInteger(config.maxStartups) || config.maxStartups < 1)
    throw new Error(`fake-ssh ${host}: maxStartups must be a positive integer`);
  if (config.maxSessions !== undefined && (!Number.isInteger(config.maxSessions) || config.maxSessions < 1))
    throw new Error(`fake-ssh ${host}: maxSessions must be a positive integer`);
  if (config.bannerTimeoutAt !== undefined && (!Number.isInteger(config.bannerTimeoutAt) || config.bannerTimeoutAt < 0))
    throw new Error(`fake-ssh ${host}: bannerTimeoutAt must be a nonnegative integer`);
  if (config.bannerDelayMs !== undefined && (!Number.isFinite(config.bannerDelayMs) || config.bannerDelayMs < 0))
    throw new Error(`fake-ssh ${host}: bannerDelayMs must be a nonnegative finite number`);
  if (config.bannerTimeoutMs !== undefined && (!Number.isFinite(config.bannerTimeoutMs) || config.bannerTimeoutMs <= 0))
    throw new Error(`fake-ssh ${host}: bannerTimeoutMs must be a positive finite number`);
  const hasBannerThreshold = config.bannerTimeoutAt !== undefined;
  if (hasBannerThreshold && (config.bannerDelayMs === undefined || config.bannerTimeoutMs === undefined))
    throw new Error(`fake-ssh ${host}: banner timeout requires delay and deadline`);
  if (!hasBannerThreshold && (config.bannerDelayMs !== undefined || config.bannerTimeoutMs !== undefined))
    throw new Error(`fake-ssh ${host}: banner delay/deadline requires bannerTimeoutAt`);
}

function isScpCommand(script: string): boolean {
  const executable = script.match(/&&\s*(?:\$\([^)]*\)\s*)?'([^']+)'/)?.[1];
  return executable === 'scp' || executable?.endsWith('/scp') === true;
}

/** Host-scoped SSH outcomes for the production GateRunner injection point. */
export function createFakeSsh(input: { hosts: Record<string, FakeSshHost>; clock?: Pick<SimClock, 'now' | 'tick'> }): FakeSshDevice {
  const hosts = new Map<string, FakeSshHost>();
  for (const [host, config] of Object.entries(input.hosts)) {
    validateHost(host, config);
    hosts.set(host, { ...config });
  }
  const calls: FakeSshCall[] = [];
  const channelState = new Map<string, { active: number; peak: number; refused: number }>();
  for (const host of hosts.keys()) channelState.set(host, { active: 0, peak: 0, refused: 0 });
  const ssh: GateSshTransport = (host, script, limitMs) => {
    const config = hosts.get(host);
    calls.push({ host, script, activeSessions: config?.activeSessions ?? null, ...(limitMs === undefined ? {} : { limitMs }) });
    if (!config) return { rc: 255, output: `fake-ssh: unconfigured fake-ssh host: ${host}` };
    if (config.activeSessions >= config.maxStartups)
      return { rc: 255, output: `ssh: MaxStartups refused connection to ${host}` };
    if (config.bannerTimeoutAt !== undefined && config.activeSessions >= config.bannerTimeoutAt) {
      const delayMs = config.bannerDelayMs ?? 0;
      if (delayMs > 0 && !input.clock) throw new Error('fake-ssh banner delay requires the existing fake-clock');
      const startedAt = input.clock?.now();
      const callerDeadlineWins = limitMs !== undefined && limitMs <= delayMs
        && (config.bannerTimeoutMs === undefined || limitMs <= config.bannerTimeoutMs);
      const bannerDeadlineWins = config.bannerTimeoutMs !== undefined && config.bannerTimeoutMs <= delayMs
        && !callerDeadlineWins;
      const elapsedMs = callerDeadlineWins ? limitMs!
        : bannerDeadlineWins ? config.bannerTimeoutMs!
        : delayMs;
      if (elapsedMs > 0) input.clock!.tick(elapsedMs);
      const measuredMs = startedAt === undefined ? elapsedMs : input.clock!.now() - startedAt;
      if (bannerDeadlineWins && measuredMs >= config.bannerTimeoutMs!)
        return { rc: 255, output: `ssh: banner exchange timeout for ${host}` };
      if (callerDeadlineWins && measuredMs >= limitMs!)
        return { rc: 124, output: `ssh: banner exchange timeout for ${host}`, timedOut: true };
    }
    if (config.scpDisconnect && isScpCommand(script))
      return { rc: 255, output: `scp: Connection reset by peer (${host})` };
    return { rc: 0, output: `fake-ssh: connected ${host}` };
  };
  const openChannel: FakeSshDevice['openChannel'] = async (host, script, holdMs = 0) => {
    const config = hosts.get(host);
    const state = channelState.get(host);
    if (!config || !state) return { rc: 255, output: 'fake-ssh: unconfigured fake-ssh host: ' + host };
    const maxSessions = config.maxSessions ?? 10;
    if (config.activeSessions + state.active >= maxSessions) {
      state.refused += 1;
      return { rc: 255, output: 'channel 3: open failed: Session open refused by peer (' + host + ')' };
    }
    state.active += 1;
    state.peak = Math.max(state.peak, state.active);
    calls.push({ host, script, activeSessions: config.activeSessions });
    try {
      if (holdMs > 0) await new Promise(resolve => setTimeout(resolve, holdMs));
      return { rc: 0, output: 'fake-ssh: channel ' + host };
    } finally { state.active -= 1; }
  };
  const channelStats = (host: string) => ({ ...(channelState.get(host) ?? { active: 0, peak: 0, refused: 0 }) });
  return { ssh, calls, openChannel, channelStats };
}
