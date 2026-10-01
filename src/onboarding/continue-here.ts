export interface ContinueHereOptions {
  daemonRunning: boolean;
  /** Resolved PWA URL for the running daemon, if available. */
  pwaUrl?: string;
  /** Already-issued short-lived phone connection link; never pass its token separately. */
  phoneLink?: string;
  telegramEnabled: boolean;
  /** Non-interactive output must not include links (or QR payloads). */
  interactive: boolean;
}

/** Render post-setup directions without inspecting the daemon, issuing credentials, or performing IO. */
export function continueHereLines(opts: ContinueHereOptions): string[] {
  const lines = ['  Continue here:'];
  if (!opts.daemonRunning) lines.push('  Start the daemon: `elanous nexus run`');
  if (opts.interactive && opts.daemonRunning && opts.pwaUrl) {
    lines.push(`  Browser: ${opts.pwaUrl}`);
  } else {
    lines.push('  Browser: `elanous nexus show`');
  }
  if (opts.interactive && opts.daemonRunning && opts.phoneLink) {
    lines.push(`  Phone: ${opts.phoneLink}`);
    lines.push('  ⚠ This link contains a connection token — do not share it or include it in a public screenshot.');
  } else {
    lines.push('  Phone: `elanous phone link --temp --ttl 24h`');
  }
  if (opts.telegramEnabled) lines.push('  Telegram: `elanous telegram`');
  return lines;
}
