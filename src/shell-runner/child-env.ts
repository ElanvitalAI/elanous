/** Shell tool children inherit only ordinary runtime settings. Explicit non-secret overrides are allowed. */
const INHERITED = /^(?:PATH|HOME|USER|LOGNAME|SHELL|LANG|LC_[A-Za-z0-9_]+|TERM|COLORTERM|TMPDIR|TMP|TEMP|TZ|PWD|EDITOR|VISUAL|ELANOUS_STATE_DIR|ELANOUS_CONFIG_DIR|ELANOUS_SEAT|ELANOUS_TRACK|ELANOUS_SESSION_ROOT)$/;
const SECRET = /KEY|TOKEN|SECRET|PASS|AUTH|CRED|OAUTH|API/i;

export function shellChildEnv(parent: NodeJS.ProcessEnv, explicit: Record<string, string> = {}): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(parent)) {
    if (value !== undefined && INHERITED.test(key) && !SECRET.test(key)) result[key] = value;
  }
  for (const [key, value] of Object.entries(explicit)) {
    if (!SECRET.test(key)) result[key] = value;
  }
  return result;
}
