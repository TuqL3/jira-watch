#!/bin/bash
# Put a new Jira token into your shell startup file. Run this when jira-watch
# says the old one expired — clicking that notification opens this in Terminal.
#
#   ./set-token.sh            # asks for the token, hidden while typing
#   ./set-token.sh <token>    # or pass it in (what install.sh does)
#
# JIRA_TOKEN in the environment is deliberately NOT a source. Clicking the
# notification opens this in a login shell, which has just sourced the rc file
# and exported the very token that expired — reading it would make this script
# retry the dead token and never ask the human anything.
#
# The token is checked against Jira before anything is written: a typo saved
# here is another hour of silence before the watcher complains again.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Where the token may already live, and where a new one goes. Order matches
# RC_PATHS in jira.mjs — if two files ever hold a token, both sides must agree
# on which one the watcher will read.
if [[ "${SHELL:-}" == */bash ]]; then
  RC_CANDIDATES=("$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.zshrc")
else
  RC_CANDIDATES=("$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile")
fi
TOKEN_LINE='^[[:space:]]*(export[[:space:]]+)?JIRA_TOKEN[[:space:]]*=[[:space:]]*\S'

red() { printf '\033[31m%s\033[0m\n' "$1"; }
ok()  { printf '\033[32m✓\033[0m %s\n' "$1"; }

# Clicking the notification opens this in a Terminal window of its own, and a
# profile set to close on a clean exit would take the reason for the failure
# with it. So a failure waits to be read; success does not — the window is
# already gone or already staying, and either way there is nothing left to see.
# install.sh sets JIRA_WATCH_NO_HOLD: there the output stays in the installer.
#
# Plain `[ … ] && PAUSE=1` would return 1 when false, and `set -e` would take
# that as the script failing. Same for the append further down.
PAUSE=0
if [ -t 1 ] && [ -z "${JIRA_WATCH_NO_HOLD:-}" ]; then PAUSE=1; fi

# Say what went wrong, keep it on screen, stop.
die() {
  red "$1"
  shift
  for extra in "$@"; do echo "  $extra"; done
  if [ "$PAUSE" = 1 ]; then
    printf '\nEnter để đóng cửa sổ này. '
    read -r _ < /dev/tty || true
  fi
  exit 1
}

NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || die "Không tìm thấy node."

# --------------------------------------------------------------- 1. the token

TOKEN="${1:-}"
if [ -z "$TOKEN" ]; then
  echo "Tạo token mới trên Jira: avatar → Profile → Personal Access Tokens"
  # Echoed on purpose, asked for: a token pasted blind is a token you cannot
  # check, and the failure only shows up an hour later. The cost is that it
  # stays in this window's scrollback, hence the reminder to close it.
  echo "(dán vào rồi Enter — token sẽ hiện ra để bạn kiểm lại)"
  printf 'Token: '
  # /dev/tty so this still works when stdin is a pipe (`curl … | bash`).
  # 2>/dev/null comes first so it is already in place when the /dev/tty open
  # fails — otherwise bash prints its own "Device not configured" at the user.
  read -r TOKEN 2>/dev/null < /dev/tty || TOKEN=""
fi

[ -n "$TOKEN" ] || die "Chưa nhập token, không sửa gì." \
  "Không gõ tay được (chạy qua ống) thì truyền thẳng: $0 <token>"

# ---------------------------------------------------------------- 2. check it

# JIRA_TOKEN in the environment outranks every file, so this tests the new token
# and not the expired one still sitting in the rc file. The catch keeps a
# rejected token to one readable line — an uncaught throw prints a Node stack
# trace at someone who only mistyped.
WHOAMI="$(JIRA_TOKEN="$TOKEN" "$NODE_BIN" --input-type=module -e "
try {
  const { connect } = await import('$HERE/env.mjs');
  const { fetchMyself, env } = await connect();
  process.stdout.write(await fetchMyself(env));
} catch (err) {
  process.stdout.write(err.message);
  process.exit(1);
}
" 2>&1)" || die "Token không dùng được, không sửa gì:" "$WHOAMI"
ok "token hợp lệ — đăng nhập với tài khoản: $WHOAMI"

# --------------------------------------------------------------- 3. write it

# Replace the token where it already is. Writing a second copy somewhere else
# would leave the watcher reading whichever file comes first in the order —
# quite possibly the expired one.
RC=""
for f in "${RC_CANDIDATES[@]}"; do
  if [ -f "$f" ] && grep -qE "$TOKEN_LINE" "$f"; then RC="$f"; break; fi
done

# No token anywhere yet: append to a startup file that already exists. Creating
# ~/.bash_profile where there was none would stop bash reading ~/.profile.
if [ -z "$RC" ]; then
  for f in "${RC_CANDIDATES[@]}"; do
    if [ -f "$f" ]; then RC="$f"; break; fi
  done
fi
RC="${JIRA_WATCH_RC:-${RC:-${RC_CANDIDATES[0]}}}"

# These are the user's own files and hold a lot more than this line, so each one
# touched is copied first. Undo = restore the .bak.
write_token() {
  local file="$1" append="$2" tmp
  [ -f "$file" ] || return 0
  grep -qE "$TOKEN_LINE" "$file" || [ "$append" = 1 ] || return 0

  cp "$file" "$file.jira-watch.bak"
  tmp="$(mktemp)"
  # Drop every old JIRA_TOKEN line, then append. Filtering beats `sed -i` on a
  # token that may contain any character a substitution would treat as syntax.
  grep -vE '^[[:space:]]*(export[[:space:]]+)?JIRA_TOKEN[[:space:]]*=' "$file" > "$tmp" || true
  if [ "$append" = 1 ]; then printf 'export JIRA_TOKEN=%s\n' "$TOKEN" >> "$tmp"; fi
  cat "$tmp" > "$file"   # `cat >` and not `mv`, so the file keeps its own permissions
  rm -f "$tmp"
}

touch "$RC"
write_token "$RC" 1
ok "đã ghi vào $RC (bản cũ: $RC.jira-watch.bak)"

# A copy left in another startup file is a stale secret that can also win the
# lookup order tomorrow.
for f in "${RC_CANDIDATES[@]}"; do
  [ "$f" = "$RC" ] && continue
  if [ -f "$f" ] && grep -qE "$TOKEN_LINE" "$f"; then
    write_token "$f" 0
    ok "đã xoá token cũ trong $f"
  fi
done

if [ -f "$HERE/.env" ] && grep -qE "$TOKEN_LINE" "$HERE/.env"; then
  echo "  Còn một JIRA_TOKEN cũ trong $HERE/.env — không còn được dùng, xoá dòng đó đi."
fi

# ~/.zshrc is 644 on a fresh account, and now it holds a credential.
if [ "$(stat -f '%Lp' "$RC")" != "600" ]; then
  echo "  $RC đang cho user khác trên máy đọc được. Máy dùng chung thì: chmod 600 $RC"
fi

# The watcher reads the file itself, so it recovers on the next poll without a
# new shell. Clearing the stamp means a token that is still wrong says so within
# seconds instead of waiting out the one hour throttle.
rm -f "$HERE/last-auth-alert.txt"

echo
echo "Xong. Nhịp quét sau (≤ 1 phút) là chạy lại bình thường, không cần mở shell mới."
echo "Đóng cửa sổ này đi — token vừa gõ còn nằm trong lịch sử cuộn của nó."
