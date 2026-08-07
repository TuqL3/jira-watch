/**
 * Minimal Jira Data Center client: config, an authenticated fetch, and "who am
 * I". Deliberately self-contained — this used to borrow the falcon plugin's
 * library and broke twice in an hour as that library was reorganised.
 *
 * Jira Cloud is not a target: it authenticates with basic auth against
 * <site>.atlassian.net and speaks REST v3.
 */

import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const TIMEOUT_MS = 30_000;

// The instance this was written for. Override with JIRA_BASE_URL for any other.
const DEFAULT_BASE_URL = 'https://space.avada.net';

/** Parse KEY=VALUE lines. Ignores comments, blank lines and inline `export`. */
export function parseEnvFile(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let value = m[2];
    // Strip one layer of matching quotes; a bare # only starts a comment when
    // it is not inside them.
    if (/^".*"$/.test(value) || /^'.*'$/.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '').trim();
    out[m[1]] = value;
  }
  return out;
}

/**
 * Settings, from the environment first so a one-off run can override the file.
 * Throws rather than guessing: a wrong host or a missing token would otherwise
 * surface much later as a confusing HTTP error.
 */
export function loadEnv(envPath) {
  const fromFile = envPath && existsSync(envPath) ? parseEnvFile(readFileSync(envPath, 'utf8')) : {};
  const token = process.env.JIRA_TOKEN || fromFile.JIRA_TOKEN || '';
  const baseUrl = process.env.JIRA_BASE_URL || fromFile.JIRA_BASE_URL || DEFAULT_BASE_URL;

  if (!token) throw new Error(`MISSING_JIRA_TOKEN — chưa có JIRA_TOKEN trong ${envPath || 'môi trường'}`);

  return { baseUrl: baseUrl.replace(/\/+$/, ''), token };
}

/**
 * One authenticated request. Always resolves with {status, json} so callers
 * branch on the status code instead of catching; only a network failure throws.
 */
export async function jiraFetch(path, { method = 'GET', body, env } = {}) {
  const res = await fetch(env.baseUrl + path, {
    method,
    headers: {
      Authorization: `Bearer ${env.token}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    // fetch has no default timeout; without this a hung server hangs the poll.
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  // 204 and some errors have empty or non-JSON bodies.
  const text = await res.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text.slice(0, 300) };
    }
  }
  return { status: res.status, json };
}

/** My own username — the value Jira uses in assignee and changelog fields. */
export async function fetchMyself(env) {
  const { status, json } = await jiraFetch('/rest/api/2/myself', { env });
  if (status !== 200) throw new Error(`MYSELF_FAILED: HTTP ${status} ${JSON.stringify(json).slice(0, 200)}`);
  if (!json?.name) throw new Error('MYSELF_FAILED: response không có trường name');
  return json.name;
}

// ------------------------------------------------------------------ selftest

function selftest() {
  let failed = 0;
  const nativeAssert = console.assert.bind(console);
  console.assert = (okFlag, msg) => {
    if (!okFlag) failed++;
    nativeAssert(okFlag, msg);
  };
  process.on('exit', () => {
    if (failed) {
      console.error(`selftest FAILED: ${failed} assertion(s)`);
      process.exitCode = 1;
    }
  });

  const e = parseEnvFile([
    '# comment',
    '',
    'JIRA_TOKEN=abc123',
    '  JIRA_BASE_URL = https://jira.example.com  ',
    'export JIRA_ASSIGNEES_FIELD=customfield_1',
    'QUOTED="value with = and # inside"',
    'TRAILING=plain # rác phía sau',
    'lowercase=bỏ qua',
  ].join('\n'));

  console.assert(e.JIRA_TOKEN === 'abc123', 'reads a plain value');
  console.assert(e.JIRA_BASE_URL === 'https://jira.example.com', 'trims space around key and value');
  console.assert(e.JIRA_ASSIGNEES_FIELD === 'customfield_1', 'accepts a leading export');
  console.assert(e.QUOTED === 'value with = and # inside', 'quotes protect = and #');
  console.assert(e.TRAILING === 'plain', 'an unquoted trailing comment is dropped');
  console.assert(!('lowercase' in e), 'lowercase keys are not settings');

  // Missing config must fail loudly here, not as a puzzling HTTP error later.
  const saved = { t: process.env.JIRA_TOKEN, u: process.env.JIRA_BASE_URL };
  delete process.env.JIRA_TOKEN;
  delete process.env.JIRA_BASE_URL;

  const throws = (fn, pattern) => {
    try {
      fn();
      return false;
    } catch (err) {
      return pattern.test(err.message);
    }
  };
  console.assert(throws(() => loadEnv(null), /MISSING_JIRA_TOKEN/), 'no token = MISSING_JIRA_TOKEN');

  process.env.JIRA_TOKEN = 'x';
  console.assert(loadEnv(null).baseUrl === DEFAULT_BASE_URL, 'falls back to the default instance');

  process.env.JIRA_BASE_URL = 'https://jira.example.com///';
  console.assert(loadEnv(null).baseUrl === 'https://jira.example.com', 'an override wins and loses its trailing slashes');

  if (saved.t === undefined) delete process.env.JIRA_TOKEN; else process.env.JIRA_TOKEN = saved.t;
  if (saved.u === undefined) delete process.env.JIRA_BASE_URL; else process.env.JIRA_BASE_URL = saved.u;

  if (!failed) console.log('selftest OK');
}

// Only when this file is what was run — otherwise `watch.mjs --selftest` would
// trigger it a second time just by importing.
const isEntry = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isEntry && process.argv.includes('--selftest')) selftest();
