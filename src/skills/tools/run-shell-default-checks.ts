/** OP 30-minute check; other seat checks are a separate change. */
export function defaultCheckScript(raw: Record<string, unknown>) {
  if (raw.check !== '30-minute' || raw.checkSeat !== 'OP') throw new Error('unsupported RunShell check');
  if (typeof raw.checkVersion !== 'string' || raw.checkVersion.trim() !== raw.checkVersion || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-dev\.[0-9]+)?$/.test(raw.checkVersion)) throw new Error('invalid release version');
  if (!Number.isSafeInteger(raw.checkPreviousGreen) || (raw.checkPreviousGreen as number) < 0 || (raw.checkPreviousGreen as number) > 9999) throw new Error('previous green count must be an integer from 0 to 9999');
  return [
    { id: 'inbox', command: ['eln', 'msg', 'count', '--to', 'OP', '--json'], select: ['status', 'count'] },
    { id: 'op_check', command: ['eln', 'ops', 'check-30m', '--previous-green', String(raw.checkPreviousGreen), '--expect-version', raw.checkVersion, '--json'],
      select: ['originMainFreshness', 'lastFetchAt', 'fetchStale', 'legacyQueueRows', 'version', 'landings30m', 'landingsWithoutPr30m', 'landingTarget', 'green', 'greenDelta', 'greenDeltaTarget', 'reviewUnclaimed', 'malformedQueueRows', 'unknownQueueRows', 'unclaimedUnknownQueueRows', 'trainTickObserved', 'landingSubObserved', 'complete'] },
    { id: 'cost', command: ['eln', 'usage', 'runs', '--since', '30m', '--by', 'role', '--json'], headLines: 4 },
  ];
}
