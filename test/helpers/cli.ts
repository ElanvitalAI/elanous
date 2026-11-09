// Test-facing CLI entry point. Keep direct CLI process launches behind simCli
// so ordinary command contracts run in-process and opt into spawn only when
// they are explicitly testing entrypoint wiring.
export { simCli as runTestCli } from '../../src/ux-sim/in-process-cli.js';
