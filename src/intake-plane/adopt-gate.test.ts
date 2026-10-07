import { expect, spyOn, test } from 'bun:test';
import { debug } from '../debug/log.js';
import { intakeCheckReportJson, runIntakeCheck, type IntakeCheckReport } from './check.js';
import { judgeAdoption, shadowAdopt, type AdoptionCandidate } from './adopt-gate.js';

const c: AdoptionCandidate = {
  id: 'c1', grade: 'P1', risk: 1, money: 0, security: 0,
  license: 'MIT', touchesPatentCandidate: false,
};

test('judgeAdoption applies every gate and collects independent reasons', () => {
  expect(judgeAdoption(c, 0)).toEqual({ id: 'c1', adopt: true, reasons: [] });
  expect(judgeAdoption({ ...c, grade: 'P3' }, 0).reasons).toEqual(['grade']);
  expect(judgeAdoption({ ...c, risk: 2 }, 0).reasons).toEqual(['risk']);
  expect(judgeAdoption({ ...c, money: 1 }, 0).reasons).toEqual(['money']);
  expect(judgeAdoption({ ...c, security: 1 }, 0).reasons).toEqual(['security']);
  expect(judgeAdoption({ ...c, license: 'GPL-3.0' }, 0).reasons).toEqual(['license']);
  expect(judgeAdoption({ ...c, license: null }, 0).reasons).toEqual(['license']);
  expect(judgeAdoption({ ...c, touchesPatentCandidate: true }, 0).reasons).toEqual(['patent']);
  expect(judgeAdoption(c, 5).reasons).toEqual(['daily-cap']);
  expect(judgeAdoption({ ...c, grade: 'P4', risk: 3 }, 0).reasons).toEqual(['grade', 'risk']);
  for (const license of ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', 'MPL-2.0']) {
    expect(judgeAdoption({ ...c, license }, 0).adopt).toBe(true);
  }
  expect(judgeAdoption({ ...c, license: 'mit' }, 0).reasons).toEqual(['license']);
  expect(judgeAdoption({ ...c, grade: 'P2' }, 0).adopt).toBe(true);
});

test('shadowAdopt caps accepted candidates at five and logs each verdict', () => {
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    const verdicts = shadowAdopt(Array.from({ length: 7 }, (_, i) => ({ ...c, id: `c${i + 1}` })));
    expect(verdicts.map((verdict) => verdict.adopt)).toEqual([true, true, true, true, true, false, false]);
    expect(verdicts.slice(5).map((verdict) => verdict.reasons)).toEqual([['daily-cap'], ['daily-cap']]);
    expect(log).toHaveBeenCalledTimes(7);
    for (let i = 0; i < 7; i++) {
      expect(log).toHaveBeenNthCalledWith(i + 1, 'intake.adopt', 'shadow-verdict', {
        id: `c${i + 1}`, adopt: verdicts[i]!.adopt, reasons: verdicts[i]!.reasons,
      });
    }
  } finally {
    log.mockRestore();
  }
});

test('shadowAdopt counts only passing verdicts and does not alter candidates', () => {
  const candidates = [{ ...c, id: 'blocked', risk: 2 }, ...Array.from({ length: 6 }, (_, i) => ({ ...c, id: `c${i + 1}` }))];
  const verdicts = shadowAdopt(candidates);
  expect(verdicts.map((verdict) => verdict.adopt)).toEqual([false, true, true, true, true, true, false]);
  expect(verdicts[0]!.reasons).toEqual(['risk']);
  expect(verdicts[6]!.reasons).toEqual(['daily-cap']);
  expect(candidates[0]!.risk).toBe(2);
});

test('check reports and JSON retain their old keys unless adoptShadow is supplied', () => {
  const report = runIntakeCheck([], {
    root: '/tmp', readFile: () => '', commit: () => 'test', log: () => {},
    launchHarness: () => { throw new Error('unexpected harness launch'); },
  }, { ruler: { capabilities: [], surfaces: [], promises: [], failures: [] } });
  expect(Object.keys(report)).toEqual(['mode', 'tree', 'commit', 'items', 'goalDraftPaths', 'harnessLaunches']);
  const oldJson = intakeCheckReportJson(report);
  expect(Object.keys(oldJson)).toEqual(['mode', 'tree', 'commit', 'harnessLaunches', 'items', 'goalDraftPaths']);
  expect(oldJson).not.toHaveProperty('adoptShadow');
  const adoptShadow = shadowAdopt([c]);
  const withShadow: IntakeCheckReport = { ...report, adoptShadow };
  expect(intakeCheckReportJson(withShadow)).toEqual({ ...oldJson, adoptShadow });
  expect(intakeCheckReportJson(withShadow).adoptShadow).toBe(adoptShadow);
  expect(report.goalDraftPaths).toEqual([]);
  expect(report.harnessLaunches).toBe(0);
});
