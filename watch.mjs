#!/usr/bin/env node
/**
 * Poll Jira (Data Center) for changes that concern me and
 * raise a macOS notification for each one.
 *
 * Watches: status transitions, new comments, being added to the Assignees field.
 *
 * Usage:
 *   node watch.mjs --selftest    # run the diff assertions, no network
 *   node watch.mjs --init        # seed state.json without notifying
 *   node watch.mjs               # one poll, notify on anything new
 *   node watch.mjs --verbose     # same, but print what it found
 *
 * Reads JIRA_TOKEN from the falcon jira skill's .env (single source of truth).
 */

import { execFile, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ASSIGNEES_FIELD, connect, requireAssigneesField } from './env.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = join(HERE, 'state.json');
const LOG_PATH = join(HERE, 'watch.log');
const ERR_PATH = join(HERE, 'watch.err.log');
const MAX_LOG_LINES = 500;
const FIELDS = ['key', 'summary', 'status', 'created', 'updated', 'comment', ASSIGNEES_FIELD].join(',');
const WINDOW_MINUTES = 90;

const args = new Set(process.argv.slice(2));
const verbose = args.has('--verbose');

// ---------------------------------------------------------------- pure logic

/**
 * Flatten Jira markup to a single line. Notification text is one line whatever
 * we do, and a raw newline would break the AppleScript string literal.
 */
export function oneLine(text, max = 180) {
  const flat = String(text || '')
    .replace(/\{code[^}]*\}|\{quote\}|\{noformat\}/g, ' ')
    .replace(/\[~([^\]]+)\]/g, '@$1')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Username behind the most recent changelog entry that touched any of `fields`.
 * Jira has no "last updated by" field, so a status or Assignees change can only
 * be attributed by walking the changelog backwards.
 */
export function lastChangeAuthor(changelog, fields) {
  const histories = changelog?.histories || [];
  for (let i = histories.length - 1; i >= 0; i--) {
    const h = histories[i];
    const touched = (h.items || []).some((it) => fields.includes(it.fieldId) || fields.includes(it.field));
    if (touched) return h.author?.name || '';
  }
  return '';
}

/**
 * Compare two "v1.2.3" tags. Returns true when `latest` is newer than
 * `current`. Anything unparseable counts as "not newer", so a malformed tag
 * cannot nag forever or trigger an unwanted update.
 */
export function isNewerVersion(latest, current) {
  const parse = (v) => {
    const m = String(v || '').match(/^v?(\d+)\.(\d+)\.(\d+)$/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const a = parse(latest);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return false;
}

/** Last `max` non-empty lines, oldest first. Empty input stays empty. */
export function keepLast(text, max) {
  const rows = String(text || '').split('\n').filter((r) => r !== '');
  return rows.length <= max ? rows : rows.slice(rows.length - max);
}

/** Shrink a Jira issue down to the only bits we compare between polls. */
export function snapshot(issue, meName) {
  const f = issue.fields || {};
  const assignees = Array.isArray(f[ASSIGNEES_FIELD]) ? f[ASSIGNEES_FIELD] : [];
  const comments = f.comment?.comments || [];
  const last = comments.slice(-1)[0] || null;
  return {
    summary: f.summary || '',
    status: f.status?.name || '',
    commentIds: comments.map((c) => String(c.id)),
    // Jira truncates the inline comment array to maxResults, so a new comment on
    // a long thread can be missing from `comments`. `total` still moves.
    commentTotal: typeof f.comment?.total === 'number' ? f.comment.total : comments.length,
    // `name` is the username, needed to tell my own comments apart; `author` is
    // the display name that goes in the notification.
    created: Date.parse(f.created) || 0,
    lastComment: last && {
      author: last.author?.displayName || 'ai đó',
      name: last.author?.name || '',
      body: oneLine(last.body),
      created: Date.parse(last.created) || 0,
    },
    mine: assignees.some((u) => u && (u.name === meName || u.key === meName)),
  };
}

/**
 * Compare two snapshots of the same issue and describe what changed.
 * `before` is null the first time we ever see an issue.
 */
export function diffIssue(key, before, after, meName, since = 0) {
  const events = [];
  // The issue key alone says nothing about which task moved, so every
  // notification carries the summary in one of its three lines.
  const summary = oneLine(after.summary, 60);
  const mineComment = meName && after.lastComment?.name === meName;

  if (!before) {
    // First sight. There is nothing to diff against, so timestamps decide what
    // actually happened: an issue we have never seen enters the window either
    // because it was just created, or because somebody touched an old one.
    //
    // Treating "I am in Assignees" as "I was just assigned" was wrong — a task
    // from last year that someone comments on would announce itself as a new
    // assignment, and a comment on an old issue we only report or watch would
    // say nothing at all.
    if (after.created && after.created >= since) {
      if (after.mine) {
        events.push({ key, kind: 'assigned', title: key, subtitle: 'Bạn được assign', message: summary, text: `Bạn được assign ${key}` });
      }
    } else if (after.lastComment?.created >= since && !mineComment) {
      const who = after.lastComment.author;
      events.push({
        key,
        kind: 'comment',
        title: `${key} · ${who}`,
        subtitle: summary,
        message: after.lastComment.body || summary,
        text: `${key}  comment mới · ${who}: ${after.lastComment.body}`,
      });
    }
    // Anything else: record the snapshot quietly and diff properly next time.
    return events;
  }
  if (before.status !== after.status) {
    events.push({
      key,
      kind: 'status',
      title: key,
      subtitle: `${before.status} → ${after.status}`,
      message: summary,
      text: `${key}  ${before.status} → ${after.status}`,
    });
  }
  const seen = new Set(before.commentIds);
  const fresh = after.commentIds.filter((id) => !seen.has(id));
  const grew = (after.commentTotal ?? 0) - (before.commentTotal ?? 0);
  const added = Math.max(fresh.length, grew > 0 ? grew : 0);
  // My own comment is not news to me. When the thread was truncated we have no
  // author to check, so err towards notifying rather than staying silent.
  if (added > 0 && !mineComment) {
    const who = after.lastComment?.author || 'ai đó';
    const n = added > 1 ? ` (${added})` : '';
    // The body is missing only when Jira truncated the thread; fall back to the
    // summary so the notification still says which issue moved.
    const body = after.lastComment?.body || after.summary;
    events.push({
      key,
      kind: 'comment',
      // Author moves up to the title so the summary can own the second line;
      // the comment text is what matters most and keeps the roomiest line.
      title: `${key}${n} · ${who}`,
      subtitle: summary,
      message: body,
      text: `${key}  comment mới${n} · ${who}: ${body}`,
    });
  }
  if (!before.mine && after.mine) {
    events.push({ key, kind: 'assigned', title: key, subtitle: 'Bạn được assign', message: summary, text: `Bạn được assign ${key}` });
  }
  return events;
}

// ------------------------------------------------------------------- effects

// JiraNotify.app exists purely so the notification belongs to an app we own:
// clicking it relaunches the applet, which opens the URL left in the payload
// file. osascript notifications belong to Script Editor and do nothing on click.
// (terminal-notifier was tried and dropped — it exits 0 and delivers nothing on
// this machine.)
const APPLET = join(homedir(), 'Applications/JiraNotify.app/Contents/MacOS/applet');
const PAYLOAD = join(homedir(), '.jira-notify-payload');

// JIRA_NOTIFIER=osascript forces the click-less path if the applet ever breaks.
const notifier = process.env.JIRA_NOTIFIER
  || [...args].find((a) => a.startsWith('--notifier='))?.split('=')[1]
  || 'auto';

// Banner delivery depends on macOS notification permissions that a script cannot
// inspect or grant. afplay needs none, so it is the one channel we can be sure
// reaches the user. Off unless asked for.
const withSound = process.env.JIRA_SOUND === '1' || args.has('--sound');

// My own edits are not news to me. --include-mine turns the filtering off.
const includeMine = process.env.JIRA_INCLUDE_MINE === '1' || args.has('--include-mine');

function notify({ title, subtitle, message, url }) {
  const done = (err) => {
    if (err && verbose) console.error('notify failed:', err.message);
  };
  const line = (s) => String(s).replace(/[\r\n]+/g, ' ');

  if (withSound) execFile('/usr/bin/afplay', ['/System/Library/Sounds/Glass.aiff'], () => {});

  if (notifier !== 'osascript' && existsSync(APPLET)) {
    // Five lines, in the order the applet reads them. execFileSync so two events
    // in the same poll cannot overwrite each other's payload mid-flight.
    writeFileSync(PAYLOAD, ["post", line(title), line(subtitle), line(message), url || ""].join('\n') + '\n');
    try {
      execFileSync(APPLET, { timeout: 10_000, stdio: 'ignore' });
      return;
    } catch (err) {
      done(err); // fall through to osascript rather than lose the notification
    }
  }

  // osascript has no click action, so the URL has to be readable in the text.
  const esc = (s) => line(s).replace(/["\\]/g, '\\$&');
  const script = `display notification "${esc(message)}" with title "${esc(title)}" subtitle "${esc(subtitle)}"`;
  execFile('osascript', ['-e', script], done);
}

function loadState() {
  if (!existsSync(STATE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Drop status/assigned events that I caused myself. Comments are already
 * filtered in diffIssue; these two need one changelog lookup per issue, which
 * only happens when something actually changed.
 */
async function dropMyOwnChanges(events, meName, jiraFetch, env) {
  const needsCheck = events.filter((e) => e.kind === 'status' || e.kind === 'assigned');
  if (!needsCheck.length) return events;

  const authorByKey = new Map();
  for (const key of new Set(needsCheck.map((e) => e.key))) {
    try {
      const { status, json } = await jiraFetch(
        `/rest/api/2/issue/${encodeURIComponent(key)}?expand=changelog&fields=summary`,
        { env },
      );
      if (status !== 200) continue; // cannot attribute it, so let it through
      authorByKey.set(key, lastChangeAuthor(json.changelog, ['status', ASSIGNEES_FIELD, 'Assignees']));
    } catch {
      // Same: an unattributable change is better announced than swallowed.
    }
  }

  return events.filter((e) => {
    if (e.kind !== 'status' && e.kind !== 'assigned') return true;
    const author = authorByKey.get(e.key);
    return !(author && author === meName);
  });
}

async function search(jql, jiraFetch, env) {
  const qs = `jql=${encodeURIComponent(jql)}&fields=${encodeURIComponent(FIELDS)}&maxResults=100`;
  const { status, json } = await jiraFetch(`/rest/api/2/search?${qs}`, { env });
  if (status !== 200) throw new Error(`HTTP ${status} ${JSON.stringify(json).slice(0, 300)}`);
  return json.issues || [];
}

/**
 * Cap the logs before this run writes to them. launchd opens both files
 * O_APPEND per run, so rewriting here is safe — our own output still lands at
 * the end.
 *
 * The error log matters most: off the office network every poll fails, which is
 * four lines a minute for as long as you stay away.
 */
function trimLogs() {
  for (const path of [LOG_PATH, ERR_PATH]) {
    try {
      if (!existsSync(path)) continue;
      const text = readFileSync(path, 'utf8');
      const rows = keepLast(text, MAX_LOG_LINES);
      if (text.split('\n').filter((r) => r !== '').length <= MAX_LOG_LINES) continue;
      writeFileSync(path, rows.join('\n') + '\n');
    } catch {
      // A log we cannot trim is not worth failing the poll over.
    }
  }
}

const REPO = 'TuqL3/jira-watch';
const VERSION_PATH = join(HERE, 'VERSION');
const UPDATE_STAMP = join(HERE, 'last-update-check.txt');
const UPDATE_EVERY_MS = 6 * 60 * 60 * 1000;

/**
 * Tell the user when a newer release exists. Applying it means running the
 * installer, which restarts the Dock and the notification daemon — too rude to
 * do unannounced, so that only happens with JIRA_AUTO_UPDATE=1.
 */
async function checkForUpdate() {
  if (process.env.JIRA_NO_UPDATE_CHECK === '1') return;
  if (!existsSync(VERSION_PATH)) return; // installed before versions were tracked

  const now = Date.now();
  if (existsSync(UPDATE_STAMP)) {
    const last = Number(readFileSync(UPDATE_STAMP, 'utf8').trim());
    if (Number.isFinite(last) && now - last < UPDATE_EVERY_MS) return;
  }
  // Stamp before the request: a failing network must not retry every poll.
  writeFileSync(UPDATE_STAMP, String(now));

  const current = readFileSync(VERSION_PATH, 'utf8').trim();
  let latest = '';
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return;
    latest = (await res.json())?.tag_name || '';
  } catch {
    return; // offline, or GitHub is unhappy — try again in six hours
  }

  if (!isNewerVersion(latest, current)) return;

  if (process.env.JIRA_AUTO_UPDATE === '1') {
    console.log(`${localStamp()}  cập nhật ${current} -> ${latest}`);
    try {
      execFileSync('/bin/bash', ['-c',
        `curl -fsSL https://github.com/${REPO}/releases/latest/download/install-jira-watch.sh `
        + `| TARGET=${JSON.stringify(HERE)} bash`],
      { timeout: 300_000, stdio: 'ignore' });
      console.log(`${localStamp()}  đã cập nhật lên ${latest}`);
    } catch (err) {
      console.error(`${localStamp()}  cập nhật thất bại: ${err.message}`);
    }
    return;
  }

  notify({
    title: `jira-watch ${latest}`,
    subtitle: `đang dùng ${current}`,
    message: 'Bấm để xem bản mới. Cập nhật: chạy lại lệnh cài.',
    url: `https://github.com/${REPO}/releases/latest`,
  });
  console.log(`${localStamp()}  có bản mới: ${current} -> ${latest}`);
}

function localStamp() {
  return new Date().toLocaleString('sv-SE');
}

async function main() {
  trimLogs();
  requireAssigneesField();
  const { jiraFetch, fetchMyself, env } = await connect({ verbose });
  // fetchMyself returns json.name, i.e. the bare username string.
  const meName = await fetchMyself(env);
  if (!meName) throw new Error('Could not resolve my own username from /rest/api/2/myself');
  if (verbose) console.log('me:', meName);

  // Seeding must capture the whole working set, otherwise state stays empty and
  // every later run re-seeds instead of notifying.
  const override = [...args].find((a) => a.startsWith('--window='))?.split('=')[1];
  if (override && !/^\d+[mhd]$/.test(override)) throw new Error(`--window must look like 90m, 6h or 30d — got ${override}`);
  const window = override || (args.has('--init') ? '90d' : `${WINDOW_MINUTES}m`);
  const recent = `updated >= -${window}`;
  // Same cutoff in milliseconds, so a first-seen issue can be judged by when it
  // was created or last commented on rather than by guesswork.
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[window.slice(-1)];
  const since = Date.now() - Number(window.slice(0, -1)) * unit;
  if (verbose) console.log('window:', window);
  // The custom field may or may not be indexed for JQL; fall back if it is not.
  // JQL addresses a custom field as cf[<number>], not by its customfield_ id.
  const cf = `cf[${ASSIGNEES_FIELD.replace(/\D/g, '')}]`;
  const preferred = `(${cf} = currentUser() OR reporter = currentUser() OR watcher = currentUser()) AND ${recent}`;
  const fallback = `(reporter = currentUser() OR watcher = currentUser()) AND ${recent}`;

  let issues;
  try {
    issues = await search(preferred, jiraFetch, env);
    if (verbose) console.log('JQL:', cf, 'is searchable');
  } catch (err) {
    if (verbose) console.log('JQL:', cf, 'not searchable, falling back:', err.message);
    issues = await search(fallback, jiraFetch, env);
  }

  const before = loadState();
  const after = {};
  let events = [];
  for (const issue of issues) {
    const snap = snapshot(issue, meName);
    after[issue.key] = snap;
    events.push(...diffIssue(issue.key, before[issue.key] || null, snap, includeMine ? null : meName, since));
  }
  if (!includeMine) events = await dropMyOwnChanges(events, meName, jiraFetch, env);

  // Issues that fell outside the window keep their last known snapshot, so a
  // change that happens after a quiet spell is still detected as a change.
  const merged = { ...before, ...after };
  writeFileSync(STATE_PATH, JSON.stringify(merged, null, 2));

  const seeding = args.has('--init') || Object.keys(before).length === 0;
  if (seeding) {
    console.log(`Seeded ${Object.keys(after).length} issue(s). No notifications on the first run.`);
    return;
  }

  // Local time, not UTC: a log stamped 7 hours off is worse than no stamp.
  const stamp = localStamp();

  // At a 15s interval a "nothing new" line every run would bury the real events
  // under thousands of rows a day. Events go to the log; liveness goes to a
  // single file that gets overwritten.
  writeFileSync(join(HERE, 'last-run.txt'), `${stamp}  ${issues.length} issue in window, ${events.length} event\n`);

  for (const e of events) {
    notify({ ...e, url: `${env.baseUrl}/browse/${e.key}` });
    console.log(`${stamp}  ${e.text}`);
  }
  if (!events.length && verbose) console.log(`${stamp}  nothing new (${issues.length} issue in window)`);

  // Last, so a GitHub hiccup can never delay the notifications people rely on.
  await checkForUpdate();
}

// ------------------------------------------------------------------ selftest

function selftest() {
  // console.assert only logs; without this the run still prints OK and exits 0
  // while assertions are failing.
  let failed = 0;
  const nativeAssert = console.assert.bind(console);
  console.assert = (ok, msg) => {
    if (!ok) failed++;
    nativeAssert(ok, msg);
  };
  process.on('exit', () => {
    if (failed) {
      console.error(`selftest FAILED: ${failed} assertion(s)`);
      process.exitCode = 1;
    }
  });

  // Jira markup and newlines must never reach the AppleScript string literal.
  console.assert(oneLine('a\nb\r\nc') === 'a b c', 'newlines collapse to spaces');
  console.assert(oneLine('{code}x{code} hi') === 'x hi', 'code markers are stripped');
  console.assert(oneLine('ping [~alice] now') === 'ping @alice now', 'mentions become @name');
  console.assert(oneLine('x'.repeat(300)).length === 180, 'long bodies are truncated to the cap');
  console.assert(oneLine(null) === '', 'a null body is empty, not "null"');

  // Changelog attribution walks backwards to the newest matching entry.
  const cl = {
    histories: [
      { author: { name: 'bob' }, items: [{ field: 'status', fieldId: 'status' }] },
      { author: { name: 'alice' }, items: [{ field: 'description' }] },
      { author: { name: 'alice' }, items: [{ field: 'Assignees', fieldId: 'customfield_99999' }] },
    ],
  };
  console.assert(lastChangeAuthor(cl, ['customfield_99999']) === 'alice', 'finds the newest matching entry');
  console.assert(lastChangeAuthor(cl, ['status']) === 'bob', 'ignores entries that touch other fields');
  console.assert(lastChangeAuthor(cl, ['priority']) === '', 'no matching entry yields no author');
  console.assert(lastChangeAuthor(null, ['status']) === '', 'a missing changelog is not an error');

  // Version comparison decides whether people get nagged, or auto-updated.
  console.assert(isNewerVersion('v1.0.1', 'v1.0.0'), 'patch bump is newer');
  console.assert(isNewerVersion('v1.1.0', 'v1.0.9'), 'minor beats a bigger patch');
  console.assert(isNewerVersion('v2.0.0', 'v1.9.9'), 'major beats everything below');
  console.assert(!isNewerVersion('v1.0.0', 'v1.0.0'), 'same version is not newer');
  console.assert(!isNewerVersion('v1.0.0', 'v1.0.1'), 'older is not newer');
  console.assert(!isNewerVersion('v1.0.10', 'v1.0.9') === false, 'ten beats nine, not string order');
  console.assert(!isNewerVersion('rác', 'v1.0.0'), 'an unparseable tag never triggers an update');
  console.assert(!isNewerVersion('v9.9.9', 'unknown'), 'an unknown local version never triggers an update');

  // Log trimming keeps the newest rows, drops the oldest.
  console.assert(keepLast('a\nb\nc\n', 2).join() === 'b,c', 'keeps the last rows, oldest dropped');
  console.assert(keepLast('a\nb\n', 5).join() === 'a,b', 'short input is untouched');
  console.assert(keepLast('', 5).length === 0, 'empty input stays empty');
  console.assert(keepLast('a\n\n\nb\n', 5).join() === 'a,b', 'blank rows are not counted');

  const base = { summary: 'x', status: 'To Do', commentIds: ['1'], commentTotal: 1, lastComment: null, mine: false };

  const none = diffIssue('ABC-1', base, { ...base });
  console.assert(none.length === 0, 'identical snapshots must produce no events');

  const moved = diffIssue('ABC-1', base, { ...base, status: 'In Progress' });
  console.assert(moved.length === 1 && moved[0].kind === 'status', 'status change must fire');

  const commented = diffIssue('ABC-1', base, {
    ...base,
    commentIds: ['1', '2'],
    commentTotal: 2,
    lastComment: { author: 'Tony', name: 'tuannv', body: 'đã fix xong nhé' },
  });
  console.assert(commented.length === 1 && commented[0].kind === 'comment', 'new comment must fire');
  console.assert(commented[0].title.includes('Tony'), 'comment event names the author in the title');
  console.assert(commented[0].subtitle === 'x', 'comment event puts the issue summary in the subtitle');
  console.assert(commented[0].message === 'đã fix xong nhé', 'comment event carries the body');

  // My own comment must stay silent; someone else's must not.
  const mineBody = { ...base, commentIds: ['1', '2'], commentTotal: 2, lastComment: { author: 'Alice', name: 'alice', body: 'tôi tự comment' } };
  console.assert(diffIssue('ABC-1', base, mineBody, 'alice').length === 0, 'my own comment does not notify');
  console.assert(diffIssue('ABC-1', base, mineBody, 'bob').length === 1, "someone else's comment still notifies");
  console.assert(diffIssue('ABC-1', base, mineBody, null).length === 1, '--include-mine restores my own comments');

  // A year-old issue that somebody touches today enters the window for the
  // first time. It must not announce itself as a new assignment, and a comment
  // on it must not go unreported just because we have never seen the issue.
  const YEAR_AGO = 1_000_000;
  const NOW = 9_000_000;
  const SINCE = 8_000_000;
  const oldIssue = { ...base, created: YEAR_AGO, mine: true };

  const oldTouched = diffIssue('ABC-9', null, oldIssue, 'alice', SINCE);
  console.assert(oldTouched.length === 0, 'an old issue with no recent comment stays silent');

  const oldCommented = diffIssue('ABC-9', null, {
    ...oldIssue,
    lastComment: { author: 'Bob', name: 'bob', body: 'ai xem giúp', created: NOW },
  }, 'alice', SINCE);
  console.assert(oldCommented.length === 1 && oldCommented[0].kind === 'comment',
    'a comment on a first-seen old issue is reported as a comment');
  console.assert(!oldCommented.some((e) => e.kind === 'assigned'),
    'a first-seen old issue never claims to be a new assignment');

  const oldCommentedByMe = diffIssue('ABC-9', null, {
    ...oldIssue,
    lastComment: { author: 'Alice', name: 'alice', body: 'tôi tự nói', created: NOW },
  }, 'alice', SINCE);
  console.assert(oldCommentedByMe.length === 0, 'my own comment on an old issue stays silent');

  // A genuinely new issue assigned to me still announces itself.
  const brandNew = diffIssue('ABC-9', null, { ...base, created: NOW, mine: true }, 'alice', SINCE);
  console.assert(brandNew.length === 1 && brandNew[0].kind === 'assigned', 'a new issue assigned to me notifies');

  const brandNewNotMine = diffIssue('ABC-9', null, { ...base, created: NOW, mine: false }, 'alice', SINCE);
  console.assert(brandNewNotMine.length === 0, 'a new issue not assigned to me stays silent');

  // A truncated thread has no author to check; announcing beats staying silent.
  const unknown = { ...base, commentTotal: 41, lastComment: null };
  console.assert(diffIssue('ABC-1', { ...base, commentTotal: 40 }, unknown, 'alice').length === 1, 'unattributable comment still notifies');

  // Truncated thread: no body available, so fall back to the summary.
  const bodyless = diffIssue('ABC-1', { ...base, commentTotal: 40 }, { ...base, commentTotal: 41, summary: 'tiêu đề' });
  console.assert(bodyless[0].message === 'tiêu đề', 'a missing body falls back to the summary');

  // Long thread: Jira truncated `comments`, so the ids look unchanged but total grew.
  const truncated = diffIssue(
    'ABC-1',
    { ...base, commentIds: ['1'], commentTotal: 40 },
    { ...base, commentIds: ['1'], commentTotal: 41 },
  );
  console.assert(truncated.length === 1 && truncated[0].kind === 'comment', 'total growth must fire');

  // A deleted comment lowers the total; that must not be reported as new.
  const deleted = diffIssue(
    'ABC-1',
    { ...base, commentIds: ['1'], commentTotal: 40 },
    { ...base, commentIds: ['1'], commentTotal: 39 },
  );
  console.assert(deleted.length === 0, 'a shrinking total must stay silent');

  const taken = diffIssue('ABC-1', base, { ...base, mine: true });
  console.assert(taken.length === 1 && taken[0].kind === 'assigned', 'being assigned must fire');

  // An issue seen for the first time is only interesting when it is mine.
  // Being in Assignees is not by itself news — see the first-seen cases below.
  console.assert(diffIssue('ABC-1', null, base).length === 0, 'unseen + not mine = silent');
  console.assert(diffIssue('ABC-1', null, { ...base, mine: true }).length === 0,
    'unseen + mine but no timestamps = silent, not a phantom assignment');

  // A comment written by me still counts as new; dedupe is by id, not author.
  const twice = diffIssue('ABC-1', { ...base, commentIds: ['1', '2'] }, { ...base, commentIds: ['1', '2'] });
  console.assert(twice.length === 0, 'already-seen comments must not re-fire');

  if (!failed) console.log('selftest OK');
}

if (args.has('--selftest')) {
  selftest();
} else {
  main().catch((err) => {
    console.error('ERROR', err.message);
    process.exit(1);
  });
}
