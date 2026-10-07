#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import { inspectAskMarkers } from '../ask-marker-check.js';

export interface AuthoringMeasurement {
  readonly path: string;
  readonly chars: number;
  readonly bytes: number;
  readonly sections: number;
  readonly markerAxes: number;
  readonly markerFailed: number;
}

type UnreadableMeasurement = { readonly path: string; readonly error: 'unreadable' };
type AuthoringRow = AuthoringMeasurement | UnreadableMeasurement;

export function measureAuthoring(path: string, text: string): AuthoringMeasurement {
  const axes = inspectAskMarkers(text);
  return {
    path,
    chars: text.length,
    bytes: Buffer.byteLength(text, 'utf8'),
    sections: text.split(/\r?\n/).filter((line) => /^#{1,6}\s/u.test(line)).length,
    markerAxes: axes.length,
    markerFailed: axes.filter((axis) => !(axis.marker && axis.extracted)).length,
  };
}

export function median(numbers: readonly number[]): number | null {
  if (numbers.length === 0) return null;
  const sorted = [...numbers].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function main(argv: readonly string[]): number {
  const json = argv.includes('--json');
  const paths = argv.filter((argument) => argument !== '--json');
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const rows: AuthoringRow[] = paths.map((path) => {
    let text: string;
    try {
      text = decoder.decode(readFileSync(path));
    } catch {
      return { path, error: 'unreadable' };
    }
    return measureAuthoring(path, text);
  });
  const measured = rows.filter((row): row is AuthoringMeasurement => !('error' in row));
  const summary = {
    files: measured.length,
    medianChars: median(measured.map((row) => row.chars)),
    medianBytes: median(measured.map((row) => row.bytes)),
  };

  if (json) {
    for (const row of rows) console.log(JSON.stringify(row));
    console.log(JSON.stringify(summary));
  } else {
    console.log('path\tchars\tbytes\tsections\tmarkerAxes\tmarkerFailed\terror');
    for (const row of rows) {
      console.log('error' in row
        ? `${row.path}\t\t\t\t\t\t${row.error}`
        : `${row.path}\t${row.chars}\t${row.bytes}\t${row.sections}\t${row.markerAxes}\t${row.markerFailed}\t`);
    }
    console.log(`files\t${summary.files}\tmedianChars\t${summary.medianChars ?? '—'}\tmedianBytes\t${summary.medianBytes ?? '—'}`);
  }
  return rows.some((row) => 'error' in row) ? 1 : 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
