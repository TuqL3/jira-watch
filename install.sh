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
INTERVAL="${INTERVAL:-60}"

# The notification icon. icon.icns ships with the installer already built from
# this; the URL is only the fallback for a checkout that lacks the file.
# Jira's own /images/64jira.png is 64px, which upscales badly.
ICON_URL="${ICON_URL:-https://cdn-icons-png.flaticon.com/512/5968/5968875.png}"

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

ok "không cần plugin nào — jira-watch tự chứa client Jira"

# ------------------------------------------------------------------- 2. token

say "2/6  Địa chỉ Jira và token"

ENV_FILE="$HERE/.env"
touch "$ENV_FILE" && chmod 600 "$ENV_FILE"

# The instance is baked into jira.mjs; only write a line here when overriding.
if [ -n "${JIRA_BASE_URL:-}" ] && ! grep -qE '^[[:space:]]*JIRA_BASE_URL[[:space:]]*=' "$ENV_FILE"; then
  printf 'JIRA_BASE_URL=%s\n' "$JIRA_BASE_URL" >> "$ENV_FILE"
  ok "Jira (ghi đè): $JIRA_BASE_URL"
fi

if grep -qE '^[[:space:]]*JIRA_TOKEN[[:space:]]*=[[:space:]]*\S' "$ENV_FILE"; then
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
  printf 'JIRA_TOKEN=%s\n' "$TOKEN" >> "$ENV_FILE"
  unset TOKEN
  ok "đã ghi $ENV_FILE (chmod 600)"
fi

# A token that does not authenticate makes every later step fail confusingly.
say "3/6  Thử kết nối Jira"
PROBE="$("$NODE_BIN" --input-type=module -e "
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
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

# Unregister before deleting: LaunchServices otherwise keeps the old record —
# including the icon it cached the first time — and a rebuilt app with the same
# bundle id inherits it. On one machine that meant a correct icns on disk and
# the generic applet icon everywhere.
[ -d "$APP_DIR" ] && "$LSREGISTER" -u "$APP_DIR" >/dev/null 2>&1 || true

rm -rf "$APP_DIR"
mkdir -p "$HOME/Applications"
osacompile -o "$APP_DIR" "$HERE/JiraNotify.applescript"
plutil -insert CFBundleIdentifier -string "local.jira.notify" "$APP_DIR/Contents/Info.plist" 2>/dev/null || true

# The icon ships with the installer: building one here would need iconutil,
# which comes with the Xcode command line tools and is missing on plenty of
# machines — that is how one ended up with the generic script icon. Downloading
# and converting stays as a fallback for a checkout without the file.
ICON_TMP="$(mktemp -d)"
ICON_WHY=""
if [ -f "$HERE/icon.icns" ]; then
  cp "$HERE/icon.icns" "$APP_DIR/Contents/Resources/applet.icns"
  ok "icon Jira ($(wc -c < "$HERE/icon.icns" | tr -d ' ') bytes, đi kèm sẵn)"
elif ! curl -fsSL --max-time 15 "$ICON_URL" -o "$ICON_TMP/src.png" 2>"$ICON_TMP/curl.err"; then
  ICON_WHY="không tải được $ICON_URL ($(tr -d '\n' < "$ICON_TMP/curl.err" | tail -c 80))"
elif ! command -v iconutil >/dev/null 2>&1; then
  # iconutil ships with the Xcode command line tools, which plenty of machines
  # do not have. sips is part of macOS itself and converts straight to icns —
  # one resolution instead of five, but it is a real icon.
  if sips -s format icns "$ICON_TMP/src.png" --out "$APP_DIR/Contents/Resources/applet.icns" >/dev/null 2>&1; then
    ok "icon Jira (qua sips — không có iconutil)"
  else
    ICON_WHY="không có iconutil, và sips cũng không chuyển được ảnh sang icns"
  fi
else
  mkdir -p "$ICON_TMP/i.iconset"
  for s in 16 32 128 256 512; do
    sips -z $s $s "$ICON_TMP/src.png" --out "$ICON_TMP/i.iconset/icon_${s}x${s}.png" >/dev/null 2>&1 || true
  done
  cp "$ICON_TMP/i.iconset/icon_32x32.png"   "$ICON_TMP/i.iconset/icon_16x16@2x.png"  2>/dev/null || true
  cp "$ICON_TMP/i.iconset/icon_256x256.png" "$ICON_TMP/i.iconset/icon_128x128@2x.png" 2>/dev/null || true
  cp "$ICON_TMP/i.iconset/icon_512x512.png" "$ICON_TMP/i.iconset/icon_256x256@2x.png" 2>/dev/null || true

  if ! iconutil -c icns "$ICON_TMP/i.iconset" -o "$ICON_TMP/applet.icns" 2>"$ICON_TMP/icon.err"; then
    ICON_WHY="iconutil lỗi: $(tr -d '\n' < "$ICON_TMP/icon.err" | tail -c 120)"
  else
    cp "$ICON_TMP/applet.icns" "$APP_DIR/Contents/Resources/applet.icns"
    # An .icns that exists but is tiny means the conversion produced nothing usable.
    ICON_BYTES="$(wc -c < "$APP_DIR/Contents/Resources/applet.icns" | tr -d ' ')"
    if [ "$ICON_BYTES" -lt 5000 ]; then
      ICON_WHY="icns chỉ $ICON_BYTES bytes — quá nhỏ, có thể ảnh nguồn hỏng"
    else
      ok "icon Jira ($ICON_BYTES bytes)"
    fi
  fi
fi
[ -z "$ICON_WHY" ] || printf '  \033[33m⚠\033[0m  dùng icon mặc định — %s\n' "$ICON_WHY"
rm -rf "$ICON_TMP"

# osacompile ad-hoc signs the applet, and that signature covers applet.icns.
# Swapping the icon afterwards invalidates it, and macOS then falls back to the
# generic applet icon — which is exactly what happened on a machine without the
# Xcode command line tools, where codesign cannot re-sign. If we cannot re-sign,
# strip the signature instead: no signature beats a broken one.
if codesign --force --deep -s - "$APP_DIR" >/dev/null 2>&1; then
  ok "đã ký lại app (chữ ký phủ đúng icon mới)"
elif codesign --remove-signature "$APP_DIR" >/dev/null 2>&1; then
  printf '  \033[33m⚠\033[0m  không ký lại được — đã gỡ chữ ký để icon không bị bỏ qua\n'
else
  printf '  \033[33m⚠\033[0m  codesign không dùng được; icon có thể không hiện\n'
fi
"$LSREGISTER" -f "$APP_DIR" >/dev/null 2>&1 || true

# macOS caches app icons per bundle id, and the notification daemon keeps its
# own copy — reinstalling over the same id otherwise keeps showing whatever icon
# the very first install had. Both daemons relaunch by themselves; the Dock
# flickers for a second.
#
# Notifications already sitting in Notification Center keep the icon they were
# posted with, so old ones still look wrong. Only new ones change.
touch "$APP_DIR"
killall Dock >/dev/null 2>&1 || true
killall NotificationCenter >/dev/null 2>&1 || true
killall usernoted >/dev/null 2>&1 || true
ok "$APP_DIR"

# ------------------------------------------------------------------- 5. state

say "5/6  Nạp danh sách task"

"$NODE_BIN" "$HERE/watch.mjs" --init

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
