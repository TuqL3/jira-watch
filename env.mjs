/**
 * Where the settings live. Two sources: the shell startup file (~/.zshrc or
 * ~/.bashrc — see RC_PATHS in jira.mjs) and a .env next to these scripts.
 * Neither depends on any Claude Code plugin, so this runs the same on every
 * machine regardless of what else is installed.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RC_PATHS, loadEnv, settingsFrom } from './jira.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

export const ENV_PATH = process.env.JIRA_WATCH_ENV || join(HERE, '.env');

/** A setting: environment, else an rc file, else .env — the order loadEnv uses. */
const setting = settingsFrom(ENV_PATH);

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
  if (verbose) console.log('token:', RC_PATHS.join(' | '), '· env:', ENV_PATH);
  const lib = await import('./jira.mjs');
  return { ...lib, env: loadEnv(ENV_PATH) };
}
