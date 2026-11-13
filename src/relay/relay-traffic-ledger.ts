import { closeSync } from 'node:fs';
import { join } from 'node:path';
import { getElanousConfigDir } from '../elanous-config-dir.js';
import { openPrivateDatabase } from './app-kill-switch.js';
import type { RelayTrafficStore, RelayTrafficUsage } from './relay-server.js';

export interface RelayTrafficLedger extends RelayTrafficStore {
  monthUsage(memberId: string, year: number, month: number): RelayTrafficUsage;
  connectionUsage(memberId: string, connectionId: string, minute: number): RelayTrafficUsage;
  close(): void;
}

/** Private per-member byte totals. Values are wire bytes, not provider-billed egress. */
export function createRelayTrafficLedger(
  databasePath = join(getElanousConfigDir(), 'relay', 'traffic-usage.sqlite'),
  stateRoot = getElanousConfigDir(),
): RelayTrafficLedger {
  const opened = openPrivateDatabase(databasePath, stateRoot);
  const { db } = opened;
  try {
    db.exec('PRAGMA busy_timeout = 3000');
    db.exec(`CREATE TABLE IF NOT EXISTS relay_traffic_minute (
      member_id TEXT NOT NULL,
      minute INTEGER NOT NULL,
      ingress_bytes INTEGER NOT NULL DEFAULT 0 CHECK (ingress_bytes >= 0),
      egress_bytes INTEGER NOT NULL DEFAULT 0 CHECK (egress_bytes >= 0),
      PRIMARY KEY (member_id, minute)
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS relay_traffic_connection_minute (
      member_id TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      minute INTEGER NOT NULL,
      ingress_bytes INTEGER NOT NULL DEFAULT 0 CHECK (ingress_bytes >= 0),
      egress_bytes INTEGER NOT NULL DEFAULT 0 CHECK (egress_bytes >= 0),
      PRIMARY KEY (member_id, connection_id, minute)
    )`);
  } catch (error) {
    db.close(); closeSync(opened.descriptor); closeSync(opened.parentDescriptor); throw error;
  }
  const read = db.query('SELECT ingress_bytes AS ingressBytes, egress_bytes AS egressBytes FROM relay_traffic_minute WHERE member_id = ? AND minute = ?');
  const recordIngress = db.query(`INSERT INTO relay_traffic_minute (member_id, minute, ingress_bytes, egress_bytes)
    VALUES (?, ?, ?, 0) ON CONFLICT (member_id, minute) DO UPDATE SET ingress_bytes = ingress_bytes + excluded.ingress_bytes`);
  const recordEgress = db.query(`INSERT INTO relay_traffic_minute (member_id, minute, ingress_bytes, egress_bytes)
    VALUES (?, ?, 0, ?) ON CONFLICT (member_id, minute) DO UPDATE SET egress_bytes = egress_bytes + excluded.egress_bytes`);
  const connection = db.query(`SELECT ingress_bytes AS ingressBytes, egress_bytes AS egressBytes
    FROM relay_traffic_connection_minute WHERE member_id = ? AND connection_id = ? AND minute = ?`);
  const recordConnectionIngress = db.query(`INSERT INTO relay_traffic_connection_minute
    (member_id, connection_id, minute, ingress_bytes, egress_bytes) VALUES (?, ?, ?, ?, 0)
    ON CONFLICT (member_id, connection_id, minute) DO UPDATE SET ingress_bytes = ingress_bytes + excluded.ingress_bytes`);
  const recordConnectionEgress = db.query(`INSERT INTO relay_traffic_connection_minute
    (member_id, connection_id, minute, ingress_bytes, egress_bytes) VALUES (?, ?, ?, 0, ?)
    ON CONFLICT (member_id, connection_id, minute) DO UPDATE SET egress_bytes = egress_bytes + excluded.egress_bytes`);
  const month = db.query(`SELECT COALESCE(SUM(ingress_bytes), 0) AS ingressBytes,
    COALESCE(SUM(egress_bytes), 0) AS egressBytes FROM relay_traffic_minute
    WHERE member_id = ? AND minute >= ? AND minute < ?`);
  let closed = false;
  return {
    read(memberId, minute) {
      if (closed) throw new Error('relay traffic ledger closed');
      const row = read.get(memberId, minute) as { ingressBytes: number; egressBytes: number } | null;
      return row ?? { ingressBytes: 0, egressBytes: 0 };
    },
    charge(event, memberLimit) {
      if (closed) throw new Error('relay traffic ledger closed');
      if ((memberLimit !== undefined && (!Number.isSafeInteger(memberLimit) || memberLimit <= 0))
        || !event.connectionId || event.connectionId.length > 128
        || !Number.isSafeInteger(event.bytes) || event.bytes < 0
        || !Number.isSafeInteger(event.minute) || !['ingress', 'egress'].includes(event.direction)) {
        throw new Error('invalid relay traffic charge');
      }
      db.exec('BEGIN IMMEDIATE');
      try {
        const row = read.get(event.memberId, event.minute) as { ingressBytes: number; egressBytes: number } | null;
        const usage = row ?? { ingressBytes: 0, egressBytes: 0 };
        if (![usage.ingressBytes, usage.egressBytes].every(bytes => Number.isSafeInteger(bytes) && bytes >= 0)) {
          throw new Error('invalid relay traffic ledger total');
        }
        if (memberLimit !== undefined && usage.ingressBytes + usage.egressBytes + event.bytes > memberLimit) {
          db.exec('COMMIT');
          return { status: 'limited' as const, usage };
        }
        if (event.direction === 'ingress') recordIngress.run(event.memberId, event.minute, event.bytes);
        else recordEgress.run(event.memberId, event.minute, event.bytes);
        if (event.direction === 'ingress') recordConnectionIngress.run(event.memberId, event.connectionId, event.minute, event.bytes);
        else recordConnectionEgress.run(event.memberId, event.connectionId, event.minute, event.bytes);
        db.exec('COMMIT');
        return { status: 'allowed' as const, usage: {
          ingressBytes: usage.ingressBytes + (event.direction === 'ingress' ? event.bytes : 0),
          egressBytes: usage.egressBytes + (event.direction === 'egress' ? event.bytes : 0),
        } };
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch { /* BEGIN or COMMIT already ended the transaction */ }
        throw error;
      }
    },
    monthUsage(memberId, year, monthNumber) {
      if (closed) throw new Error('relay traffic ledger closed');
      if (!Number.isInteger(year) || year < 1970 || !Number.isInteger(monthNumber) || monthNumber < 1 || monthNumber > 12) {
        throw new Error('invalid relay traffic month');
      }
      const firstMinute = Date.UTC(year, monthNumber - 1, 1) / 60_000;
      const endMinute = Date.UTC(year, monthNumber, 1) / 60_000;
      const row = month.get(memberId, firstMinute, endMinute) as { ingressBytes: number; egressBytes: number };
      return { minute: firstMinute, ingressBytes: row.ingressBytes, egressBytes: row.egressBytes };
    },
    connectionUsage(memberId, connectionId, minute) {
      if (closed) throw new Error('relay traffic ledger closed');
      const row = connection.get(memberId, connectionId, minute) as { ingressBytes: number; egressBytes: number } | null;
      return { minute, ingressBytes: row?.ingressBytes ?? 0, egressBytes: row?.egressBytes ?? 0 };
    },
    close() {
      if (closed) return;
      closed = true;
      db.close();
      closeSync(opened.descriptor);
      closeSync(opened.parentDescriptor);
    },
  };
}
