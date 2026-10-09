# Lane routing — luồng refresh / xác minh lại

Mục tiêu: tối thiểu rủi ro drift fingerprint khi làm việc với tài khoản OpenAI đã tạo. Signup luôn chạy qua trình duyệt thật; refresh/regenerate chọn lane theo **tài khoản**, không theo người bấm.

Toàn bộ chính sách tập trung ở hàm `chooseRefreshLane(job)` trong [src/console-server.mjs](../src/console-server.mjs). File này mô tả **vì sao**, **khi nào**, và cách **vận hành**.

## Bối cảnh

OpenAI dấu vân (fingerprint) rất kỹ: TLS JA3/JA4, UA, Client Hints, Sentinel env, oai-did, cookie history. Khi lần đăng nhập đầu tiên của một acc dùng Chromium thật, server lưu lại pattern đó và dự kiến thấy lại ở các lần sau. Nếu lần kế tiếp đến từ `curl_cffi` (TLS khác, không có canvas/WebGL, không có Service Worker), server tăng risk score cho session. Risk score đủ cao → OpenAI revoke refresh_token hoặc force reauth.

Hai cơ chế refresh tồn tại trong repo:

- **Browser lane** (`src/browser-login.mjs`): mở Chromium persistent với `userDataDir` per-account tại `tmp/chatgpt-onboarding/browser-profiles/<hash>/`. Cookie, localStorage, IndexedDB, Service Worker đều có sẵn, chatgpt.com nhận ra phiên cũ và không bật login modal.
- **TLS lane** (`src/protocol-login.mjs` + `src/tls-transport.mjs`): gọi thẳng `/oauth/token` với `grant_type=refresh_token` qua `curl_cffi` giả lập Chrome 146 / Chrome 150. Nhanh, không mở trình duyệt. Không chạy JS, không giải Cloudflare challenge.

Chi phí và rủi ro trái dấu: browser đắt nhưng khớp vân, TLS rẻ nhưng là tín hiệu drift tiềm năng.

## Chính sách

Chọn lane theo thứ tự ưu tiên dưới (áp dụng tại `chooseRefreshLane`):

1. `job.forceBrowserVerifyRequested === true` → **browser + full** (one-shot override).
2. `job.source === 'external'` → **browser + full** (acc nhập ngoài không có browser profile sẵn, cần "stamp" bằng Chromium ít nhất 1 lần).
3. `!job.signupCompletedAt` → **browser + full** (signup chưa xong, không có refresh_token để dùng).
4. `now - signupCompletedAt < 60 * 86400_000` → **browser + full** (acc còn non, trust score thấp).
5. Còn lại → **TLS + refresh** (acc chín, dùng curl rẻ nhất).

Cutoff đọc từ env `TOSUB2_REFRESH_BROWSER_AGE_DAYS` (mặc định 60). `signup_completed_at` được set đúng **1 lần** tại `handleChildClose` khi `sub2api-import-oauth.json` ghi xuống disk ở lần signup đầu tiên. Các lần refresh/relogin sau **không** ghi đè — tuổi acc là tuổi tính từ lần signup gốc.

## Bảng phân luồng

| Thao tác | Lane | Mode | Lý do |
|---|---|---|---|
| Signup tài khoản mới | browser | full | Sentinel/Arkose + OAuth callback cần DOM thật. Enforce qua `resolveSignupBackend`. |
| Refresh/regenerate — `source=system`, < 60 ngày | browser | full | Fingerprint chưa cố định, TLS refresh dễ bị đọc là drift. |
| Refresh/regenerate — `source=system`, ≥ 60 ngày | TLS | refresh | Vân acc ổn định, refresh_token tin cậy, curl là rẻ nhất. |
| Refresh/regenerate — `source=external` | browser | full | Chưa có `userDataDir` nội bộ, phải tạo lại qua Chromium. |
| Curl trả `REFRESH_TOKEN_INVALID` / `invalid_grant` | browser | full | `fallbackFromRefresh` set `forceBrowserVerifyRequested=true` + enqueue full. |
| Operator bấm nút **Force Browser Verify** | browser | full | One-shot override — bỏ qua cutoff tuổi + rule nguồn. Flag tự clear sau khi completed. |
| 2FA setup / add-password | TLS | tùy flow | Giữ lane cũ, không áp dụng `chooseRefreshLane`. |

## Sơ đồ quyết định

```
                           ┌───────────────────────┐
   User bấm "Regenerate"  ─►│  chooseRefreshLane()  │
   (hoặc auto-repair)      └──────────┬────────────┘
                                      │
                 ┌────────────────────┼─────────────────────┐
                 ▼                    ▼                     ▼
       forceVerify=true?      source='external'?       !signup_completed_at
                 │                    │                     │
                 └────────── browser + full ◄──────────────┘
                                      │
                                      ▼
                      age = now - signup_completed_at
                                      │
                        ┌─────────────┴──────────────┐
                        ▼                            ▼
                   age < 60d                     age >= 60d
                        │                            │
                 browser + full               tls + refresh
                                                     │
                                                     ▼
                                        worker stdout chứa
                                        REFRESH_TOKEN_INVALID?
                                                     │
                                        ┌────────────┴────────────┐
                                        ▼ no                      ▼ yes
                                     DONE                  fallbackFromRefresh:
                                                           set force flag →
                                                           browser + full
```

## Nút "Buộc xác minh qua trình duyệt" (Force Browser Verify)

Endpoint: `POST /api/jobs/:id/force-browser-verify` (nhận `{proxyUrl?}` tùy chọn).
Batch endpoint: `POST /api/jobs/force-browser-verify-batch` (nhận `{ids: string[], proxyUrl?}`).

Dành cho các trường hợp sau:

- Acc vừa qua mốc 60 ngày nhưng nghi fingerprint lệch (vừa đổi engine, đổi profile Chromium, hoặc proxy IP tier khác xa).
- Acc đang `completed` nhưng Sub2API monitor trả 401 bất thường trong khi curl refresh vẫn pass → ép browser verify để chắc chắn.
- Operator biết trước TLS không đủ cho ca này (ví dụ cookie trong profile đã expired, chỉ còn refresh_token).
- Troubleshoot: so sánh output browser vs TLS khi điều tra sự cố.

Flag `force_browser_verify_requested` persist trong metadata (JSON file + DB column). Sau khi job `completed` thành công, flag được xóa trong `handleChildClose` để lần refresh kế tiếp áp lại chính sách mặc định.

## Phân biệt nguồn account (`source`)

Cột `source` trong bảng `jobs`:

- `system` (mặc định): tài khoản do console tự signup qua `/api/jobs`, `/api/jobs/batch`, `/api/jobs/stage`. Có fingerprint stack đầy đủ, có `userDataDir` Chromium, có checkpoint.
- `external`: tài khoản được nhập từ ngoài (hiện chưa có endpoint public — reserved cho tương lai). Luôn phải chạy browser verify ít nhất 1 lần để tạo profile Chromium cục bộ trước khi chuyển sang TLS lane an toàn.

Cột được set tại thời điểm tạo job, không auto-flip. Nếu operator biết acc external đã an toàn chuyển sang TLS, dùng helper `jobDao.setSource(id, 'system')` để đổi.

## Backfill cho dữ liệu cũ

Migration `004_job_source_and_signup_completed_at` làm 2 việc:

1. Thêm cột `source TEXT NOT NULL DEFAULT 'system'` và `signup_completed_at TEXT`.
2. Backfill `signup_completed_at = COALESCE(registered_at, completed_at, updated_at)` cho các row có `result_saved = 1 AND output_path IS NOT NULL`.

Lưu ý: `updated_at` có thể đã bị relogin ghi đè nhiều lần → một số acc thực sự >60 ngày có thể bị classify <60 ngày sau migration → bị ép browser thay vì TLS lần đầu refresh. **Không nguy hiểm** (chỉ tốn tài nguyên, không mất acc); vài vòng refresh sau sẽ tự ổn.

## Env vars liên quan

| Variable | Default | Purpose |
|---|---|---|
| `TOSUB2_REFRESH_BROWSER_AGE_DAYS` | `60` | Cutoff tuổi acc (ngày) để `chooseRefreshLane` cho phép TLS refresh |
| `TOSUB2_ALLOW_TLS_SIGNUP` | `0` | Dev-only; `1` cho phép client ép signupBackend='tls' |
| `TOSUB2_SIGNUP_BACKEND` | `browser` | Fallback label — không còn ảnh hưởng mặc định signup (giữ cho debug) |

## Tune cutoff

Theo dõi tỷ lệ fallback (curl → browser escalation) trong 2 tuần đầu:

- Nếu > 20% refresh phải fallback → cutoff đang quá thấp, acc chưa đủ chín, giảm xuống 45 ngày.
- Nếu < 2% fallback → cutoff đang cao hơn mức cần, có thể tăng lên 90 ngày để tiết kiệm browser session.

Chỉnh qua env `TOSUB2_REFRESH_BROWSER_AGE_DAYS`, không cần redeploy — chỉ cần restart server đọc env mới.

Log grep nhanh để đo:
```bash
pm2 logs toSub2 --nostream --lines 2000 | grep -cE "REFRESH_TOKEN_INVALID"
pm2 logs toSub2 --nostream --lines 2000 | grep -cE "刷新令牌已失效，自动回退到浏览器"
```

## Rủi ro & cạm bẫy

- **Deploy order**: migration 004 chạy trong `runMigrations` khi server khởi động. Nếu PM2 rolling-reload, process cũ có thể đọc DB không có cột `source` và throw ở `jobDao.update`. Khuyến nghị: `pm2 stop → pm2 start`, không dùng `pm2 reload`.
- **Backfill không hoàn hảo**: `COALESCE(registered_at, completed_at, updated_at)` có thể cho timestamp lớn hơn thực tế vì `updated_at` đổi mỗi lần relogin. Lớp policy vẫn an toàn (sai số đẩy về phía browser lane = tốn hơn chứ không nguy hiểm).
- **External import endpoint chưa có**: cột `source='external'` reserved cho tương lai. Nếu ship endpoint sau, nhớ set `source='external'` + `signup_completed_at=null` khi insert để `chooseRefreshLane` nhận ra.
- **2FA / add-password vẫn TLS**: hai flow này không đi qua `chooseRefreshLane`. Nếu acc < 60 ngày cần setup 2FA thì vẫn chạy TLS lane như cũ.
- **Race điều kiện giữa fallback và force**: user bấm "Force Browser Verify" đúng lúc worker đang refresh và `fallbackFromRefresh` vừa set flag → cả hai cùng enqueue. `withEmailJobLock` serialize các action này, enqueue thứ hai thấy `canForceRelogin===false` sẽ bị 409 — operator chỉ cần đợi.
