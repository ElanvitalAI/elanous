const cliUserErrorBrand = Symbol.for('elanous.cli.CliUserError');
const harnessCliInputErrorBrand = Symbol.for('elanous.cli.HarnessCliInputError');

export class CliUserError extends Error {
  constructor(message: string, public readonly hint?: string) {
    super(message);
    this.name = 'CliUserError';
    Object.defineProperty(this, cliUserErrorBrand, { value: true });
  }
}

/** A command-line value was rejected before any harness work began. */
export class HarnessCliInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HarnessCliInputError';
    Object.defineProperty(this, harnessCliInputErrorBrand, { value: true });
  }
}

export function isCliUserError(err: unknown): err is Error & { hint?: string } {
  return err instanceof HarnessCliInputError || err instanceof CliUserError || (
    err instanceof Error && (
      (err.name === 'CliUserError' && Object.getOwnPropertyDescriptor(err, cliUserErrorBrand)?.value === true) ||
      (err.name === 'HarnessCliInputError' && Object.getOwnPropertyDescriptor(err, harnessCliInputErrorBrand)?.value === true)
    )
  );
}

export function formatCliUserError(err: Error & { hint?: string }): string {
  return `❌ ${err.message}${err.hint ? `\n  ↳ ${err.hint}` : ''}`;
}
