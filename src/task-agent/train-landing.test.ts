import { describe, expect, test } from 'bun:test';
import { trainLedgerComponent, verifiedTrainLanding } from './train-landing.js';

const SHA = 'a'.repeat(40);
const HEADER = 'time\ttrain\tintegrationPr\tmergeSha\tcomponentPrs\tsideHost\tresult';
const ROW = `2026-10-15T20:30\tc2\t27986\t${SHA.slice(0, 12)}\t27890,27725\tminih\tmerged`;

describe('TA train landing proof', () => {
  test('exact duplicate ledger rows are idempotent; conflicting rows are unmeasured', () => {
    expect(trainLedgerComponent(`${HEADER}\n${ROW}\n${ROW}`, 27890)).toMatchObject({ integrationPr: 27986, componentPr: 27890 });
    expect(trainLedgerComponent(`${HEADER}\n${ROW}\n${ROW.replace('27986', '28000')}`, 27890)).toBeNull();
    expect(trainLedgerComponent(`${HEADER}\n${ROW}\n${ROW.replace('\tc2\t', '\tc3\t')}`, 27890)).toBeNull();
    expect(trainLedgerComponent(`${HEADER}\n${ROW}\n${ROW.replace('\tmerged', '\tfailed')}`, 27890)).toBeNull();
    expect(trainLedgerComponent(`${HEADER}\n${ROW}`, 12345)).toBeNull();
  });

  test('merged integration PR must match ledger SHA prefix', () => {
    const opts = { ledgerText: `${HEADER}\n${ROW}`, trainPrView: () => ({ state: 'MERGED', mergeSha: SHA }) };
    expect(verifiedTrainLanding(27725, '/repo', opts)).toEqual({ componentPr: 27725, integrationPr: 27986, mergeSha: SHA, train: 'c2' });
    expect(verifiedTrainLanding(27725, '/repo', { ...opts, trainPrView: () => ({ state: 'OPEN', mergeSha: SHA }) })).toBeNull();
    expect(verifiedTrainLanding(27725, '/repo', { ...opts, trainPrView: () => ({ state: 'MERGED', mergeSha: 'b'.repeat(40) }) })).toBeNull();
  });
});
