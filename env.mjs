/**
 * Where the settings live. Everything is read from a .env next to these
 * scripts — no dependency on any Claude Code plugin, so this runs the same on
 * every machine regardless of what else is installed.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEnv } from './jira.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

export const ENV_PATH = process.env.JIRA_WATCH_ENV || join(HERE, '.env');

/** A setting from the environment first, else from .env. */
function setting(name) {
  if (process.env[name]) return process.env[name];
  if (!existsSync(ENV_PATH)) return '';
  const m = readFileSync(ENV_PATH, 'utf8').match(new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(\\S+)`, 'm'));
  return m ? m[1] : '';
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
      + `vào ${ENV_PATH}`,
    );
  }
  return ASSIGNEES_FIELD;
}

/** The Jira client plus the resolved settings. */
export async function connect({ verbose = false } = {}) {
  if (verbose) console.log('env:', ENV_PATH);
  const lib = await import('./jira.mjs');
  return { ...lib, env: loadEnv(ENV_PATH) };
}
