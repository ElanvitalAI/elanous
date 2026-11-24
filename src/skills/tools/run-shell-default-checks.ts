/** Read-only seat checks executed through the ordinary RunShell script gate. */
const CHECK_SEATS = new Set(['OP', 'JUD', 'JUD-B', 'REL', 'RES']);

export function defaultCheckScript(raw: Record<string, unknown>) {
  if (!['30-minute', 'landing', 'verdict-receipt'].includes(String(raw.check)) || typeof raw.checkSeat !== 'string' || !CHECK_SEATS.has(raw.checkSeat)) throw new Error('unsupported RunShell check');
  if (typeof raw.checkVersion !== 'string' || raw.checkVersion.trim() !== raw.checkVersion || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-dev\.[0-9]+)?$/.test(raw.checkVersion)) throw new Error('invalid release version');
  if (raw.check !== '30-minute') {
    if (typeof raw.checkCell !== 'string' || !/^[A-Z0-9][A-Z0-9_-]{0,127}$/.test(raw.checkCell)) throw new Error('invalid checklist cell');
    const checklist = { id: 'checklist', command: ['eln', 'release', 'checklist', 'status', '--version', raw.checkVersion, '--json'], select: ['green', 'yellow', 'red', 'done'] };
    const evidence = { id: 'evidence', command: ['eln', 'release', 'checklist', 'evidence', raw.checkCell, '--version', raw.checkVersion, '--json'], projection: 'checklist-evidence' as const };
    return raw.check === 'landing'
      ? [checklist, { id: 'landed', command: ['eln', 'release', 'checklist', 'landed-but-yellow', '--open', '--json'], headLines: 4 }, evidence]
      : [evidence, checklist];
  }
  if (raw.checkCell !== undefined) throw new Error('30-minute check does not take a cell');
  if (raw.checkSeat !== 'OP') return [
    { id: 'inbox', command: ['eln', 'msg', 'count', '--to', raw.checkSeat, '--json'], select: ['status', 'count'] },
    { id: 'ops', command: ['eln', 'ops', 'status', '--json'], headLines: 4 },
    { id: 'checklist', command: ['eln', 'release', 'checklist', 'status', '--version', raw.checkVersion, '--json'], select: ['green', 'yellow', 'red', 'done'] },
    { id: 'landed', command: ['eln', 'release', 'checklist', 'landed-but-yellow', '--open', '--json'], headLines: 4 },
    { id: 'cost', command: ['eln', 'usage', 'runs', '--since', '30m', '--by', 'role', '--json'], headLines: 4 },
  ];
  if (!Number.isSafeInteger(raw.checkPreviousGreen) || (raw.checkPreviousGreen as number) < 0 || (raw.checkPreviousGreen as number) > 9999) throw new Error('previous green count must be an integer from 0 to 9999');
  return [
    { id: 'inbox', command: ['eln', 'msg', 'count', '--to', 'OP', '--json'], select: ['status', 'count'] },
    { id: 'op_check', command: ['eln', 'ops', 'check-30m', '--previous-green', String(raw.checkPreviousGreen), '--expect-version', raw.checkVersion, '--json'],
      select: ['originMainFreshness', 'lastFetchAt', 'fetchStale', 'legacyQueueRows', 'version', 'landings30m', 'landingsWithoutPr30m', 'landingTarget', 'green', 'greenDelta', 'greenDeltaTarget', 'reviewUnclaimed', 'malformedQueueRows', 'unknownQueueRows', 'unclaimedUnknownQueueRows', 'trainTickObserved', 'landingSubObserved', 'complete'] },
    { id: 'cost', command: ['eln', 'usage', 'runs', '--since', '30m', '--by', 'role', '--json'], headLines: 4 },
  ];
}
