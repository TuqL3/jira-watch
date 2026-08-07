#!/usr/bin/env node
/**
 * Write actions against Jira (Data Center).
 *
 *   node act.mjs show     ABC-123
 *   node act.mjs comment  ABC-123 "nội dung comment"
 *   node act.mjs assign   ABC-123                 # add myself to Assignees
 *   node act.mjs assign   ABC-123 --user someone
 *   node act.mjs unassign ABC-123                 # remove myself
 *
 * Flags: --dry-run (print the payload, send nothing), --selftest (asserts only).
 *
 * Assignees is a multi-user field shared with the rest of the team, so every
 * write here MERGES into the existing list. It never replaces it.
 */

import { ASSIGNEES_FIELD, connect, requireAssigneesField } from './env.mjs';

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const positional = argv.filter((a) => !a.startsWith('--'));
const dryRun = flags.has('--dry-run');

function flagValue(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

// ---------------------------------------------------------------- pure logic

/** Names currently in the field, in order, ignoring malformed entries. */
export function currentNames(field) {
  return (Array.isArray(field) ? field : []).map((u) => u?.name).filter(Boolean);
}

/**
 * "Alice Nguyen (bob)" — the UI shows display names, the API takes
 * usernames, so print both or nobody can match one to the other.
 */
export function labels(field) {
  return (Array.isArray(field) ? field : [])
    .filter((u) => u?.name)
    .map((u) => (u.displayName ? `${u.displayName} (${u.name})` : u.name));
}

/**
 * Add `username` to the Assignees list.
 * Returns null when nothing needs to change, so the caller can skip the PUT.
 */
export function mergeAssignee(field, username) {
  const names = currentNames(field);
  if (names.includes(username)) return null;
  return [...names, username].map((name) => ({ name }));
}

/** Remove `username`. Returns null when they were not on the issue anyway. */
export function removeAssignee(field, username) {
  const names = currentNames(field);
  if (!names.includes(username)) return null;
  return names.filter((n) => n !== username).map((name) => ({ name }));
}

// ------------------------------------------------------------------ commands

async function getIssue(key, jiraFetch, env) {
  const { status, json } = await jiraFetch(
    `/rest/api/2/issue/${encodeURIComponent(key)}?fields=summary,status,assignee,${ASSIGNEES_FIELD}`,
    { env },
  );
  if (status !== 200) throw new Error(`GET ${key} -> HTTP ${status} ${JSON.stringify(json).slice(0, 200)}`);
  return json;
}

async function show(key, jiraFetch, env) {
  const issue = await getIssue(key, jiraFetch, env);
  console.log(`${issue.key}  ${issue.fields.summary}`);
  console.log(`  status   : ${issue.fields.status?.name}`);
  console.log(`  assignees: ${labels(issue.fields[ASSIGNEES_FIELD]).join(', ') || '(trống)'}`);
  // The built-in assignee is unused on this instance; surface it so a change in
  // that convention does not go unnoticed.
  if (issue.fields.assignee) console.log(`  (assignee chuẩn Jira: ${issue.fields.assignee.name} — team vốn để trống)`);
}

async function comment(key, text, jiraFetch, env) {
  if (!text) throw new Error('Thiếu nội dung comment');
  if (dryRun) return console.log(`DRY-RUN POST /issue/${key}/comment`, JSON.stringify({ body: text }));
  const { status, json } = await jiraFetch(`/rest/api/2/issue/${encodeURIComponent(key)}/comment`, {
    method: 'POST',
    body: { body: text },
    env,
  });
  if (status !== 201) throw new Error(`HTTP ${status} ${JSON.stringify(json).slice(0, 300)}`);
  console.log(`${key}  đã comment (id ${json.id})`);
}

async function setAssignees(key, username, mode, jiraFetch, env) {
  // ponytail: plain read-modify-write. Two people editing Assignees within the
  // same second can drop one another's change. Fine for one person driving it by
  // hand; needs an ETag/If-Match check if this ever runs unattended.
  const issue = await getIssue(key, jiraFetch, env);
  const field = issue.fields[ASSIGNEES_FIELD];
  const before = currentNames(field);
  const byName = new Map((Array.isArray(field) ? field : []).filter((u) => u?.name).map((u) => [u.name, u]));
  const label = (n) => (byName.get(n)?.displayName ? `${byName.get(n).displayName} (${n})` : n);
  const next = mode === 'add' ? mergeAssignee(issue.fields[ASSIGNEES_FIELD], username)
                              : removeAssignee(issue.fields[ASSIGNEES_FIELD], username);

  if (next === null) {
    console.log(`${key}  không đổi — ${username} ${mode === 'add' ? 'đã có' : 'vốn không'} trong Assignees [${before.map(label).join(', ') || 'trống'}]`);
    return;
  }
  if (next.length === 0 && !flags.has('--force')) {
    throw new Error(`Bỏ ${username} ra sẽ làm Assignees rỗng. Team quy ước issue luôn có người. Thêm --force nếu chắc chắn.`);
  }

  const payload = { fields: { [ASSIGNEES_FIELD]: next } };
  console.log(`  ${before.map(label).join(', ') || 'trống'}  ->  ${next.map((u) => label(u.name)).join(', ') || 'trống'}`);
  if (dryRun) return console.log(`DRY-RUN PUT /issue/${key}`, JSON.stringify(payload));

  const { status, json } = await jiraFetch(`/rest/api/2/issue/${encodeURIComponent(key)}`, {
    method: 'PUT',
    body: payload,
    env,
  });
  if (status !== 204) throw new Error(`HTTP ${status} ${JSON.stringify(json).slice(0, 300)}`);
  console.log(`${key}  đã cập nhật Assignees`);
}

// ------------------------------------------------------------------ selftest

function selftest() {
  // console.assert only logs; without this the run prints OK and exits 0 while
  // assertions are failing.
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

  const two = [{ name: 'bob' }, { name: 'alice' }];

  console.assert(JSON.stringify(currentNames(two)) === '["bob","alice"]', 'reads names in order');
  console.assert(currentNames(null).length === 0, 'a null field reads as empty');
  console.assert(currentNames([null, { name: 'a' }, {}]).length === 1, 'malformed entries are dropped');

  // Output must be matchable against the Jira UI, which only shows display names.
  const labelled = labels([{ name: 'bob', displayName: 'Alice Nguyen' }, { name: 'x' }]);
  console.assert(labelled[0] === 'Alice Nguyen (bob)', 'label shows display name and username');
  console.assert(labelled[1] === 'x', 'label falls back to the username alone');

  // The whole point: adding me must keep everyone else.
  const added = mergeAssignee([{ name: 'bob' }], 'alice');
  console.assert(JSON.stringify(added) === '[{"name":"bob"},{"name":"alice"}]', 'merge keeps the existing person');

  console.assert(mergeAssignee(two, 'alice') === null, 'already assigned = no write');
  console.assert(JSON.stringify(mergeAssignee(null, 'alice')) === '[{"name":"alice"}]', 'empty field takes the first name');

  const removed = removeAssignee(two, 'alice');
  console.assert(JSON.stringify(removed) === '[{"name":"bob"}]', 'remove keeps the other person');
  console.assert(removeAssignee(two, 'nobody') === null, 'removing a non-member = no write');
  console.assert(removeAssignee([{ name: 'alice' }], 'alice').length === 0, 'removing the last one empties the list');

  if (!failed) console.log('selftest OK');
}

// ---------------------------------------------------------------------- main

async function main() {
  const [cmd, key, ...rest] = positional;
  if (!cmd || !key) {
    console.error('Dùng: node act.mjs <show|comment|assign|unassign> <ISSUE-KEY> [text] [--user name] [--dry-run]');
    process.exit(2);
  }

  requireAssigneesField();
  const { jiraFetch, fetchMyself, env } = await connect({ verbose: flags.has('--verbose') });

  switch (cmd) {
    case 'show':
      return show(key, jiraFetch, env);
    case 'comment':
      return comment(key, rest.join(' '), jiraFetch, env);
    case 'assign':
      return setAssignees(key, flagValue('--user') || (await fetchMyself(env)), 'add', jiraFetch, env);
    case 'unassign':
      return setAssignees(key, flagValue('--user') || (await fetchMyself(env)), 'remove', jiraFetch, env);
    default:
      console.error(`Lệnh lạ: ${cmd}`);
      process.exit(2);
  }
}

if (flags.has('--selftest')) {
  selftest();
} else {
  main().catch((err) => {
    console.error('ERROR', err.message);
    process.exit(1);
  });
}
