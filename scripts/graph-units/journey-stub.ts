const stage = process.argv[2] ?? 'unknown';
process.stdout.write(`${JSON.stringify({
  outcome: 'needs-human',
  result: { stage, state: 'stub' },
  evidence: { reason: 'owner unit has not been integrated' },
})}\n`);
