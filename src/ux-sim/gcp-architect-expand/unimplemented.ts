

export function runUnavailableStep(): void {
console.log(JSON.stringify({ outcome: 'fail', error: 'gcp-architect-expand is a design skeleton; real GCP adapter is unavailable' }));
}
if (import.meta.main) runUnavailableStep();
