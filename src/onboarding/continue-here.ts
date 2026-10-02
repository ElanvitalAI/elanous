export interface ContinueHereOptions {
  daemonRunning: boolean;
  /** Resolved PWA URL for the running daemon, if available. */
  pwaUrl?: string;
  /** Already-issued short-lived phone connection link; never pass its token separately. */
  phoneLink?: string;
  telegramEnabled: boolean;
  /** Tailscale signed in. `host` only when MagicDNS gives a name that serves HTTPS; otherwise the command alone. */
  tailscale?: { host?: string };
  /** Non-interactive output must not include links (or QR payloads). */
  interactive: boolean;
}

/** Render post-setup directions without inspecting the daemon, issuing credentials, or performing IO. */
export function continueHereLines(opts: ContinueHereOptions): string[] {
  const lines = ['  여기서 이어가세요:'];
  if (!opts.daemonRunning) lines.push('  데몬 켜기: `elanous nexus run`');
  if (opts.interactive && opts.daemonRunning && opts.pwaUrl) {
    lines.push(`  브라우저: ${opts.pwaUrl}`);
  } else {
    lines.push('  브라우저: `elanous nexus show`');
  }
  if (opts.interactive && opts.daemonRunning && opts.phoneLink) {
    lines.push(`  폰: ${opts.phoneLink}`);
    lines.push('  ⚠ 이 링크에는 연결 토큰이 들어 있습니다 — 남에게 보내거나 공개 캡처에 넣지 마세요.');
  } else {
    lines.push('  폰: `elanous phone link --temp --ttl 24h`');
  }
  if (opts.telegramEnabled) lines.push('  텔레그램: `elanous telegram`');
  if (opts.tailscale) {
    lines.push(`  어디서든(Tailscale): \`elanous nexus pwa share enable\`${opts.interactive && opts.tailscale.host ? ` → https://${opts.tailscale.host}/app/` : ''}`);
  }
  return lines;
}
