import type { UserConfig } from '../../user-config/types.js';

/** The public distribution repository must never become an implicit implementation destination. */
export function taskAgentPodRepoOptions(config: Pick<UserConfig, 'taskAgent'>): { repoUrl: string } {
  const raw = config.taskAgent?.repoUrl;
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('TA repoUrl required: set taskAgent.repoUrl to the private implementation repository');
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new Error('TA repoUrl invalid: use an explicit GitHub HTTPS repository'); }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com' || url.port || url.username || url.password || url.search || url.hash)
    throw new Error('TA repoUrl invalid: use an explicit GitHub HTTPS repository');
  const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.pathname);
  if (!match || match[1] === '.' || match[1] === '..' || match[2] === '.' || match[2] === '..')
    throw new Error('TA repoUrl invalid: use an explicit GitHub HTTPS repository');
  const repository = `${match[1]}/${match[2]}`;
  if (repository.toLowerCase() === 'elanvitalai/elanous') throw new Error('TA repoUrl refused: public distribution repository is not an implementation destination');
  return { repoUrl: `https://github.com/${repository}` };
}
