#!/usr/bin/env bun
/** Operator-only highwater provisioning. Runtime modules have no write path. */
import { randomUUID } from 'node:crypto';
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { recipeHighwaterPath, readRecipeHighwater } from '../src/skills/tools/run-shell-recipe-highwater.js';
import { readRecipeTrustAnchor, recipeRevocationStateHash } from '../src/skills/tools/run-shell-recipe-trust.js';

const raw = process.argv[2];
if (process.argv.length !== 3 || !raw || !/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(Number(raw)))
  throw new Error('usage: bun scripts/runshell-recipe-highwater.ts POSITIVE_SAFE_INTEGER_EPOCH');
const epoch = Number(raw);
const RUNSHELL_RECIPE_HIGHWATER_PATH = recipeHighwaterPath();
const parent = dirname(RUNSHELL_RECIPE_HIGHWATER_PATH);
mkdirSync(parent, { recursive: true, mode: 0o700 });
const st = lstatSync(parent);
if (!st.isDirectory() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0)
  throw new Error('unsafe highwater directory');
const lockPath = RUNSHELL_RECIPE_HIGHWATER_PATH + '.lock';
const lock = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
const temporary = join(parent, `.recipe-highwater-${randomUUID()}`);
let madeTemporary = false;
try {
  const trust = readRecipeTrustAnchor();
  if (!trust.ok || trust.anchor.epoch !== epoch) throw new Error('root anchor epoch mismatch or unavailable');
  const current = readRecipeHighwater();
  if (!current.ok && current.reason !== 'missing-highwater') throw new Error(`highwater unavailable: ${current.reason}`);
  if (current.ok && epoch <= current.epoch) throw new Error('epoch must strictly increase');
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  madeTemporary = true;
  try { writeFileSync(fd, JSON.stringify({ schema: 2, epoch, revocationStateSha256: recipeRevocationStateHash(trust.anchor) }) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, RUNSHELL_RECIPE_HIGHWATER_PATH);
  madeTemporary = false;
  const dirFd = openSync(parent, constants.O_RDONLY);
  try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  console.log(`RunShell recipe highwater advanced to ${epoch}`);
} finally {
  if (madeTemporary) unlinkSync(temporary);
  closeSync(lock);
  unlinkSync(lockPath);
}
