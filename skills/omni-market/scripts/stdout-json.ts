/** Write JSON output completely before the process can exit. (Kept inside the skill so the skill runs outside this repository — public pack and lite Pod.) */
export async function writeStdoutJson(text: string): Promise<void> {
  await new Promise<void>((resolve, reject) => process.stdout.write(text, error => error ? reject(error) : resolve()));
}
