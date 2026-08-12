#!/bin/bash
# Remove everything install.sh created. Keeps your Jira token by default.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$HOME/Applications/JiraNotify.app"
PLIST="$HOME/Library/LaunchAgents/com.jira-watch.plist"

ok() { printf '\033[32m✓\033[0m %s\n' "$1"; }

launchctl unload "$PLIST" 2>/dev/null || true
rm -f "$PLIST" && ok "đã gỡ lịch chạy"

rm -rf "$APP_DIR" && ok "đã xoá JiraNotify.app"

rm -f "$HERE/state.json" "$HERE/watch.log" "$HERE/watch.err.log" "$HERE/last-run.txt"
rm -f "$HOME/.jira-notify-payload" /tmp/jira-notify-click.log
ok "đã xoá state và log"

echo
echo "Giữ nguyên: dòng JIRA_TOKEN trong file rc của shell (skill falcon:jira vẫn dùng nó)."
echo "Muốn xoá hẳn thì tự xoá dòng đó trong ~/.zshrc hoặc ~/.bashrc."
