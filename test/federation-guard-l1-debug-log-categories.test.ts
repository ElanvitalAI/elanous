// L1 lesson from picker-flicker incident (2026-05-03 · #1401):
// CLAUDE.md rule "if a user says X doesn't work, can I diagnose
// it from log/debug-*.log alone?" was decisive in this RCA. The
// 30 Hz mount/unmount loop was diagnosed end-to-end from a single
// log capture, in <30 minutes, with zero re-instrumentation.
//
// The categories that MADE that possible:
//   - `dashboard.input.visibility` — exposed the owner toggling
//     between 'overlay-input' and 'chat-main' every 30-50ms
//   - `chat.picker.sync` — exposed the ownership-gate skip path
//   - `window.pushModal` / `window.popModal` / `window.closeSurface`
//     — exposed the same surface ID being mounted/unmounted 29 times
//   - `primitive.focus.focused` — would have shown focus state at
//     each transition (relevant for any future focus-related bug)
//
// This guard pins the EXISTENCE of those `debug.log(...)` calls.
// If a future PR removes them (e.g. as part of a "cleanup the debug
// logs" effort), the test fails with an explanation pointing at
// CLAUDE.md and the picker-flicker incident.
//
// Per CLAUDE.md "Debug instrumentation — default on, at every
// critical junction" — this guard is the structural enforcement
// of that policy for the highest-value categories.
//
// REQUIREMENTS ref: 내부 문서 `REQUIREMENTS-substrate-occam-2026-05-03`
//   §5 (federation enforcement)

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { dashboardMatches, dashboardSourceLocations, readDashboardSources } from './helpers/dashboard-source.js';

const ROOT = process.cwd();

interface CategoryRequirement {
  category: string;
  files: readonly string[]; // any of these must contain a debug.log call with this category
  why: string;
}

const REQUIRED: readonly CategoryRequirement[] = [
  {
    category: 'dashboard.input.visibility',
    files: ['src/dashboard/**/*.ts'],
    why: 'exposed the input ownership toggling between overlay-input and chat-main in #1401 picker-flicker RCA',
  },
  {
    category: 'chat.picker.sync',
    files: ['src/chat/index.ts'],
    why: 'exposed the ownership-gate skip path that triggered clearAll() in #1401',
  },
  {
    category: 'window.pushModal',
    files: ['src/display/coordinator.ts'],
    why: 'every modal mount is a routing-junction lifecycle event — required at every push site',
  },
  {
    category: 'window.popModal',
    files: ['src/display/coordinator.ts'],
    why: 'every modal pop is a routing-junction lifecycle event; mount/unmount cycle proof requires both ends',
  },
  {
    category: 'window.closeSurface',
    files: ['src/display/coordinator.ts'],
    why: 'surface dispose path — needed to triage focus restore / region invalidation bugs',
  },
  {
    category: 'primitive.focus.focused',
    files: ['src/display/coordinator.ts'],
    why: 'every focus transition emits this — Pattern E (focus shadow) regression triage anchor',
  },
  {
    category: 'cursor.coordinator.set',
    files: ['src/display/coordinator.ts'],
    why: 'cursor ownership transitions — needed for cursor-related flicker triage',
  },
  {
    category: 'cursor.coordinator.flush',
    files: ['src/display/coordinator.ts'],
    why: 'cursor emit path — pairs with .set for full ownership trace',
  },
  {
    category: 'window.flush.begin',
    files: ['src/display/coordinator.ts'],
    why: 'every coord flush — needed to count flush rate / detect flush loops',
  },
  {
    category: 'key.route',
    files: ['src/display/coordinator.ts'],
    why: 'every key dispatch decision — F1/F2 triage anchor',
  },
];

describe('L1 federation guard · critical debug.log categories must exist', () => {
  for (const req of REQUIRED) {
    test(`debug.log('${req.category}') exists in one of: ${req.files.join(', ')}`, () => {
      // Match `debug.log('<category>'` or `debug.log("<category>"`.
      const escaped = req.category.replace(/\./g, '\\.');
      const pattern = new RegExp(`debug\\.log\\(\\s*['"]${escaped}['"]`);
      let found = false;
      let foundIn: string | null = null;
      for (const rel of req.files) {
        if (rel === 'src/dashboard/**/*.ts') {
          const sources = readDashboardSources();
          const match = dashboardMatches(pattern, sources)[0];
          if (match) {
            found = true;
            foundIn = `${match.path}:${match.line}`;
          } else {
            foundIn = `searched ${dashboardSourceLocations(sources)}`;
          }
        } else {
          const text = readFileSync(join(ROOT, rel), 'utf8');
          const match = pattern.exec(text);
          if (match) {
            found = true;
            foundIn = `${rel}:${text.slice(0, match.index).split('\n').length}`;
          }
        }
        if (found) break;
      }
      if (!found) {
        throw new Error(
          `Required debug.log category '${req.category}' not found in any of: ${req.files.join(', ')} (${foundIn}).\n`
          + `Why this matters: ${req.why}.\n`
          + `Per CLAUDE.md "Debug instrumentation — default on, at every critical junction".\n`
          + `Removing critical instrumentation breaks the "log alone → 30-min RCA" guarantee that #1401 demonstrated.`,
        );
      }
      expect(foundIn, `Required category '${req.category}' at ${foundIn}`).not.toBeNull();
    });
  }
});
