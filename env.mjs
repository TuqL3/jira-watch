/**
 * Shared plumbing: where the Jira client lives, which .env carries the token,
 * and which custom field holds the assignees.
 *
 * Nothing about a particular Jira instance is hardcoded here — the host comes
 * from the falcon plugin's config, the field id from JIRA_ASSIGNEES_FIELD.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// The Jira client (auth, base URL, fetch wrapper) comes from the falcon plugin
// rather than being duplicated here, so the token lives in one place and
// falcon:jira keeps working.
//
// Where the plugin lands differs per machine: a marketplace install puts it
// under cache/<owner>/<plugin>/<version-hash>/, while a dev checkout sits in
// marketplaces/<name>/. The version hash changes on every plugin update, so the
// path has to be discovered rather than written down.
export function skillDirCandidates() {
  if (process.env.FALCON_JIRA_DIR) return [process.env.FALCON_JIRA_DIR];

  const plugins = join(homedir(), '.claude/plugins');
  const dirs = (p) => {
    try {
      return readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(p, d.name));
    } catch {
      return [];
    }
  };

  const candidates = [];
  // The common shapes first, so the usual machine never pays for the walk.
  for (const m of dirs(join(plugins, 'marketplaces'))) {
    candidates.push(join(m, 'skills/jira'));
    // Marketplaces that host several plugins nest one level deeper.
    for (const p of dirs(join(m, 'plugins'))) candidates.push(join(p, 'skills/jira'));
  }
  // cache/<owner>/<plugin>/<version>/skills/jira
  for (const owner of dirs(join(plugins, 'cache'))) {
    for (const plugin of dirs(owner)) {
      for (const version of dirs(plugin)) candidates.push(join(version, 'skills/jira'));
    }
  }
  // A personal copy, which the source repo still calls jira-create.
  candidates.push(join(homedir(), '.claude/skills/jira'), join(homedir(), '.claude/skills/jira-create'));

  const found = candidates.filter((c) => existsSync(join(c, 'scripts/lib/jira.mjs')));
  if (found.length) return found;

  // Nothing matched a known shape. Rather than guess at more layouts, walk
  // ~/.claude for the file itself — plugin directory conventions keep changing.
  return walkForSkill(join(homedir(), '.claude'), 8);
}

/** Every directory under `root` that holds scripts/lib/jira.mjs. */
function walkForSkill(root, maxDepth) {
  const skip = new Set(['node_modules', '.git', 'cache-tmp', 'projects', 'todos', 'shell-snapshots']);
  const out = [];
  const visit = (dir, depth) => {
    if (depth > maxDepth || out.length > 20) return;
    if (existsSync(join(dir, 'scripts/lib/jira.mjs'))) out.push(dir);
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory() && !skip.has(e.name) && !e.name.startsWith('.')) visit(join(dir, e.name), depth + 1);
    }
  };
  visit(root, 0);
  return out;
}

// Older copies of the skill exist on some machines and export a different set
// of functions, so "the file is there" is not enough — the module has to be
// checked before it is trusted.
const REQUIRED = ['loadEnv', 'jiraFetch', 'fetchMyself'];

export const SKILL_DIR = skillDirCandidates()[0]
  || join(homedir(), '.claude/plugins/marketplaces/falcon/skills/jira');
export const LIB = join(SKILL_DIR, 'scripts/lib/jira.mjs');

// The falcon skill's .env comes first because falcon:jira reads it too — one
// token in one place serves both. This directory is the fallback.
const envCandidates = (skillDir = SKILL_DIR) => [join(skillDir, '.env'), join(HERE, '.env')];

export function pickEnvPath(skillDir = SKILL_DIR) {
  const list = envCandidates(skillDir);
  for (const p of list) {
    if (existsSync(p) && /^\s*JIRA_TOKEN\s*=\s*\S/m.test(readFileSync(p, 'utf8'))) return p;
  }
  return list[0]; // let loadEnv raise MISSING_JIRA_TOKEN with a sane path
}

/** A setting from the environment, else from whichever .env holds the token. */
function setting(name) {
  if (process.env[name]) return process.env[name];
  for (const p of envCandidates()) {
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

/**
 * First candidate whose jira.mjs actually exports what we need. install.sh asks
 * for this too, so the token gets written next to the copy that will be used.
 */
export async function resolveSkill() {
  const candidates = skillDirCandidates();
  if (!candidates.length) {
    const marketplaces = (() => {
      try {
        return readdirSync(join(homedir(), '.claude/plugins/marketplaces')).join(', ') || '(trống)';
      } catch {
        return '(không có thư mục marketplaces)';
      }
    })();
    throw new Error(
      'Không tìm thấy skill jira của plugin falcon.\n'
      + `Đã quét toàn bộ ~/.claude tìm scripts/lib/jira.mjs — không có file nào.\n`
      + `Marketplace đang cài: ${marketplaces}\n`
      + 'Cài plugin falcon trước, hoặc chỉ đường:\n'
      + '  FALCON_JIRA_DIR=<đường-dẫn-tới-skills/jira> bash install-jira-watch.sh',
    );
  }

  const rejected = [];
  for (const dir of candidates) {
    const libDir = join(dir, 'scripts/lib');
    // The skill splits its helpers across files and moves them between
    // versions — loadEnv and jiraFetch have already left jira.mjs once — so
    // merge the exports of every module in lib/ instead of naming one file.
    let files = [];
    try {
      files = readdirSync(libDir).filter((f) => f.endsWith('.mjs')).sort();
    } catch {
      rejected.push(`${libDir} — không đọc được thư mục`);
      continue;
    }

    const lib = {};
    const errors = [];
    for (const f of files) {
      try {
        const mod = await import(pathToFileURL(join(libDir, f)).href);
        for (const [k, v] of Object.entries(mod)) if (!(k in lib)) lib[k] = v;
      } catch (err) {
        errors.push(`${f}: ${err.message}`);
      }
    }

    const missing = REQUIRED.filter((fn) => typeof lib[fn] !== 'function');
    if (missing.length) {
      rejected.push(
        `${libDir} — thiếu ${missing.join(', ')} (đã gom ${files.join(', ') || 'không có file .mjs nào'})`
        + (errors.length ? `; lỗi nạp: ${errors.join(' | ')}` : ''),
      );
      continue;
    }
    return { dir, libPath: libDir, lib };
  }

  throw new Error(`Tìm thấy skill jira nhưng không bản nào dùng được:\n  ${rejected.join('\n  ')}`);
}

/** Load the falcon jira lib and an env that has a token in it. */
export async function connect({ verbose = false } = {}) {
  const { dir, libPath, lib } = await resolveSkill();
  const envPath = pickEnvPath(dir);
  if (verbose) console.log('lib:', libPath, '\nenv:', envPath);
  return { ...lib, env: lib.loadEnv(envPath), skillDir: dir };
}
