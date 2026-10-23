/** Dashboard integrations used by next TUI, loaded only after that surface is opened. */
export async function loadNextTuiDashboardRuntime() {
  const [segments, goalContinue] = await Promise.all([
    import('../dashboard/turn-start-segments.js'),
    import('../dashboard/input/goal-continue.js'),
  ]);
  return { ...segments, ...goalContinue };
}
