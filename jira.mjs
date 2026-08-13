/**
 * Minimal Jira Data Center client: config, an authenticated fetch, and "who am
 * I". Deliberately self-contained — this used to borrow the falcon plugin's
 * library and broke twice in an hour as that library was reorganised.
 *
 * Jira Cloud is not a target: it authenticates with basic auth against
 * <site>.atlassian.net and speaks REST v3.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const TIMEOUT_MS = 30_000;

// The instance this was written for. Override with JIRA_BASE_URL for any other.
const DEFAULT_BASE_URL = 'https://space.avada.net';

/**
 * Shell startup files that may hold the token, best match first. The token goes
 * in one of these because it is a file every machine already has and everyone
 * knows how to edit — a new device needs one line pasted in, an expired token
 * needs that line changed, with no hidden file to discover first.
 *
 * Every candidate is read, not just the current shell's: launchd starts
 * watch.mjs with no SHELL set, so the shell can only be a hint about which file
 * to prefer, never a filter. The order settles ties — one token in .zshrc and
 * another in .bashrc has to resolve the same way on every run.
 *
 * They are read as files, never inherited from the environment: launchd starts
 * no login shell, so nothing these files export ever reaches the watcher. A
 * consequence: only literal values work. `export JIRA_TOKEN=$(security ...)`
 * is stored verbatim, never run.
 */
const rc = (name) => join(homedir(), name);
const USES_BASH = /bash$/.test(process.env.SHELL || '');

export const RC_PATHS = process.env.JIRA_WATCH_RC
  ? [process.env.JIRA_WATCH_RC]
  : USES_BASH
    ? [rc('.bashrc'), rc('.bash_profile'), rc('.zshrc')]
    : [rc('.zshrc'), rc('.bashrc'), rc('.bash_profile')];

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
 * One lookup across every source, in order: the environment (so a one-off run
 * can override everything), then the shell startup files, then .env last.
 *
 * .env comes last on purpose. It is where installs older than the move kept the
 * token, and a freshly pasted one must not sit behind an expired one nobody
 * remembers writing.
 */
export function settingsFrom(envPath, rcPaths = RC_PATHS) {
  const read = (p) => (p && existsSync(p) ? parseEnvFile(readFileSync(p, 'utf8')) : {});
  const sources = [...rcPaths, envPath].map(read);
  return (name) => process.env[name] || sources.map((s) => s[name]).find(Boolean) || '';
}

/**
 * Settings. Throws rather than guessing: a wrong host or a missing token would
 * otherwise surface much later as a confusing HTTP error.
 */
export function loadEnv(envPath, rcPaths = RC_PATHS) {
  const get = settingsFrom(envPath, rcPaths);

  const token = get('JIRA_TOKEN');
  const baseUrl = get('JIRA_BASE_URL') || DEFAULT_BASE_URL;

  if (!token) throw new Error(`MISSING_JIRA_TOKEN — chưa có JIRA_TOKEN trong ${rcPaths[0] || envPath || 'môi trường'}`);

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

/**
 * Is Jira itself serving? /status is the instance's own health endpoint: it
 * ignores credentials, so it still answers when the token is dead — which is
 * the only time this gets asked. It answers `{"state":"RUNNING"}` when Jira is
 * up, and the CDN in front returns its own 5xx when it is not.
 *
 * A 401 alone says nothing about the token. Something sick between here and
 * Jira rejects requests just as flatly as an expired token does, and no new
 * token would fix that. This is what separates the two.
 */
export async function jiraIsUp(env) {
  try {
    const { status, json } = await jiraFetch('/status', { env });
    return status === 200 && json?.state === 'RUNNING';
  } catch {
    return false; // unreachable is an outage, never an expiry
  }
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
  // Every call below passes both paths explicitly — with the defaults, whatever
  // the person running this has in their own ~/.zshrc would decide the result.
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
  console.assert(throws(() => loadEnv(null, []), /MISSING_JIRA_TOKEN/), 'no token = MISSING_JIRA_TOKEN');

  // Where the token comes from, in order. The rc line is the one a human just
  // typed; an old .env token must not shadow it. And with a token in two rc
  // files, the earlier one has to win every time — a resolution order that
  // depends on the day would be worse than either answer.
  const dir = mkdtempSync(join(tmpdir(), 'jira-watch-'));
  const zshrc = join(dir, 'zshrc');
  const bashrc = join(dir, 'bashrc');
  const absent = join(dir, 'absent');
  const dotenv = join(dir, 'env');
  writeFileSync(zshrc, '# my shell\nexport PATH="$HOME/bin:$PATH"\nexport JIRA_TOKEN=from-zsh\n');
  writeFileSync(bashrc, 'export JIRA_TOKEN=from-bash\n');
  writeFileSync(dotenv, 'JIRA_TOKEN=stale\n');

  console.assert(loadEnv(dotenv, [zshrc, bashrc]).token === 'from-zsh', 'an rc file beats a stale .env');
  console.assert(loadEnv(dotenv, [bashrc, zshrc]).token === 'from-bash', 'the first rc file in the list wins');
  console.assert(loadEnv(dotenv, [absent, bashrc]).token === 'from-bash', 'an rc file that does not exist is skipped');
  console.assert(loadEnv(dotenv, [absent]).token === 'stale', '.env still works where no rc file has a token');
  process.env.JIRA_TOKEN = 'override';
  console.assert(loadEnv(dotenv, [zshrc]).token === 'override', 'the environment beats every file');
  rmSync(dir, { recursive: true, force: true });

  console.assert(loadEnv(null, []).baseUrl === DEFAULT_BASE_URL, 'falls back to the default instance');

  process.env.JIRA_BASE_URL = 'https://jira.example.com///';
  console.assert(loadEnv(null, []).baseUrl === 'https://jira.example.com', 'an override wins and loses its trailing slashes');

  if (saved.t === undefined) delete process.env.JIRA_TOKEN; else process.env.JIRA_TOKEN = saved.t;
  if (saved.u === undefined) delete process.env.JIRA_BASE_URL; else process.env.JIRA_BASE_URL = saved.u;

  if (!failed) console.log('selftest OK');
}

// Only when this file is what was run — otherwise `watch.mjs --selftest` would
// trigger it a second time just by importing.
const isEntry = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isEntry && process.argv.includes('--selftest')) selftest();
