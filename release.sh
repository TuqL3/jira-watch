#!/bin/bash
# Cut a release: build the bundle, tag the commit, publish the bundle as a
# release asset so people can curl it.
#
#   ./release.sh v1.0.0
#   ./release.sh v1.0.1 "Sửa lỗi X"
#
# The bundle is deliberately not committed — a generated file in git goes stale
# the moment someone edits a source and forgets to rebuild. A release asset is
# pinned to a tag instead, so what people download always matches that tag.
#
# Needs a GitHub token: GH_TOKEN, or whatever git already stored in the keychain.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERSION="${1:-}"
NOTES="${2:-}"
ASSET="$HERE/dist/install-jira-watch.sh"

red() { printf '\033[31m%s\033[0m\n' "$1"; }
ok()  { printf '\033[32m✓\033[0m %s\n' "$1"; }

[ -n "$VERSION" ] || { red "Dùng: ./release.sh v1.0.0 [\"ghi chú\"]"; exit 1; }
[[ "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { red "Version phải dạng vX.Y.Z, nhận được: $VERSION"; exit 1; }

# Releasing a dirty tree publishes something that exists on no commit.
[ -z "$(git -C "$HERE" status --porcelain)" ] || {
  red "Working tree còn thay đổi chưa commit:"
  git -C "$HERE" status --short
  exit 1
}

TOKEN="${GH_TOKEN:-$(printf 'protocol=https\nhost=github.com\n\n' | git credential-osxkeychain get 2>/dev/null | grep '^password=' | cut -d= -f2- || true)}"
[ -n "$TOKEN" ] || { red "Không có GitHub token. Đặt GH_TOKEN=... rồi chạy lại."; exit 1; }

SLUG="$(git -C "$HERE" remote get-url origin | sed -E 's#.*github\.com[:/]##; s#\.git$##')"
ok "repo: $SLUG"

# The asset must be built from exactly the commit being tagged, and stamped with
# the version about to be cut — build.sh would otherwise read `git describe` and
# write the previous release into the bundle, so every install would immediately
# think it was one version behind.
JW_VERSION="$VERSION" "$HERE/build.sh" >/dev/null
ok "bundle: $(wc -c < "$ASSET" | tr -d ' ') bytes"

if git -C "$HERE" rev-parse "$VERSION" >/dev/null 2>&1; then
  red "Tag $VERSION đã tồn tại."
  exit 1
fi
git -C "$HERE" tag -a "$VERSION" -m "${NOTES:-Release $VERSION}"
git -C "$HERE" push -q origin "$VERSION"
ok "tag $VERSION đã đẩy"

BODY="$(printf '%s\n\nCài đặt:\n\n```bash\ncurl -fsSL https://github.com/%s/releases/latest/download/install-jira-watch.sh | bash\n```' \
  "${NOTES:-Release $VERSION}" "$SLUG")"

RELEASE="$(curl -sS -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/$SLUG/releases" \
  -d "$(printf '{"tag_name":"%s","name":"%s","body":%s}' "$VERSION" "$VERSION" \
        "$(printf '%s' "$BODY" | "$HERE/.json-escape" 2>/dev/null || node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(s)))' <<< "$BODY")")")"

RELEASE_ID="$(printf '%s' "$RELEASE" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write(String(j.id||""))})')"
[ -n "$RELEASE_ID" ] || { red "Tạo release thất bại:"; printf '%s\n' "$RELEASE" | head -5; exit 1; }
ok "release $VERSION (id $RELEASE_ID)"

UPLOAD="$(curl -sS -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/x-shellscript" \
  --data-binary @"$ASSET" \
  "https://uploads.github.com/repos/$SLUG/releases/$RELEASE_ID/assets?name=install-jira-watch.sh")"

STATE="$(printf '%s' "$UPLOAD" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).state||"")}catch{}})')"
[ "$STATE" = "uploaded" ] || { red "Upload asset thất bại:"; printf '%s\n' "$UPLOAD" | head -5; exit 1; }
ok "asset install-jira-watch.sh đã lên"

printf '\nLệnh cài cho mọi người:\n\n  curl -fsSL https://github.com/%s/releases/latest/download/install-jira-watch.sh | bash\n\n' "$SLUG"
