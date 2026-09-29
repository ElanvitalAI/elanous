import { SQL } from 'bun';
import { readFileSync } from 'node:fs';
import { generateIndexKeyPair, signIndex, verifyIndex } from '../../src/market/signed-index';

type Rows = Record<string, unknown>[];
export interface DbQueries {
  unsafe(query: string, values?: unknown[], options?: { simple: boolean }): Promise<Rows>;
}
export interface DbClient extends DbQueries {
  begin<T>(callback: (tx: DbQueries) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}
export interface DbCheckResult {
  ok: boolean;
  applied: boolean;
  checks: CheckResult[];
}

const migration = readFileSync(new URL('../../services/market/migrations/0001_init.sql', import.meta.url), 'utf8');
const tables = ['publishers', 'plugins', 'versions', 'scan_results', 'entitlements', 'audit_log'];
const rollback = Symbol('rollback probe');

function queryAdapter(queries: Pick<SQL, 'unsafe'>): DbQueries {
  return {
    unsafe: async (query, values, options) => {
      const statement = queries.unsafe(query, values);
      return await (options?.simple ? statement.simple() : statement) as Rows;
    },
  };
}

export function connect(url: string): DbClient {
  const sql = new SQL(url);
  return {
    ...queryAdapter(sql),
    begin: callback => sql.begin(async tx => callback(queryAdapter(tx))),
    close: async () => { await sql.close(); },
  };
}

async function preparePlugin(tx: DbQueries): Promise<string> {
  const [publisher] = await tx.unsafe("insert into publishers (handle, display_name) values ($1, 'DB check') returning id", [`check-${crypto.randomUUID().replaceAll('-', '').slice(0, 32)}`]);
  const [plugin] = await tx.unsafe('insert into plugins (publisher_id, name) values ($1, $2) returning id', [publisher.id, `check-${crypto.randomUUID().replaceAll('-', '').slice(0, 32)}`]);
  return plugin.id as string;
}

async function insertVersion(tx: DbQueries, pluginId: string, version: string, sha256: string, pricingModel = 'free'): Promise<string> {
  const keys = generateIndexKeyPair();
  const indexBytes = Buffer.from(JSON.stringify({
    name: 'check', interface: { displayName: 'Check' }, sequence: 1,
    plugins: [{ name: 'check-plugin', version, source: { source: 'check' },
      artifact: { sha256, bytes: 1, key: 'check-artifact' },
      'ai.elanous': { capabilities: [], connectors: [], pricing: { model: pricingModel } } }],
  }));
  const [row] = await tx.unsafe(`insert into versions
    (plugin_id, version, sha256, bytes, artifact_key, pricing_model, signed_sequence, signed_index_bytes, signed_index_signature)
    values ($1, $2, $3, 1, 'check-artifact', $4, 1, $5, $6::jsonb) returning id`,
    // Bun JSON-encodes a string parameter, so pass the parsed object or jsonb stores a string.
    [pluginId, version, sha256, pricingModel, indexBytes, JSON.parse(signIndex(indexBytes, keys.privateKeyPem, keys.keyId))]);
  return row.id as string;
}

async function rejectionCheck(db: DbClient, name: string, code: string, probe: (tx: DbQueries) => Promise<void>): Promise<CheckResult> {
  try {
    await db.begin(async tx => {
      await probe(tx);
      throw rollback;
    });
    return { name, ok: false, detail: 'probe unexpectedly committed' };
  } catch (error) {
    if (error === rollback) return { name, ok: false, detail: 'invalid statement was accepted' };
    // Bun's Postgres client puts the SQLSTATE in `errno`; `code` is the generic ERR_POSTGRES_SERVER_ERROR.
    const failure = error as { errno?: unknown; code?: unknown };
    const actual = typeof failure?.errno === 'string' && /^[0-9A-Z]{5}$/.test(failure.errno) ? failure.errno : failure?.code;
    return { name, ok: actual === code, detail: actual === code ? `rejected (${code})` : `wrong rejection (${String(actual)}: ${String((error as { message?: unknown })?.message ?? '').slice(0, 120)})` };
  }
}

async function signedIndexCheck(db: DbClient): Promise<CheckResult> {
  const keys = generateIndexKeyPair();
  let verified = false;
  try {
    await db.begin(async tx => {
      const pluginId = await preparePlugin(tx);
      const [plugin] = await tx.unsafe('select name from plugins where id = $1', [pluginId]);
      const marketplaceBytes = Buffer.from(JSON.stringify({
        name: 'check', interface: { displayName: 'Check' }, sequence: 1,
        plugins: [{
          name: plugin.name, version: '1.0.0', source: { source: 'check' },
          artifact: { sha256: 'a'.repeat(64), bytes: 1, key: 'check-artifact' },
          'ai.elanous': { capabilities: [], connectors: [], pricing: { model: 'free' } },
        }],
      }));
      const signature = signIndex(marketplaceBytes, keys.privateKeyPem, keys.keyId);
      const [stored] = await tx.unsafe(`insert into versions
        (plugin_id, version, sha256, bytes, artifact_key, signed_sequence, signed_index_bytes, signed_index_signature)
        values ($1, '1.0.0', $2, 1, 'check-artifact', 1, $3, $4::jsonb)
        returning id`, [pluginId, 'a'.repeat(64), marketplaceBytes, JSON.parse(signature)]);
      const [row] = await tx.unsafe('select version, sha256, bytes, artifact_key, signed_sequence, signed_index_bytes, signed_index_signature from versions where id = $1', [stored.id]);
      const result = verifyIndex({
        marketplaceBytes: row.signed_index_bytes as Uint8Array,
        signatureText: JSON.stringify(row.signed_index_signature),
        trustedKeys: [{ keyId: keys.keyId, publicKey: keys.publicKey }],
      });
      const indexed = result.ok ? result.index.plugins[0] : undefined;
      verified = result.ok && indexed !== undefined && result.sequence === Number(row.signed_sequence)
        && indexed.name === plugin.name && indexed.version === row.version
        && indexed.artifact.sha256 === (row.sha256 as string).trim()
        && indexed.artifact.bytes === Number(row.bytes) && indexed.artifact.key === row.artifact_key;
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) return { name: 'versions:signed_index', ok: false, detail: 'signed index storage or verification failed' };
  }
  return { name: 'versions:signed_index', ok: verified, detail: verified ? 'signature verified' : 'signature not verified' };
}

export async function runDbCheck(db: DbClient): Promise<DbCheckResult> {
  const checks: CheckResult[] = [];
  let applied = false;
  try {
    const [state] = await db.unsafe("select to_regclass('public.schema_migrations') is not null as exists");
    const alreadyApplied = state.exists === true && (await db.unsafe("select version from schema_migrations where version = '0001_init'")).length > 0;
    if (!alreadyApplied) await db.unsafe(migration, [], { simple: true });
    applied = !alreadyApplied;
    const recorded = await db.unsafe("select version from schema_migrations where version = '0001_init'");
    checks.push({ name: 'migration:recorded', ok: recorded.length === 1, detail: recorded.length === 1 ? 'recorded' : 'missing' });

    const found = await db.unsafe("select table_name from information_schema.tables where table_schema = 'public' and table_name in ('publishers', 'plugins', 'versions', 'scan_results', 'entitlements', 'audit_log')");
    const names = new Set(found.map(row => row.table_name));
    for (const table of tables) checks.push({ name: `table:${table}`, ok: names.has(table), detail: names.has(table) ? 'exists' : 'missing' });

    checks.push(await rejectionCheck(db, 'versions:duplicate', '23505', async tx => {
      const pluginId = await preparePlugin(tx);
      await insertVersion(tx, pluginId, '1.0.0', 'a'.repeat(64));
      await insertVersion(tx, pluginId, '1.0.0', 'b'.repeat(64));
    }));
    checks.push(await rejectionCheck(db, 'versions:sha256', '23514', async tx => {
      await insertVersion(tx, await preparePlugin(tx), '1.0.0', 'a'.repeat(63));
    }));
    checks.push(await rejectionCheck(db, 'versions:pricing_model', '23514', async tx => {
      await insertVersion(tx, await preparePlugin(tx), '1.0.0', 'a'.repeat(64), 'paid');
    }));
    checks.push(await signedIndexCheck(db));
    for (const [name, statement] of [
      ['version', "update versions set version = '2.0.0' where id = $1"],
      ['sha256', "update versions set sha256 = repeat('b', 64) where id = $1"],
      ['signature', "update versions set signed_index_signature = '{\"alg\":\"ed25519\"}'::jsonb where id = $1"],
    ]) {
      checks.push(await rejectionCheck(db, `versions:immutable:${name}`, 'P0001', async tx => {
        const id = await insertVersion(tx, await preparePlugin(tx), '1.0.0', 'a'.repeat(64));
        await tx.unsafe(statement, [id]);
      }));
    }
    checks.push(await rejectionCheck(db, 'versions:unsigned', '23502', async tx => {
      await tx.unsafe(`insert into versions (plugin_id, version, sha256, bytes, artifact_key)
        values ($1, 'unsigned-probe', $2, 1, 'check-artifact')`,
        [await preparePlugin(tx), 'a'.repeat(64)]);
    }));
    checks.push(await rejectionCheck(db, 'audit_log:update', 'P0001', async tx => {
      const [entry] = await tx.unsafe("insert into audit_log (actor, action) values ('db-check', 'probe') returning id");
      await tx.unsafe("update audit_log set action = 'mutated' where id = $1", [entry.id]);
    }));
    checks.push(await rejectionCheck(db, 'audit_log:delete', 'P0001', async tx => {
      const [entry] = await tx.unsafe("insert into audit_log (actor, action) values ('db-check', 'probe') returning id");
      await tx.unsafe('delete from audit_log where id = $1', [entry.id]);
    }));
    checks.push(await rejectionCheck(db, 'audit_log:truncate', 'P0001', async tx => {
      await tx.unsafe('truncate audit_log');
    }));
  } catch {
    checks.push({ name: 'migration', ok: false, detail: 'migration or inspection failed' });
  }
  return { ok: checks.length === tables.length + 12 && checks.every(check => check.ok), applied, checks };
}

export async function executeDbCheck(
  url: string,
  connectFn: (url: string) => DbClient = connect,
  output: (line: string) => void = console.log,
): Promise<DbCheckResult> {
  let db: DbClient | undefined;
  let result: DbCheckResult;
  try {
    db = connectFn(url);
    result = await runDbCheck(db);
  } catch {
    result = { ok: false, applied: false, checks: [{ name: 'connection', ok: false, detail: 'connection failed' }] };
  } finally {
    try { await db?.close(); } catch { /* Driver errors can contain credentials. */ }
  }
  output(JSON.stringify(result));
  return result;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const url = args.length === 2 && args[0] === '--url' ? args[1] : undefined;
  if (!url) {
    console.log(JSON.stringify({ ok: false, applied: false, checks: [{ name: 'arguments', ok: false, detail: 'expected --url <postgres URL>' }] }));
    process.exitCode = 1;
  } else {
    const result = await executeDbCheck(url);
    if (!result.ok) process.exitCode = 1;
  }
}
