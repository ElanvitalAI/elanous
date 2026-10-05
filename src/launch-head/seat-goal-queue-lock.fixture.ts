import { writeFileSync } from 'node:fs';
import { Database } from 'bun:sqlite';

const [dbPath, releasedMarker] = process.argv.slice(2);
if (!dbPath || !releasedMarker) throw new Error('lock fixture requires database path and marker');
const db = new Database(dbPath);
try {
  db.exec('BEGIN IMMEDIATE');
  console.log('LOCKED');
  await Bun.sleep(500);
  writeFileSync(releasedMarker, 'released');
  db.exec('COMMIT');
} finally {
  db.close();
}
