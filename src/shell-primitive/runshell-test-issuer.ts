// Shared process bootstrap for RunShell tests: the gateway captures this key once.
import { createRunShellApprovalIssuer, RUNSHELL_PUBLIC_KEY_ENV } from '../tui-client/next-runshell-approval.js';
export const testRunShellIssuer = createRunShellApprovalIssuer();
process.env[RUNSHELL_PUBLIC_KEY_ENV] = testRunShellIssuer.publicKey;
