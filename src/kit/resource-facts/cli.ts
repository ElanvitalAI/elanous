// CLI faces of RESOURCE-FACTS:
//   eln world facts get <key> [--json]      one fact (ops scripts read this instead of a literal)
//   eln world facts ls [--json]             every fact ⊕ sources ⊕ warnings («default used» shows what the guardian still owes)
//   eln route host <purpose> [--exclude a,b] [--need-cpu n] [--list] [--json]   (a paid VM only once approved in the registry)
//                                           one host chosen from the registry (role ⊕ health ⊕ load/ncpu ⊕ leases)
// Exit codes: 0 = answered · 1 = no host / unknown key · 2 = usage.
import type { Command } from 'commander';

export function registerFactsSubcommands(world: Command): void {
  const facts = world.command('facts').description('Resource facts (hosts · roles · accounts · caps · review routing · expiries) from the world registry ⊕ policy file');
  facts.command('get <key>').description('One fact by key (hosts.<purpose> · host.<name> · review.primary · caps.<name> · expiry.<name>[.epoch] · accounts.<provider> · retryHosts)')
    .option('--json').action(async (key: string, o: { json?: boolean }) => {
      const { resourceFacts } = await import('./facts.js'); const g = await import('./get.js');
      const v = g.factGet(resourceFacts(), key);
      if (v === undefined) { console.error(`world facts get: unknown key ${key} (${g.FACT_KEYS_HELP})`); process.exitCode = 1; return; }
      console.log(o.json ? JSON.stringify(v) : g.formatFact(v));
    });
  facts.command('ls').description('Every fact with its source and the fallback warnings').option('--json')
    .action(async (o: { json?: boolean }) => {
      const { resourceFacts, policyPath } = await import('./facts.js'); const r = await import('./route.js');
      const f = resourceFacts();
      if (o.json) { console.log(JSON.stringify(f)); return; }
      console.log(`sources: ${f.sources.join(' ⊕ ') || '-'} · policy ${policyPath()}`);
      for (const w of f.warnings) console.log(`⚠ ${w}`);
      for (const h of f.hosts) console.log(`  ${h.host.padEnd(14)} ${h.health.padEnd(9)} roles ${h.roles.join(',') || '-'}${h.paid ? ` · paid${h.paidApproved ? ' approved' : ''}` : ''}${h.hq ? ' · HQ' : ''} · ${h.source}${h.note ? ` · ${h.note}` : ''}`);
      for (const p of r.ROUTE_PURPOSES) console.log(`  route ${p.padEnd(15)} ${r.hostsFor(p, { facts: f }).join(' ') || '(none)'}`);
      console.log(`  review ${f.review.primary} → ${f.review.fallback ?? '-'} after ${f.review.fallbackAfterFailures} · forbidden ${f.review.forbidden.join(',')}`);
      console.log(`  caps ${Object.entries(f.caps).map(([k, v]) => `${k}=${v}`).join(' · ')}`);
      console.log(`  expiries ${Object.entries(f.expiries).map(([k, v]) => `${k}=${v}`).join(' · ') || '-'} · retryHosts ${f.retryHosts.join(' ')}`);
    });
}

export function registerRouteCommands(program: Command): void {
  const route = program.command('route').description('Route work to resources from the world registry (no fixed lists)');
  route.command('host <purpose>').description('Pick one host for pregate · full-gate · tsc · test-run · ta-launch · hand-placement · review · burst')
    .option('--exclude <hosts>', 'comma-separated hosts to skip').option('--need-cpu <n>', 'minimum free cores')
    .option('--list', 'print every eligible host (no probe)').option('--json')
    .action(async (purpose: string, o: { exclude?: string; needCpu?: string; list?: boolean; json?: boolean }) => {
      const r = await import('./route.js');
      if (!r.isRoutePurpose(purpose)) { console.error(`route host: unknown purpose ${purpose} (${r.ROUTE_PURPOSES.join(' · ')})`); process.exitCode = 2; return; }
      const exclude = (o.exclude ?? '').split(',').map(s => s.trim()).filter(Boolean);
      if (o.list) {
        const l = r.hostsFor(purpose, { exclude });
        console.log(o.json ? JSON.stringify(l) : l.join(' '));
        if (!l.length) process.exitCode = 1;
        return;
      }
      const needCpu = o.needCpu !== undefined ? Number(o.needCpu) : undefined;
      if (needCpu !== undefined && !Number.isFinite(needCpu)) { console.error('route host: --need-cpu must be a number'); process.exitCode = 2; return; }
      const res = r.pickHost(purpose, { exclude, ...(needCpu !== undefined ? { needCpu } : {}) });
      if (o.json) console.log(JSON.stringify(res));
      else { if (res.host) console.log(res.host); console.error(`route ${purpose}: ${res.why}`); }
      if (!res.host) process.exitCode = 1;
    });
}
