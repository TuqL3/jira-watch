# jira-watch

Thông báo trên macOS khi task Jira của bạn có thay đổi. Bấm vào noti là mở thẳng task.

```
ABC-123 · Alice Nguyen
Sửa màn hình báo cáo, thêm bộ lọc theo tháng
đã fix xong rồi nhé, anh review giúp em
```

Bắt 3 loại thay đổi trên task bạn được assign, report, hoặc watch:

- đổi status — `To Do → In Progress`
- có comment mới — kèm nội dung comment
- bạn được thêm vào Assignees

**Không báo thay đổi do chính bạn gây ra.**

## Cài

**Cách 1 — một dòng lệnh:**

```bash
curl -fsSL https://github.com/TuqL3/jira-watch/releases/latest/download/install-jira-watch.sh | bash
```

File tải về tự chứa toàn bộ mã nguồn, giải nén vào `~/Projects/jira-watch` rồi cài.
Không cần git, không cần clone.

Cài không qua terminal tương tác (hoặc muốn khỏi gõ tay):

```bash
JIRA_TOKEN=<token> bash -c "$(curl -fsSL https://github.com/TuqL3/jira-watch/releases/latest/download/install-jira-watch.sh)"
```

Ngại chạy thẳng script từ Internet thì tải về đọc trước:

```bash
curl -fsSLO https://github.com/TuqL3/jira-watch/releases/latest/download/install-jira-watch.sh
less install-jira-watch.sh
bash install-jira-watch.sh
```

```bash
TARGET=~/tools/jira-watch bash install-jira-watch.sh   # đổi chỗ cài
INTERVAL=60 bash install-jira-watch.sh                 # quét thưa hơn
EXTRACT_ONLY=1 bash install-jira-watch.sh              # chỉ giải nén, xem trước
```

**Cách 2 — clone repo:**

```bash
git clone https://github.com/TuqL3/jira-watch.git ~/Projects/jira-watch
cd ~/Projects/jira-watch
./install.sh
```

Cần trước: macOS, Node >= 18, và một Personal Access Token Jira
(mở Jira → avatar → Profile → Personal Access Tokens). Không cần plugin nào.

Script sẽ hỏi token, dựng app thông báo, nạp danh sách task, bật lịch chạy.
Khoảng 1 phút.

### Sau khi cài phải làm 1 việc bằng tay

**System Settings → Notifications → JiraNotify → Allow notifications**, alert style
chọn **Alerts**.

macOS không cho script tự cấp quyền này. Chưa bật thì mọi thứ chạy đúng, log ghi
đủ, nhưng bạn không thấy gì trên màn hình.

## Dùng

```bash
node watch.mjs --verbose            # kiểm ngay, không chờ tới nhịp
node act.mjs show     ABC-123       # status + assignees
node act.mjs comment  ABC-123 "nội dung"
node act.mjs assign   ABC-123       # thêm mình vào Assignees
node act.mjs assign   ABC-123 --user bob
node act.mjs unassign ABC-123
tail -f watch.log                   # sự kiện đã xảy ra
cat last-run.txt                    # còn sống không
./uninstall.sh
```

Thêm `--dry-run` vào lệnh ghi để xem payload mà không gửi.

## Nhịp quét

Mặc định **10 giây** — đây cũng là sàn của launchd. Đặt nhỏ hơn không có tác dụng:
launchd chặn không cho cùng một job chạy dày hơn ~10 giây, đo thật thì
`StartInterval=5` vẫn ra khoảng cách 7–11 giây.

Muốn thưa hơn cho nhẹ Jira:

```bash
INTERVAL=60 ./install.sh
```

Jira là instance dùng chung cả công ty:

| Người dùng | 60s | 10s |
|---|---|---|
| 1 | 1.440 req/ngày | 8.640 |
| 10 | 14.400 | **86.400** |

Muốn dày hơn 10 giây thì phải đổi sang daemon chạy thường trực — launchd không làm
được, và lúc đó mất cái lợi "mỗi lần chạy là một tiến trình sạch".

Cửa sổ quét là 90 phút (rộng hơn nhịp rất nhiều) nên máy ngủ dậy vẫn bắt kịp,
không sót sự kiện.

## Tuỳ chọn

| Biến | Tác dụng |
|---|---|
| `JIRA_INCLUDE_MINE=1` | báo cả thay đổi do chính bạn |
| `JIRA_SOUND=1` | kêu 1 tiếng mỗi sự kiện |
| `JIRA_NOTIFIER=osascript` | không dùng app riêng — noti vẫn hiện nhưng **bấm không mở được task** |
| `JIRA_BASE_URL=<url>` | Jira khác instance mặc định |
| `JIRA_WATCH_ENV=<path>` | file .env nằm chỗ khác |

## Vì sao cần `JiraNotify.app`

`osascript` gửi noti được, nhưng noti đó thuộc về Script Editor — bấm vào không
làm gì cả. Muốn bấm mở task thì noti phải thuộc về một app mình kiểm soát.

`JiraNotify.app` là applet AppleScript ~40 dòng, `install.sh` tự biên dịch tại máy
bạn. Không dựng sẵn rồi phát vì chữ ký ad-hoc chỉ hợp lệ trên máy tạo ra nó.

`terminal-notifier` đã thử và loại: nó trả exit code 0 nhưng không giao noti nào
trên macOS 15.

## Cách hoạt động

```
launchd ──(mỗi 60s)──> watch.mjs
                          │  1 JQL lấy task liên quan tới bạn, sửa trong 90 phút qua
                          │  so với state.json
                          │  có khác → hỏi changelog xem ai sửa
                          │  không phải bạn → ghi payload, chạy JiraNotify.app
                          ▼
                       notification ──(bấm)──> mở <jira>/browse/ABC-xxx
```

Client Jira nằm trong `jira.mjs` (~90 dòng: đọc config, fetch kèm Bearer, `myself`).
Trước đây phần này mượn thư viện của plugin `falcon` và gãy hai lần trong một giờ khi
thư viện đó được sắp xếp lại — nên giờ tự chứa, không phụ thuộc plugin nào.

## Icon thông báo

`icon.icns` đóng gói sẵn trong file cài — không tải gì lúc cài, không cần
`iconutil` (nó thuộc Xcode Command Line Tools, nhiều máy không có).

Đổi icon khác:

```bash
./make-icon.sh anh-cua-ban.png icon.icns   # PNG 512px, nền trong suốt
./release.sh v1.1.5 "Đổi icon"
```

macOS cache icon theo bundle id, nên `install.sh` khởi động lại `Dock`,
`NotificationCenter` và `usernoted` sau khi dựng app. **Noti cũ vẫn giữ icon lúc
nó được tạo** — chỉ noti mới đổi.

## Tự cập nhật

Mỗi 6 tiếng, watcher hỏi GitHub xem có bản mới không. Có thì **báo một noti**,
bấm vào mở trang release. Cập nhật = chạy lại lệnh cài.

Muốn nó tự cài luôn, thêm vào plist:

```
JIRA_AUTO_UPDATE=1
```

Mặc định **không** tự cài, vì `install.sh` khởi động lại `Dock` và
`NotificationCenter` — đang làm việc mà Dock nháy thì khó chịu.

Tắt hẳn: `JIRA_NO_UPDATE_CHECK=1`.

Bản đang chạy nằm ở file `VERSION`. Mạng hỏng thì bỏ qua, 6 tiếng sau thử lại —
không bao giờ làm chậm phần thông báo.

## Giới hạn đã biết

- **macOS only.** Dùng `launchd` + `osascript`.
- **Bấm noti cũ sẽ mở task mới nhất.** Applet chỉ giữ 1 URL. AppleScript không cho gắn định danh vào từng noti.
- **Thread dài** bị Jira cắt bớt comment: vẫn báo "có comment mới" nhưng tên người hiện là "ai đó".
- **Không xác định được ai sửa thì vẫn báo.** Bỏ sót việc của người khác tệ hơn nhận thừa noti của chính mình.
- **Assign là read-modify-write.** Hai người sửa Assignees trong cùng một giây có thể mất một thay đổi.
- **Đường dẫn node cắm vào plist lúc cài.** Nâng node (nvm) là gãy — chạy lại `./install.sh`. Lỗi sẽ hiện trong `watch.err.log`.
- **`act.mjs` chưa được test ghi thật nhiều.** Dùng `--dry-run` trước khi tin.

## Phát bản mới

```bash
./release.sh v1.0.1 "Sửa lỗi X"
```

Dựng bundle → tạo tag → tạo GitHub Release → upload bundle làm asset. Từ chối chạy
nếu working tree còn thay đổi chưa commit, vì như vậy là phát hành thứ không nằm
trên commit nào.

Xong là `releases/latest/download/install-jira-watch.sh` trỏ sang bản mới, lệnh
`curl` ở trên không đổi.

Chỉ dựng bundle mà không phát hành:

```bash
./build.sh          # -> dist/install-jira-watch.sh
```

`dist/` **không commit**. File sinh ra nằm trong git sẽ cũ đi ngay khi ai đó sửa mã
nguồn mà quên dựng lại; asset gắn với tag thì luôn khớp đúng tag đó.

Kiểm bundle khớp mã nguồn:

```bash
EXTRACT_ONLY=1 TARGET=/tmp/jw bash dist/install-jira-watch.sh
for f in watch.mjs act.mjs env.mjs jira.mjs JiraNotify.applescript uninstall.sh; do
  diff -q "$f" "/tmp/jw/$f" || echo "LỆCH: $f"
done
```

## Kiểm tra code

```bash
node watch.mjs --selftest    # logic phát hiện thay đổi
node act.mjs   --selftest    # merge/remove assignee
node jira.mjs  --selftest    # parse .env, config
```

Fail thì exit code khác 0 (`console.assert` một mình không làm được điều đó).

## Field riêng của team

Team dùng custom field **Assignees**, không dùng field `assignee` chuẩn của Jira —
field đó luôn rỗng. `install.sh` tự hỏi Jira để tìm id của nó. Mọi thao tác assign đều **thêm vào
mảng**, không ghi đè, để không đá đồng nghiệp ra khỏi task.
