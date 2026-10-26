import { lstatSync, readFileSync } from 'node:fs';
import { loadPrivateRedactions, privateRedactionsPath } from '../../scripts/public-export.js';
import { defaultSshRunner, type SshRunner } from './parent-host.js';
import { shellQuote } from './task-hand.js';

const ALLOWED_HOSTS = new Set(['node-b', 'elangram-wsl', 'host-e-wsl']);

/** Give a train host the same private list that release export-check reads on HQ.
 * The list travels only over SSH stdin and is installed atomically at mode 0600.
 * A missing or unreadable list is a failed preflight, never a weaker leak check. */
export function provisionExportRedactions(
  host: string,
  sourcePath = privateRedactionsPath(),
  ssh: SshRunner = defaultSshRunner,
): void {
  if (!ALLOWED_HOSTS.has(host)) throw new Error('export redactions host not allowed');
  let payload: string;
  try {
    const stat = lstatSync(sourcePath);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size === 0 || stat.size > 1_048_576) {
      throw new Error('source is not a private regular file');
    }
    if (!loadPrivateRedactions(sourcePath)?.length) throw new Error('source has no redaction entries');
    payload = readFileSync(sourcePath, 'utf8');
    if (payload.includes('\0')) throw new Error('source contains NUL');
  } catch {
    throw new Error('export redactions source unavailable or invalid');
  }

  const code = [
    'const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");',
    // Remote SSH execution has no repository resolver module. Match privateRedactionsPath():
    // ELANOUS_EXPORT_REDACTIONS first, then the remote shell HOME default (OP #40040).
    'const home=process.env.HOME?.trim(),override=process.env.ELANOUS_EXPORT_REDACTIONS?.trim();',
    'const file=override||(home?path.join(home,".elanous","export-redactions.tsv"):"");if(!file||!path.isAbsolute(file))process.exit(2);const dir=path.dirname(file);',
    'const bytes=fs.readFileSync(0);if(!bytes.length||bytes.length>1048576||bytes.includes(0))process.exit(2);',
    'fs.mkdirSync(dir,{recursive:true,mode:0o700});fs.chmodSync(dir,0o700);',
    'const temp=file+"."+process.pid+"."+crypto.randomBytes(6).toString("hex")+".tmp";',
    'try{fs.writeFileSync(temp,bytes,{mode:0o600,flag:"wx"});fs.chmodSync(temp,0o600);fs.renameSync(temp,file)}catch{try{fs.rmSync(temp,{force:true})}catch{};process.exit(3)}',
  ].join('');
  const result = ssh(host, `umask 077; bun -e ${shellQuote(code)}`, 20_000, payload);
  if (result.status !== 0) throw new Error(`export redactions provision failed (ssh rc=${result.status ?? 'unknown'})`);
}
