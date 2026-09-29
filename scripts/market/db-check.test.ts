import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { executeDbCheck, type DbClient, type DbQueries } from './db-check';

const migration = readFileSync(new URL('../../services/market/migrations/0001_init.sql', import.meta.url), 'utf8');
const tableNames = ['publishers', 'plugins', 'versions', 'scan_results', 'entitlements', 'audit_log'];

function fakeClient(options: { reject?: boolean; leak?: string; appliedQueries?: string[]; corruptSignedBytes?: boolean } = {}): DbClient {
  let migrated = false;
  let entries = 0;
  let signedRow: Record<string, unknown> | undefined;
  const query: DbQueries['unsafe'] = async (sql, values) => {
    if (sql.includes('to_regclass')) return [{ exists: migrated }];
    if (sql.includes('select version from schema_migrations')) return migrated ? [{ version: '0001_init' }] : [];
    if (sql.startsWith('-- M0')) { migrated = true; options.appliedQueries?.push(sql); return []; }
    if (sql.includes('information_schema.tables')) return tableNames.map(table_name => ({ table_name }));
    if (sql.includes('insert into publishers')) return [{ id: 'publisher-id' }];
    if (sql.includes('insert into plugins')) return [{ id: 'plugin-id' }];
    if (sql.includes('select name from plugins')) return [{ name: 'check-plugin' }];
    if (sql.includes('insert into audit_log')) return [{ id: ++entries }];
    if (options.reject && sql.includes("'unsigned-probe'")) {
      throw Object.assign(new Error(options.leak ?? 'signature required'), { code: '23502' });
    }
    if (sql.includes('insert into versions') && sql.includes('signed_index_bytes') && sql.includes('returning id') && values?.length === 4) {
      signedRow = {
        version: '1.0.0', sha256: 'a'.repeat(64), bytes: 1, artifact_key: 'check-artifact', signed_sequence: 1,
        signed_index_bytes: options.corruptSignedBytes ? Buffer.from('tampered') : values?.[2],
        signed_index_signature: typeof values?.[3] === 'string' ? JSON.parse(values[3] as string) : values?.[3],
      };
      return [{ id: 'signed-version-id' }];
    }
    if (sql.includes('signed_sequence, signed_index_bytes, signed_index_signature from versions')) return signedRow ? [signedRow] : [];
    if (sql.includes('insert into versions')) {
      if (options.reject) {
        const code = values?.[2] === 'a'.repeat(63) || values?.[3] === 'paid' ? '23514' :
          values?.[1] === '1.0.0' && values?.[2] === 'b'.repeat(64) ? '23505' : undefined;
        if (code) throw Object.assign(new Error(options.leak ?? 'rejected'), { code });
      }
      return [{ id: 'version-id' }];
    }
    if (options.reject && /update versions set (?:version|sha256|signed_index_signature)/.test(sql)) {
      throw Object.assign(new Error(options.leak ?? 'immutable'), { code: 'P0001' });
    }
    if (options.reject && /(?:update audit_log|delete from audit_log|truncate audit_log)/.test(sql)) {
      throw Object.assign(new Error(options.leak ?? 'append-only'), { code: 'P0001' });
    }
    return [];
  };
  return {
    unsafe: query,
    begin: async callback => callback({ unsafe: query }),
    close: async () => {},
  };
}

describe('market M0 migration', () => {
  test('declares exactly the six M0 tables, constraints, indexes and audit trigger', () => {
    const names = [...migration.matchAll(/create table if not exists\s+(\w+)/gi)].map(match => match[1]);
    expect(names.sort()).toEqual([...tableNames, 'schema_migrations'].sort());
    expect(names).not.toContain('orders');
    expect(names).not.toContain('payouts');
    expect(names).not.toContain('reviews');
    expect(migration).toMatch(/unique\s*\(plugin_id,\s*version\)/i);
    expect(migration).toMatch(/pricing_model\s+text\s+not null default 'free' check\s*\(pricing_model in \('free','one-time','subscription'\)\)/i);
    expect(migration).toMatch(/before update or delete on audit_log/i);
    expect(migration).toMatch(/after truncate on audit_log\s+for each statement execute function reject_audit_log_mutation\(\)/i);
    expect(migration).toMatch(/signed_sequence bigint not null/i);
    expect(migration).toMatch(/signed_index_bytes bytea not null/i);
    expect(migration).toMatch(/signed_index_signature jsonb not null/i);
    expect(migration).toMatch(/signed_index_signature->>'alg' = 'ed25519'/i);
    expect(migration).toMatch(/signed_index_signature->>'keyId'\) ~ '\^\[0-9a-fA-F\]\{8\}\$'/i);
    expect(migration).toMatch(/signed_index_signature->>'sig'\) ~ '\^\(\[A-Za-z0-9\+\/\]\{4\}\)\{21\}\[A-Za-z0-9\+\/\]\{2\}==\$'/i);
    expect(migration).toMatch(/\) is true\),\s*published_at timestamptz not null default now\(\)/i);
    expect(migration).not.toMatch(/signed_sequence is null and signed_index_bytes is null/i);
    expect(migration).toMatch(/raise exception 'audit_log is append-only/i);
    expect(migration).toMatch(/before update or delete on versions\s+for each row execute function reject_published_version_mutation\(\)/i);
    expect(migration).toMatch(/to_jsonb\(new\) - 'yanked_at'\) is distinct from \(to_jsonb\(old\) - 'yanked_at'/i);
    expect(migration).toMatch(/raise exception 'published versions are immutable except first yank'/i);
    expect(migration).toMatch(/after truncate on versions\s+for each statement execute function reject_published_version_mutation\(\)/i);
    expect(migration).toMatch(/versions\s*\(plugin_id, published_at desc\)/i);
    expect(migration).toMatch(/entitlements\s*\(subject\)/i);
    expect(migration).toMatch(/audit_log\s*\(at\)/i);
    expect(migration).toMatch(/^begin;/m);
    expect(migration).toMatch(/commit;\s*$/);
    expect(migration).toMatch(/create extension if not exists pgcrypto/i);
    expect(migration).toMatch(/insert into schema_migrations \(version\)/i);
    expect(migration).toMatch(/sha256 char\(64\) not null check \(sha256 ~ '\^\[0-9a-f\]\{64\}\$'\)/i);
    expect(migration).toMatch(/kind text not null check \(kind in \('free','granted','purchased'\)\)/i);
    expect(migration).toMatch(/on delete cascade/i);
    expect(migration).toMatch(/unique \(plugin_id, subject, kind\)/i);
    expect(migration).toMatch(/check \(bytes > 0\)/i);
  });

  test('applies and inspects twice without printing a password-bearing URL', async () => {
    const secretUrl = 'postgres://some-user:super-secret@127.0.0.1:55432/postgres';
    const output: string[] = [];
    const appliedQueries: string[] = [];
    const db = fakeClient({ reject: true, leak: secretUrl, appliedQueries });
    const first = await executeDbCheck(secretUrl, () => db, line => output.push(line));
    const second = await executeDbCheck(secretUrl, () => db, line => output.push(line));
    expect(first.ok).toBe(true);
    expect(first.applied).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.applied).toBe(false);
    expect(appliedQueries).toEqual([migration]);
    expect(first.checks.map(check => check.name)).toEqual([
      'migration:recorded',
      ...tableNames.map(table => `table:${table}`),
      'versions:duplicate', 'versions:sha256', 'versions:pricing_model', 'versions:signed_index',
      'versions:immutable:version', 'versions:immutable:sha256', 'versions:immutable:signature', 'versions:unsigned',
      'audit_log:update', 'audit_log:delete', 'audit_log:truncate',
    ]);
    expect(output).toHaveLength(2);
    for (const line of output) {
      expect(JSON.parse(line).ok).toBe(true);
      expect(line).not.toContain(secretUrl);
      expect(line).not.toContain('super-secret');
    }
  });

  test('stored signature cannot verify altered index bytes', async () => {
    const result = await executeDbCheck('postgres://local:secret@localhost/db', () => fakeClient({ reject: true, corruptSignedBytes: true }), () => {});
    expect(result.ok).toBe(false);
    expect(result.checks.find(check => check.name === 'versions:signed_index')?.ok).toBe(false);
  });

  test('connection and close errors never leak credentials', async () => {
    const secretUrl = 'postgres://user:private-password@localhost/db';
    const lines: string[] = [];
    const result = await executeDbCheck(secretUrl, () => {
      throw new Error(`could not connect to ${secretUrl}`);
    }, line => lines.push(line));
    expect(result.ok).toBe(false);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('private-password');
    expect(JSON.parse(lines[0]).checks[0].name).toBe('connection');

    const closeLines: string[] = [];
    const db = fakeClient({ reject: true });
    db.close = async () => { throw new Error(secretUrl); };
    const closed = await executeDbCheck(secretUrl, () => db, line => closeLines.push(line));
    expect(closed.ok).toBe(true);
    expect(closeLines).toHaveLength(1);
    expect(closeLines[0]).not.toContain('private-password');
  });

  test('accepted invalid statements fail the check rather than pass', async () => {
    const lines: string[] = [];
    const result = await executeDbCheck('postgres://user:secret@localhost/db', () => fakeClient(), line => lines.push(line));
    expect(result.ok).toBe(false);
    expect(result.checks.filter(check => !check.ok).map(check => check.name)).toEqual([
      'versions:duplicate', 'versions:sha256', 'versions:pricing_model',
      'versions:immutable:version', 'versions:immutable:sha256', 'versions:immutable:signature', 'versions:unsigned',
      'audit_log:update', 'audit_log:delete', 'audit_log:truncate',
    ]);
    expect(lines[0]).not.toContain('secret');
  });
});

const testUrl = process.env.ELANOUS_MARKET_TEST_DB_URL;
if (testUrl) {
  test('local Postgres: migration, constraint rejections and second application', async () => {
    const { connect, runDbCheck } = await import('./db-check');
    const db = connect(testUrl);
    try {
      const first = await runDbCheck(db);
      const second = await runDbCheck(db);
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      expect(second.applied).toBe(false);
    } finally {
      await db.close();
    }
  });
} else {
  test.skip('local Postgres SKIPPED: ELANOUS_MARKET_TEST_DB_URL not set', () => {});
}
