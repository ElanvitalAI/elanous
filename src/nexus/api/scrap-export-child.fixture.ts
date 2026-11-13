import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { handleVoiceNoteExport } from './scrap-export.js';

const [instanceRoot, id, vaultRoot, folder, signals] = process.argv.slice(2);
if (!instanceRoot || !id || !vaultRoot || !folder || !signals) throw new Error('missing fixture arguments');
writeFileSync(join(signals, `started-${folder}`), '');

const result = await handleVoiceNoteExport(new Request(`http://nexus.test/v1/scraps/${id}/export`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ vaultId: 'configured', vaultRelativeFolder: folder }),
}), {
  instanceRoot, memberId: 'member-a', id,
  readVaultFile: async () => Response.json({}, { status: 404 }),
  writeVaultFile: async (input) => {
    writeFileSync(join(signals, `entered-${folder}`), '');
    const release = join(signals, `go-${folder}`);
    const deadline = Date.now() + 10_000;
    while (!existsSync(release)) {
      if (Date.now() > deadline) throw new Error('fixture release timeout');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const target = join(vaultRoot, input.path);
    mkdirSync(dirname(target), { recursive: true });
    try { writeFileSync(target, input.content, { flag: 'wx' }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return Response.json({ error: 'file_exists' }, { status: 409 });
      throw error;
    }
    return Response.json({ path: input.path });
  },
});
if (result.status !== 201) throw new Error(`unexpected export status ${result.status}`);
process.stdout.write(String(result.status));
