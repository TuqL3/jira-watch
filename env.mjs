/**
 * Shared plumbing: where the Jira client lives, which .env carries the token,
 * and which custom field holds the assignees.
 *
 * Nothing about a particular Jira instance is hardcoded here — the host comes
 * from the falcon plugin's config, the field id from JIRA_ASSIGNEES_FIELD.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// The Jira client (auth, base URL, fetch wrapper) comes from the falcon plugin
// rather than being duplicated here, so the token lives in one place and
// falcon:jira keeps working. install.sh refuses to run without it.
export const SKILL_DIR = process.env.FALCON_JIRA_DIR
  || join(homedir(), '.claude/plugins/marketplaces/falcon/skills/jira');
export const LIB = join(SKILL_DIR, 'scripts/lib/jira.mjs');

// The falcon skill's .env comes first because falcon:jira reads it too — one
// token in one place serves both. This directory is the fallback.
const ENV_CANDIDATES = [
  join(SKILL_DIR, '.env'),
  join(HERE, '.env'),
];

export function pickEnvPath() {
  for (const p of ENV_CANDIDATES) {
    if (existsSync(p) && /^\s*JIRA_TOKEN\s*=\s*\S/m.test(readFileSync(p, 'utf8'))) return p;
  }
  return ENV_CANDIDATES[0]; // let loadEnv raise MISSING_JIRA_TOKEN with a sane path
}

/** A setting from the environment, else from whichever .env holds the token. */
function setting(name) {
  if (process.env[name]) return process.env[name];
  for (const p of ENV_CANDIDATES) {
    if (!existsSync(p)) continue;
    const m = readFileSync(p, 'utf8').match(new RegExp(`^\\s*${name}\\s*=\\s*(\\S+)`, 'm'));
    if (m) return m[1];
  }
  return '';
}

/**
 * Teams that track assignees in a custom multi-user field instead of Jira's
 * built-in `assignee` set this to that field's id. install.sh detects it and
 * writes it to .env; empty means "not configured yet" and the scripts say so
 * rather than silently watching nothing.
 */
export const ASSIGNEES_FIELD = setting('JIRA_ASSIGNEES_FIELD');

export function requireAssigneesField() {
  if (!ASSIGNEES_FIELD) {
    throw new Error(
      'Thiếu JIRA_ASSIGNEES_FIELD. Chạy lại ./install.sh, hoặc thêm dòng\n'
      + '  JIRA_ASSIGNEES_FIELD=customfield_XXXXX\n'
      + `vào ${pickEnvPath()}`,
    );
  }
  return ASSIGNEES_FIELD;
}

/** Load the falcon jira lib and an env that has a token in it. */
export async function connect({ verbose = false } = {}) {
  if (!existsSync(LIB)) throw new Error(`Cannot find the falcon jira lib at ${LIB} — did the plugin move?`);
  const lib = await import(LIB);
  const envPath = pickEnvPath();
  if (verbose) console.log('env:', envPath);
  return { ...lib, env: lib.loadEnv(envPath) };
}
