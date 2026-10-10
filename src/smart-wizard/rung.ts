// The condition extraction (including any LLM judgment) happens before this deterministic selector.
export type WizardRung = 'a' | 'b' | 'c' | 'd' | 'e';
export type GraphValueSignal = 'verification' | 'rework' | 'approval' | 'branching' | 'resume' | 'parallel' | 'resolution';

export type RungConditions = {
  capabilityGaps: number;
  graphSignals: readonly GraphValueSignal[];
  recurring: boolean;
  needsMemory: boolean;
  unattended: boolean;
  roles: number;
  differentCadences: boolean;
  differentPermissions: boolean;
  handoffs: number;
};

export type RungDecision = {
  rung: WizardRung;
  reasons: string[];
  rejectedHigher: string[];
};

const graphSignalNames: readonly GraphValueSignal[] = [
  'verification', 'rework', 'approval', 'branching', 'resume', 'parallel', 'resolution',
];
const rungOrder: readonly WizardRung[] = ['a', 'b', 'c', 'd', 'e'];

/** Select the lowest rung sufficient for the supplied, already-established conditions. */
export function classifyRung(conditions: RungConditions): RungDecision {
  const { capabilityGaps, graphSignals, recurring, needsMemory, unattended, roles,
    differentCadences, differentPermissions, handoffs } = conditions;
  for (const [name, value] of Object.entries({ capabilityGaps, roles, handoffs })) {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  if (graphSignals.some(signal => !graphSignalNames.includes(signal))) {
    throw new TypeError('graphSignals contains an unknown signal');
  }

  const distinctSignals = graphSignalNames.filter(signal => graphSignals.includes(signal));
  const graphWorthwhile = distinctSignals.length >= 2;
  const loopNeeded = recurring && (needsMemory || unattended);
  const collectiveNeeded = roles >= 2 && (differentCadences || differentPermissions) && handoffs >= 1;
  let rung: WizardRung = 'a';
  const reasons: string[] = [];
  if (capabilityGaps > 0) {
    rung = 'b';
    reasons.push(`b: capability gaps ${capabilityGaps} > 0`);
  }
  if (graphWorthwhile) {
    rung = 'c';
    reasons.push(`c: ${distinctSignals.length} graph value signals >= 2 (${distinctSignals.join(', ')})`);
  }
  if (loopNeeded) {
    rung = 'd';
    reasons.push(`d: recurring and ${[needsMemory && 'needs memory', unattended && 'unattended'].filter(Boolean).join(' / ')}`);
  }
  if (collectiveNeeded) {
    rung = 'e';
    reasons.push(`e: ${roles} roles >= 2, ${[differentCadences && 'different cadences', differentPermissions && 'different permissions'].filter(Boolean).join(' / ')}, handoffs ${handoffs} >= 1`);
  }
  if (reasons.length === 0) reasons.push('a: no higher-rung condition met; one skill call or short chain suffices');

  const rejected = {
    b: `b: capability gaps ${capabilityGaps} = 0`,
    c: `c: ${distinctSignals.length} distinct graph value signals < 2`,
    d: `d: ${!recurring ? 'not recurring' : 'neither memory nor unattended execution'}`,
    e: `e: ${[
      roles < 2 && `roles ${roles} < 2`,
      !differentCadences && !differentPermissions && 'neither different cadences nor different permissions',
      handoffs < 1 && `handoffs ${handoffs} < 1`,
    ].filter(Boolean).join('; ')}`,
  };
  return { rung, reasons, rejectedHigher: rungOrder.slice(rungOrder.indexOf(rung) + 1).map(higher => rejected[higher as keyof typeof rejected]) };
}
