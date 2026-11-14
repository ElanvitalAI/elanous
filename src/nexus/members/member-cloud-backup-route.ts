/** Lazily binds the E2E ciphertext API to the authenticated member store. */
import { join } from 'node:path';
import { nexusRootDir } from '../paths.js';
import type { MemberStore } from './member-store.js';
import { createMemberCloudBackupApi } from './cloud-backup-e2e.js';

export function createMemberCloudBackupRoute(options: {
  memberStore: Pick<MemberStore, 'memberForSession'>;
  dbPath?: string;
  now?: () => Date;
}) {
  let api: ReturnType<typeof createMemberCloudBackupApi> | undefined;
  const prefix = '/v1/members/secret-backups';
  return {
    handle(request: Request): Promise<Response | undefined> | undefined {
      const path = new URL(request.url).pathname;
      if (path !== prefix && !path.startsWith(`${prefix}/`)) return undefined;
      api ??= createMemberCloudBackupApi({
        dbPath: options.dbPath ?? join(nexusRootDir(), 'members', 'cloud-backups.sqlite'),
        memberStore: options.memberStore,
        ...(options.now ? { now: options.now } : {}),
      });
      return api.handle(request);
    },
    close(): void { api?.close(); api = undefined; },
  };
}
