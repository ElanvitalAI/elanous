import { createHash } from 'node:crypto';
import type { Task } from './types.js';

/** The external request content covered by a manual approval. */
export function externalTaskFingerprint(task: Pick<Task, 'title' | 'description'> & {
  attachments?: readonly { url: string }[];
}): string {
  const urls = (task.attachments ?? []).map(({ url }) => url).sort();
  return createHash('sha256').update(JSON.stringify([task.title, task.description, urls])).digest('hex');
}
