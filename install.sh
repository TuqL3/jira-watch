#!/bin/bash
# Install the Jira watcher for the current user.
#
#   ./install.sh              # 60s polling (the team default)
#   INTERVAL=15 ./install.sh  # faster, only if you know what it costs Jira
#
# Everything it touches lives under your home directory and is undone by
# ./uninstall.sh. Nothing is installed system-wide.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$HOME/Applications/JiraNotify.app"
PLIST="$HOME/Library/LaunchAgents/com.jira-watch.plist"
FALCON_JIRA_DIR="${FALCON_JIRA_DIR:-$HOME/.claude/plugins/marketplaces/falcon/skills/jira}"
INTERVAL="${INTERVAL:-60}"

red() { printf '\033[31m%s\033[0m\n' "$1"; }
ok()  { printf '\033[32m✓\033[0m %s\n' "$1"; }
say() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# Under `curl … | bash` stdin is the script itself, so `read` hits EOF and
# set -e kills the run halfway through. Prompts use the keyboard directly.
# Testing `-r /dev/tty` is not enough — the file can exist and still fail to
# open when there is no controlling terminal — so try opening it for real.
# The braces matter: `exec 3< /dev/tty 2>/dev/null` still lets bash print its
# own "Device not configured" before the redirection applies.
HAS_TTY=0
if { exec 3< /dev/tty; } 2>/dev/null; then HAS_TTY=1; fi

# --------------------------------------------------------------- 1. the machine

say "1/6  Kiểm môi trường"

[ "$(uname)" = "Darwin" ] || { red "Chỉ chạy được trên macOS (dùng launchd + osascript)."; exit 1; }
ok "macOS"

NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || { red "Không tìm thấy node. Cài Node 18+ rồi chạy lại."; exit 1; }
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || { red "Cần Node >= 18, đang có $($NODE_BIN -v). fetch() không có ở bản cũ hơn."; exit 1; }
ok "node $($NODE_BIN -v) tại $NODE_BIN"

# The Jira client lives in the falcon plugin; without it there is no auth layer.
# Where the plugin sits differs per machine (marketplace install vs dev
# checkout, and the version hash in the cache path changes on every update), so
# let env.mjs do the search instead of guessing one path here.
# resolveSkill also loads each candidate and checks its exports, so an old copy
# of the skill is skipped here exactly as it is at runtime.
RESOLVE_OUT="$(FALCON_JIRA_DIR="${FALCON_JIRA_DIR:-}" "$NODE_BIN" --input-type=module -e "
const { resolveSkill } = await import('$HERE/env.mjs');
process.stdout.write((await resolveSkill()).dir);
" 2>&1)" && FALCON_JIRA_DIR="$RESOLVE_OUT" || FALCON_JIRA_DIR=""

[ -n "$FALCON_JIRA_DIR" ] && [ -f "$FALCON_JIRA_DIR/scripts/lib/jira.mjs" ] || {
  red "Không dùng được skill jira của plugin falcon."
  # Show the resolver's own message: it names every copy it rejected and why.
  # Hiding it behind 2>/dev/null was what made this hard to diagnose.
  printf '%s\n' "$RESOLVE_OUT" | sed 's/^/  /'
  echo
  echo "  Chỉ đường thủ công nếu bạn biết bản nào đúng:"
  echo "    FALCON_JIRA_DIR=<đường-dẫn-tới-skills/jira> bash install-jira-watch.sh"
  exit 1
}
ok "plugin falcon: $FALCON_JIRA_DIR"

# ------------------------------------------------------------------- 2. token

say "2/6  Token Jira"

ENV_FILE=""
for f in "$FALCON_JIRA_DIR/.env" "$HERE/.env"; do
  if [ -f "$f" ] && grep -qE '^[[:space:]]*JIRA_TOKEN[[:space:]]*=[[:space:]]*\S' "$f"; then
    ENV_FILE="$f"
    break
  fi
done

if [ -n "$ENV_FILE" ]; then
  ok "đã có JIRA_TOKEN trong $ENV_FILE"
else
  TOKEN="${JIRA_TOKEN:-}"

  if [ -z "$TOKEN" ] && [ "$HAS_TTY" = 1 ]; then
    echo "  Tạo Personal Access Token: mở Jira → avatar → Profile → Personal Access Tokens"
    echo "  Lưu ý: token sẽ hiện ra màn hình để bạn kiểm tra, và nằm lại trong"
    echo "  lịch sử cuộn của terminal. Đóng cửa sổ terminal sau khi cài xong."
    printf '  Dán token vào đây: '
    read -r TOKEN <&3 || TOKEN=""
  fi

  if [ -z "$TOKEN" ]; then
    red "Chưa có token để dùng."
    echo "  Chạy qua ống (curl | bash) thì stdin là chính script, không gõ tay được."
    echo "  Cách 1 — truyền sẵn token:"
    echo "    JIRA_TOKEN=<token> bash -c \"\$(curl -fsSL <url>)\""
    echo "  Cách 2 — tải về rồi chạy:"
    echo "    curl -fsSLO <url> && bash install-jira-watch.sh"
    exit 1
  fi
  # Prefer the falcon skill's .env so falcon:jira can use the same token.
  ENV_FILE="$FALCON_JIRA_DIR/.env"
  touch "$ENV_FILE" && chmod 600 "$ENV_FILE"
  printf 'JIRA_TOKEN=%s\n' "$TOKEN" >> "$ENV_FILE"
  unset TOKEN
  ok "đã ghi $ENV_FILE (chmod 600)"
fi

# A token that does not authenticate makes every later step fail confusingly.
say "3/6  Thử kết nối Jira"
PROBE="$(FALCON_JIRA_DIR="$FALCON_JIRA_DIR" "$NODE_BIN" --input-type=module -e "
const { connect } = await import('$HERE/env.mjs');
const { fetchMyself, jiraFetch, env } = await connect();
const me = await fetchMyself(env);

// Teams differ: some use Jira's built-in assignee, some a custom multi-user
// field called Assignees. Ask the instance instead of hardcoding an id.
let field = '';
try {
  const { status, json } = await jiraFetch('/rest/api/2/field', { env });
  if (status === 200 && Array.isArray(json)) {
    const hit = json.find((f) => f.custom && /^assignees\$/i.test(String(f.name || '').trim()));
    if (hit) field = hit.id;
  }
} catch {}
process.stdout.write(me + '|' + field + '|' + (env.baseUrl || ''));
" 2>&1)" || { red "Không kết nối được Jira:"; echo "  $PROBE"; exit 1; }

WHOAMI="${PROBE%%|*}"
REST="${PROBE#*|}"
FIELD_ID="${REST%%|*}"
BASE_URL="${REST#*|}"
ok "đăng nhập với tài khoản: $WHOAMI"
ok "Jira: $BASE_URL"

# Without the field id the watcher would silently see nobody as assigned.
CURRENT_FIELD="$(grep -oE '^[[:space:]]*JIRA_ASSIGNEES_FIELD[[:space:]]*=[[:space:]]*\S+' "$ENV_FILE" 2>/dev/null | sed 's/.*=//' || true)"
if [ -n "$CURRENT_FIELD" ]; then
  ok "field Assignees: $CURRENT_FIELD (đã cấu hình)"
elif [ -n "$FIELD_ID" ]; then
  printf 'JIRA_ASSIGNEES_FIELD=%s\n' "$FIELD_ID" >> "$ENV_FILE"
  ok "field Assignees: $FIELD_ID (tự dò được, đã ghi vào .env)"
else
  red "Không tìm thấy custom field tên 'Assignees' trên Jira này."
  echo "  Tìm id của nó (dạng customfield_XXXXX) rồi thêm vào $ENV_FILE:"
  echo "    JIRA_ASSIGNEES_FIELD=customfield_XXXXX"
  echo "  Danh sách field: $BASE_URL/rest/api/2/field"
  exit 1
fi

# ---------------------------------------------------------------- 4. notifier

say "4/6  Dựng JiraNotify.app"

# Notifications must belong to an app we own, otherwise clicking them does
# nothing. Ad-hoc signatures are per-machine, so this is built here, not shipped.
rm -rf "$APP_DIR"
mkdir -p "$HOME/Applications"
osacompile -o "$APP_DIR" "$HERE/JiraNotify.applescript"
plutil -insert CFBundleIdentifier -string "local.jira.notify" "$APP_DIR/Contents/Info.plist" 2>/dev/null || true

ICON_TMP="$(mktemp -d)"
if curl -fsSL --max-time 15 "$BASE_URL/images/64jira.png" -o "$ICON_TMP/src.png" 2>/dev/null; then
  mkdir -p "$ICON_TMP/i.iconset"
  for s in 16 32 128 256 512; do
    sips -z $s $s "$ICON_TMP/src.png" --out "$ICON_TMP/i.iconset/icon_${s}x${s}.png" >/dev/null 2>&1 || true
  done
  cp "$ICON_TMP/i.iconset/icon_32x32.png"   "$ICON_TMP/i.iconset/icon_16x16@2x.png"  2>/dev/null || true
  cp "$ICON_TMP/i.iconset/icon_256x256.png" "$ICON_TMP/i.iconset/icon_128x128@2x.png" 2>/dev/null || true
  cp "$ICON_TMP/i.iconset/icon_512x512.png" "$ICON_TMP/i.iconset/icon_256x256@2x.png" 2>/dev/null || true
  if iconutil -c icns "$ICON_TMP/i.iconset" -o "$ICON_TMP/applet.icns" 2>/dev/null; then
    cp "$ICON_TMP/applet.icns" "$APP_DIR/Contents/Resources/applet.icns"
    ok "icon Jira"
  fi
else
  echo "  (bỏ qua icon — không tải được favicon, dùng icon mặc định)"
fi
rm -rf "$ICON_TMP"

codesign --force --deep -s - "$APP_DIR" >/dev/null 2>&1 || true
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP_DIR" >/dev/null 2>&1 || true
ok "$APP_DIR"

# ------------------------------------------------------------------- 5. state

say "5/6  Nạp danh sách task"

FALCON_JIRA_DIR="$FALCON_JIRA_DIR" "$NODE_BIN" "$HERE/watch.mjs" --init

# ------------------------------------------------------------------ 6. launchd

say "6/6  Hẹn giờ (${INTERVAL}s)"

launchctl unload "$PLIST" 2>/dev/null || true
cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.jira-watch</string>

  <!-- launchd runs with a minimal PATH, so node must be absolute. Upgrading
       node (nvm) changes this path; re-run install.sh if it breaks. -->
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$HERE/watch.mjs</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>FALCON_JIRA_DIR</key>
    <string>$FALCON_JIRA_DIR</string>
  </dict>

  <key>StartInterval</key>
  <integer>$INTERVAL</integer>

  <key>RunAtLoad</key>
  <false/>

  <key>WorkingDirectory</key>
  <string>$HERE</string>

  <key>StandardOutPath</key>
  <string>$HERE/watch.log</string>
  <key>StandardErrorPath</key>
  <string>$HERE/watch.err.log</string>
</dict>
</plist>
PLIST_EOF

launchctl load "$PLIST"
ok "đã bật, $PLIST"

# ------------------------------------------------------------------- the rest

say "Xong. Còn 1 việc phải làm bằng tay:"
cat <<'EOF'

  System Settings → Notifications → JiraNotify → Allow notifications,
  alert style chọn Alerts (Banners tự tắt sau ~5 giây, dễ lỡ).

  macOS không cho script tự cấp quyền này. Chưa bật thì mọi thứ chạy đúng
  nhưng bạn không thấy gì.

Lệnh hay dùng:

  node watch.mjs --verbose      kiểm ngay, không chờ
  node act.mjs show ABC-123     xem task
  node act.mjs comment ABC-123 "nội dung"
  node act.mjs assign ABC-123
  tail -f watch.log             sự kiện đã xảy ra
  cat last-run.txt              còn sống không
  ./uninstall.sh                gỡ sạch

EOF

# Same pipe problem as the token prompt: with no keyboard, just send it.
ANSWER=y
if [ "$HAS_TTY" = 1 ]; then
  printf 'Gửi 1 noti thử ngay bây giờ? [Y/n] '
  read -r ANSWER <&3 || ANSWER=y
fi
if [ "${ANSWER:-y}" != "n" ] && [ "${ANSWER:-y}" != "N" ]; then
  printf 'post\nJiraNotify\nCài đặt xong\nBấm vào đây để mở Jira\n%s\n' "$BASE_URL" > "$HOME/.jira-notify-payload"
  "$APP_DIR/Contents/MacOS/applet" || true
  echo "Đã gửi. Không thấy gì → quyền notification chưa bật (xem trên)."
fi
