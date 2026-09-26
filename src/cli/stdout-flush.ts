// Preserve the intake JSON newline rule while waiting for the stream's write callback.
export async function writeStdoutFully(text: string): Promise<void> {
  await new Promise<void>((resolve) => { process.stdout.write(text.endsWith('\n') ? text : `${text}\n`, () => resolve()); });
}

export async function writeStderrFully(text: string): Promise<void> {
  await new Promise<void>((resolve) => { process.stderr.write(text.endsWith('\n') ? text : `${text}\n`, () => resolve()); });
}
