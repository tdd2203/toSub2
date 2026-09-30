# Quy chuẩn chung — commit và phiên bản

Dùng chung cho mọi dự án. File này không nói về dự án nào: tên file, lệnh, đường dẫn
cụ thể nằm ở **phần riêng** của từng dự án, dựng khi bắt đầu code (mục 4).

- Mục 1–3 giữ nguyên ở mọi dự án. Dự án muốn lệch một luật thì ghi rõ luật nào và vì
  sao ở phần riêng; không ghi thì luật chung đứng.
- Mỗi dự án chép nguyên văn file này vào `docs/` của mình. Muốn đổi luật chung thì sửa
  bản chung rồi chép lại cho các dự án, không sửa riêng một bản chép.

---

## 1. Commit

### 1.1 Không để lại dấu vết AI

- Không có trailer `Co-Authored-By` của máy (Claude, Cursor, Copilot, bot...).
- Không có dòng `Generated with ...`, không dùng emoji trong message.
- Không nhắc Claude, Anthropic, AI hay trợ lý ở cả tiêu đề lẫn thân.
- Tác giả commit luôn là chủ dự án, không thêm ai khác: không đổi `git config
  user.name` / `user.email` sang danh tính khác.

Áp dụng cả cho mô tả pull request. Luật này **đè lên** mặc định của công cụ viết
code (mặc định gắn trailer đồng tác giả và dòng "Generated with").

### 1.2 Tiêu đề

Dạng `loại(phạm vi): mô tả`, tiếng Việt, tối đa 72 ký tự, không có dấu chấm cuối.

| Loại | Dùng khi |
|---|---|
| `feat` | thêm tính năng mới |
| `fix` | sửa lỗi |
| `perf` | chạy nhanh hơn, nhẹ hơn |
| `refactor` | đổi cấu trúc code, hành vi giữ nguyên |
| `style` | chỉ đổi giao diện hoặc định dạng, logic giữ nguyên |
| `test` | thêm hoặc sửa test |
| `docs` | tài liệu |
| `chore` | việc vặt: tăng phiên bản, cập nhật thư viện, cấu hình build |
| `revert` | hoàn tác một commit trước |

- **Phạm vi**: tên tính năng theo cách người dùng gọi (`cài đặt`, `đăng nhập`,
  `báo cáo`), không phải tên thư mục. Bỏ phạm vi nếu thay đổi không thuộc tính
  năng nào.
- **Mô tả**: kết quả người dùng thấy, không mô tả thao tác trên file.

### 1.3 Thân

- Mặc định không viết thân. Tiêu đề đủ hiểu thì chỉ cần tiêu đề.
- Chỉ thêm thân khi đọc riêng tiêu đề vẫn không hiểu, và chỉ 1 dòng ngắn.
- Viết dễ hiểu: không nhắc ngày của sự cố cũ, không dùng thuật ngữ nội bộ.
- Không kể đã sửa file hay hàm nào, không dán kết quả test, không chép log.
- Không dùng gạch dài (—), không viết hoa cả từ để nhấn mạnh.

### 1.4 Dữ liệu nhạy cảm

- Không ghi mật khẩu, token hay số điện thoại vào commit.
- Email khách chỉ ghi phần trước `@`.

### 1.5 Khi nào commit

- Mỗi commit chỉ làm một việc, không gộp các thay đổi không liên quan.
- **Làm xong việc nào thì commit ngay việc đó**, không chờ được nhắc. Nhiều thiết bị chạy
  song song, GitHub là đường duy nhất giữa chúng: việc chưa commit thì máy kia không thấy.
- Nhiều phiên chung một cây làm việc thì chỉ commit file của mình:
  `git commit -m "..." -- <đường dẫn>`. `git commit` trần cuốn luôn file staged của
  phiên khác.
- Push thì vẫn hỏi trước.

### 1.6 Ví dụ

Đạt:

```text
feat(cài đặt): đặt và đổi mật khẩu ngay trong tài khoản
fix(đăng nhập): mở lại đúng trang đang xem sau khi đăng nhập
perf: các trang danh sách mở nhanh hơn
docs: ghi quy tắc commit và phiên bản
```

Không đạt: tiêu đề quá 72 ký tự · có thân dù tiêu đề đã đủ hiểu · thân kể từng
file · có trailer co-author · có dòng `Test: 86 passed`.

---

## 2. Phiên bản

### 2.1 Cách đánh số: `MAJOR.MINOR.PATCH`, đếm như công-tơ-mét

Mỗi lần phát hành tăng số cuối thêm 1, dù là tính năng, sửa lỗi hay bảo trì.

| Phần | Tối đa | Tăng khi |
|---|---|---|
| PATCH (`0.0.x`) | 9999 | mỗi lần phát hành |
| MINOR (`0.x.0`) | 9999 | PATCH vượt 9999 |
| MAJOR (`x.0.0`) | không giới hạn | MINOR vượt 9999 |

Vượt trần thì phần đó về 0 và nhớ 1 sang phần cao hơn: `0.2.9999` lên `0.3.0`,
`0.9999.9999` lên `1.0.0`. Không nhảy cóc, không tự tay tăng MINOR hay MAJOR, trừ
đúng một lần lên chính thức (mục 2.2). Số đã phát hành thì không dùng lại và không
sửa. Loại thay đổi ghi ở `kind` của mục changelog, không thể hiện qua số.

### 2.2 Beta và chính thức

Giai đoạn đọc từ số đầu, không khai ở đâu khác và không gắn đuôi kiểu `-beta`:

| Số | Giai đoạn | Giao diện hiện |
|---|---|---|
| `0.x.y` | Beta: đã có người dùng thật, còn có thể đổi | `Phiên bản 0.2.17 · Beta` |
| từ `1.0.0` | Chính thức | `Phiên bản 1.0.0` |

Gọi là Beta, không gọi "dev": dev là bản chạy trên máy lập trình, còn bản Beta đã
có người dùng thật.

Lên chính thức là lần duy nhất số được nhảy: lệnh tăng số có tham số `chinh-thuc`
đổi `0.x.y` thẳng thành `1.0.0`, rồi viết mục changelog như mọi lần. Đã từ `1.0.0`
trở lên thì lệnh đó báo lỗi. **Việc lên chính thức do chủ dự án quyết, không tự làm.**

### 2.3 Một nguồn duy nhất

Số phiên bản chỉ khai ở một chỗ: file khai báo gói của dự án (Node là `"version"`
trong `package.json`; lockfile do trình quản lý gói tự chép theo). Chỗ nào khác cần
số (giao diện, manifest) thì đọc từ đó, không chép tay sang nơi khác.

### 2.4 Các bước khi tăng phiên bản

1. Chạy lệnh tăng số của dự án: đổi sang số liền sau (tự nhớ khi chạm trần) ở cả
   file khai báo lẫn lockfile, không tự tạo commit hay tag. Không dùng
   `npm version patch` trần: nó không biết trần 9999.
2. Thêm một mục lên **đầu** changelog (mới nhất nằm trên cùng).
3. Phát hành bằng lệnh phát hành của dự án.

Nhiều phiên chung một cây thì hai phiên có thể cùng tăng một số. Chặn bằng mã thoát:
`git diff --quiet -- <file khai số> <lockfile> <file changelog> && <lệnh tăng số>`.

### 2.5 Cách viết một mục changelog

Viết ngắn như ghi chú cập nhật của hãng điện thoại:

- `version`, `date` (`yyyy-MM-dd`) và `kind` (`feature`, `fix` hoặc `chore`).
- `title`: 1 đến 3 từ, không có dấu hai chấm. Ví dụ: "Mời thành viên", "Ổn định",
  "Bảo mật".
- `note`: đúng một câu, khoảng 90 ký tự trở xuống, nói kết quả người dùng thấy.
- Không gạch đầu dòng, không kể nguyên nhân kỹ thuật, không ghi tên file, tên hàm
  hay số giây chờ. Nhiều thay đổi nhỏ cùng nhóm thì gộp thành một câu.

### 2.6 Commit tăng phiên bản

Tách riêng một commit, chỉ chứa phần tăng số và changelog. Tiêu đề ghi số phiên
bản kèm kết quả chính, vẫn giữ tối đa 72 ký tự:

```text
chore: 0.2.0 thêm trang báo cáo theo tháng
```

---

## 3. Chốt chặn máy — dự án nào cũng phải có

Luật chỉ nằm trên giấy thì không ai gác. Bốn thứ dưới đây gác phần đếm được; phần còn
lại ("nói kết quả người dùng thấy", "không kể nguyên nhân kỹ thuật") là việc của người
viết.

| Chốt | Làm gì |
|---|---|
| **Hook `commit-msg`** | **Cắt**, không hỏi: trailer `Co-Authored-By` và dòng `Generated with`. **Cảnh báo**, không chặn: tiêu đề sai dạng, quá 72 ký tự (đếm ký tự, không đếm byte), có dấu chấm cuối; thân quá một dòng; có gạch dài; nhắc tên công cụ AI. Bỏ qua commit git tự sinh (merge, revert, fixup). |
| **Hàm đếm phiên bản** | Tách số, tính số liền sau có nhớ, tính bước lên chính thức. Không import gì, để lệnh tăng số chạy thẳng được. Có test riêng cho các mốc trần. |
| **Lệnh tăng số** | Dùng hàm đếm để tính số mới, để trình quản lý gói ghi vào file khai báo và lockfile, không tạo commit hay tag. Tham số `chinh-thuc` lên `1.0.0` một lần; đã chính thức thì báo lỗi. |
| **Test changelog** | Chạy trong lệnh kiểm trước commit. Chặn: lockfile hay mục đầu changelog lệch số với file khai báo, thứ tự sai, số mới không phải số liền sau và cũng không phải bước lên chính thức, MINOR hay PATCH quá 9999, `title` quá 3 từ hay có dấu hai chấm, `note` quá 90 ký tự hay nhiều hơn một câu. |

Hook nằm trong repo (`.githooks/`), nhưng git chỉ chạy khi được trỏ tới. Mỗi bản
clone mới chạy một lần:

```bash
git config core.hooksPath .githooks
```

Bản mẫu chạy được của cả bốn nằm trong repo spteacher: `.githooks/commit-msg`,
`src/lib/version.ts` (kèm `version.test.ts`), `scripts/05-trien-khai/tang-phien-ban.mjs`,
`src/constants/changelog.test.ts`. Dự án Node chép sang rồi sửa đường dẫn và chữ
"SPTeacher" trong comment; dự án ngôn ngữ khác viết lại đúng hành vi trong bảng.

---

## 4. Dựng phần riêng cho dự án — làm khi bắt đầu code

Phần riêng ghi đường dẫn và lệnh **thật** của dự án. Chưa có code thì chưa có gì thật
để ghi, nên dựng ở lần đầu code trong dự án, không dựng trước.

1. Chép file này vào `docs/` của dự án, nguyên văn.
2. Dựng bốn chốt chặn ở mục 3, bật hook bằng `git config core.hooksPath .githooks`.
3. Viết phần riêng vào file luật của dự án (`AGENTS.md` hoặc `CLAUDE.md`) theo khuôn
   dưới. Chỉ điền chỗ trống, không chép lại luật chung.
4. Chạy lệnh kiểm của dự án cho sạch, rồi thử một commit sai dạng để thấy hook cảnh báo.

Khuôn phần riêng:

````markdown
## Commit và phiên bản

Luật chung ở `docs/QUY-CHUAN-COMMIT-PHIEN-BAN.md`. Dưới đây chỉ là phần riêng của <dự án>.

| Chỗ | Ở <dự án> |
|---|---|
| Phạm vi hay dùng | <tên tính năng theo cách người dùng gọi> |
| File khai số phiên bản | <vd. `"version"` trong `package.json`> |
| Chỗ hiện số trên giao diện | <vd. cuối menu tài khoản> |
| Lệnh tăng số | <lệnh> · lên chính thức: <lệnh> `chinh-thuc` |
| Hàm đếm | <đường dẫn> |
| Changelog | <đường dẫn> |
| Test changelog | <đường dẫn>, chạy trong <lệnh kiểm> |
| Hook commit | `.githooks/commit-msg` |
| Lệnh phát hành | <lệnh> |
| Beta ở đây nghĩa là | <ai đang dùng bản đang chạy> |
| Nhiều phiên chung cây | <có hay không; có thì ghi cách chặn va nhau> |

Lệch luật chung: <luật nào, vì sao>. Không lệch thì ghi "Không".
````
