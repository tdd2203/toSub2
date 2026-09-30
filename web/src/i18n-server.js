// Vietnamese translations for text produced by the local server (src/*.mjs):
// API errors, job prompts, protocol log lines and SMS provider definitions.
// Keys are the Chinese source strings with "{n}" in place of interpolated
// values. Log tags such as "[sms] " and error codes such as
// "REFRESH_TOKEN_INVALID: " are stripped before lookup (see ts() in i18n.js),
// so keys never include them.

export const SERVER_VI = {
  // console-server.mjs · batch actions and API validation
  "{0} 当前仍在进行中，不能重新授权": "{0} vẫn đang chạy, chưa thể ủy quyền lại",
  "选中的账号当前都不能重新登录": "Không tài khoản nào đã chọn có thể đăng nhập lại lúc này",
  "选中的账号都不能设置 2FA": "Không tài khoản nào đã chọn có thể đặt 2FA",
  "选中的账号当前都不能添加密码": "Không tài khoản nào đã chọn có thể thêm mật khẩu lúc này",
  "号池 {0}": "Pool {0}",
  "选中的任务里没有已完成的导入文件": "Các tác vụ đã chọn không có file import nào đã hoàn tất",
  "请先启用 Sub2API 号池监控": "Hãy bật giám sát pool Sub2API trước",
  "该接码平台不支持价格查询": "Nền tảng nhận mã này không hỗ trợ truy vấn giá",
  "一次最多筛选 {0} 个邮箱": "Tối đa {0} email mỗi lần lọc",
  "第 {0} 个筛选邮箱格式错误": "Email lọc thứ {0} sai định dạng",
  "请至少选择一个已完成任务": "Hãy chọn ít nhất một tác vụ đã hoàn tất",
  "一次最多下载 {0} 个账号": "Mỗi lần tải tối đa {0} tài khoản",
  "部分任务不存在，请刷新页面后重试": "Một số tác vụ không tồn tại, hãy tải lại trang rồi thử lại",
  "{0} 的导入文件不存在": "File import của {0} không tồn tại",
  "{0} 的导入文件格式不正确": "File import của {0} sai định dạng",
  "请至少选择一条任务": "Hãy chọn ít nhất một tác vụ",
  "一次最多操作 {0} 条任务": "Mỗi lần thao tác tối đa {0} tác vụ",
  "当前任务不需要重新授权": "Tác vụ này không cần ủy quyền lại",
  "只能为已经完成的任务重新生成授权": "Chỉ có thể tạo lại ủy quyền cho tác vụ đã hoàn tất",
  "当前任务正在进行中，不能重新登录": "Tác vụ đang chạy, chưa thể đăng nhập lại",
  "只能为已完成授权，或已保存邮箱登录检查点且尚未设置 2FA 的账号设置 2FA":
    "Chỉ có thể đặt 2FA cho tài khoản đã ủy quyền xong, hoặc đã lưu checkpoint đăng nhập email và chưa đặt 2FA",
  "该账号已经保存了 2FA 密钥，无需重复设置": "Tài khoản này đã lưu khóa 2FA, không cần đặt lại",
  "该账号已经启用 2FA，但本地没有它的原始密钥，无法重复创建":
    "Tài khoản này đã bật 2FA nhưng máy không có khóa gốc, không thể tạo lại",
  "邮箱登录检查点已丢失，请先重新登录": "Checkpoint đăng nhập email đã mất, hãy đăng nhập lại trước",
  "只能为已完成授权，或已保存邮箱登录检查点且尚未保存密码的账号添加密码":
    "Chỉ có thể thêm mật khẩu cho tài khoản đã ủy quyền xong, hoặc đã lưu checkpoint đăng nhập email và chưa lưu mật khẩu",
  "密码不能为空": "Mật khẩu không được để trống",
  "2FA 验证码必须是 6 位数字": "Mã 2FA phải gồm 6 chữ số",
  "设置 2FA 的验证码必须是 6 位数字": "Mã để đặt 2FA phải gồm 6 chữ số",
  "正在获取手机号，请不要重复提交": "Đang lấy số điện thoại, đừng gửi lặp lại",
  "任务已经不在手机号输入步骤，平台号码已释放": "Tác vụ không còn ở bước nhập số điện thoại, số của nền tảng đã được trả lại",
  "{0} 的密码未能从系统安全凭据存储读取，请重新导入该账号资料":
    "Không đọc được mật khẩu của {0} từ kho thông tin đăng nhập an toàn của hệ thống, hãy nhập lại thông tin tài khoản này",
  "{0} 的 2FA 密钥未能从系统安全凭据存储读取，请重新导入该账号资料":
    "Không đọc được khóa 2FA của {0} từ kho thông tin đăng nhập an toàn của hệ thống, hãy nhập lại thông tin tài khoản này",
  "{0} 是旧版本任务，原始登录资料未保存，请重新导入该账号资料后再导出":
    "{0} là tác vụ phiên bản cũ, thông tin đăng nhập gốc chưa được lưu; hãy nhập lại thông tin tài khoản rồi mới xuất",

  // console-server.mjs · account proxy
  "账号代理必须是完整的 http://、https://、socks5:// 或 socks5h:// 地址":
    "Proxy tài khoản phải là địa chỉ đầy đủ dạng http://, https://, socks5:// hoặc socks5h://",
  "账号代理只支持 http、https、socks5 和 socks5h 协议": "Proxy tài khoản chỉ hỗ trợ giao thức http, https, socks5 và socks5h",

  // console-server.mjs · batch account import
  "第 {0} 行": "Dòng {0}: ",
  "{0}2FA 密钥格式错误，只能包含 Base32（基础三十二进制）的 A-Z 和 2-7":
    "{0}Khóa 2FA sai định dạng, chỉ được chứa A-Z và 2-7 (Base32)",
  "请至少输入一行账号信息": "Hãy nhập ít nhất một dòng thông tin tài khoản",
  "一次最多添加 {0} 条任务": "Mỗi lần thêm tối đa {0} tác vụ",
  "POST 邮件接码模式需要先在控制台配置统一请求 URL":
    "Chế độ nhận mã email bằng POST cần cấu hình URL yêu cầu chung trên bảng điều khiển trước",
  "第 {0} 行格式错误，POST 邮件接码请使用 邮箱----编码请求体":
    "Dòng {0} sai định dạng; nhận mã email bằng POST hãy dùng email----thân_yêu_cầu_đã_mã_hóa",
  "第 {0} 行必须包含一个独立邮箱": "Dòng {0} phải chứa một email riêng biệt",
  "第 {0} 行缺少 POST 请求体": "Dòng {0} thiếu thân yêu cầu POST",
  "第 {0} 行无法区分密码和 POST 请求体，请将编码请求体放在最后":
    "Dòng {0} không phân biệt được mật khẩu và thân yêu cầu POST, hãy đặt thân yêu cầu đã mã hóa ở cuối",
  "第 {0} 行 POST 请求体不能超过 64 KB": "Thân yêu cầu POST ở dòng {0} không được vượt quá 64 KB",
  "第 {0} 行{1}": "Dòng {0}: {1}",
  "第 {0} 行存在 {1} 个连续短横线，无法确定是分隔符还是字段内容，请改用 | 或 Tab 分隔":
    "Dòng {0} có {1} dấu gạch ngang liên tiếp, không xác định được là dấu phân tách hay nội dung; hãy dùng | hoặc Tab để phân tách",
  "第 {0} 行无法识别出独立邮箱和账号字段": "Dòng {0} không nhận diện được email riêng biệt và các trường tài khoản",
  "第 {0} 行存在多种可能的字段分隔方式，请改用 ---- 明确分隔":
    "Dòng {0} có thể được phân tách theo nhiều cách, hãy dùng ---- để phân tách rõ ràng",
  "第 {0} 行似乎混用了多种分隔符，密码中又识别到 URL 或 2FA 密钥，请统一改用 ---- 分隔":
    "Dòng {0} có vẻ dùng lẫn nhiều loại dấu phân tách và trong mật khẩu lại có URL hoặc khóa 2FA; hãy thống nhất dùng ---- để phân tách",
  "中识别到多个完整邮箱，无法确定哪个是账号": "phát hiện nhiều email đầy đủ, không xác định được email nào là tài khoản",
  "中的 URL 可能包含逗号或分号，请改用 ---- 分隔字段": "URL có thể chứa dấu phẩy hoặc chấm phẩy, hãy dùng ---- để phân tách các trường",

  // console-server.mjs · mail OTP API settings
  "邮件接码请求方式只支持 GET 或 POST": "Phương thức yêu cầu nhận mã email chỉ hỗ trợ GET hoặc POST",
  "邮件接码请求头必须是 JSON 对象": "Header yêu cầu nhận mã email phải là đối tượng JSON",
  "邮件接码请求头最多配置 {0} 项": "Header yêu cầu nhận mã email tối đa {0} mục",
  "无效的请求头名称：{0}": "Tên header không hợp lệ: {0}",
  "请求头 {0} 由请求库自动管理，不能手动配置": "Header {0} do thư viện HTTP tự quản lý, không thể cấu hình thủ công",
  "请求头 {0} 的值必须是文本或数字": "Giá trị của header {0} phải là văn bản hoặc số",
  "请求头 {0} 不能包含换行符": "Header {0} không được chứa ký tự xuống dòng",
  "请求头 {0} 的值过长": "Giá trị của header {0} quá dài",
  "POST 邮件接码模式必须配置有效的 HTTP 或 HTTPS 请求 URL":
    "Chế độ nhận mã email bằng POST phải cấu hình URL yêu cầu HTTP hoặc HTTPS hợp lệ",

  // console-server.mjs · Sub2API
  "请填写 Sub2API 后端地址": "Hãy nhập địa chỉ backend Sub2API",
  "Sub2API 后端地址格式不正确": "Địa chỉ backend Sub2API sai định dạng",
  "Sub2API 后端地址必须使用 HTTP 或 HTTPS": "Địa chỉ backend Sub2API phải dùng HTTP hoặc HTTPS",
  "请填写有效的 Sub2API 管理员 API Key": "Hãy nhập API Key quản trị Sub2API hợp lệ",
  "目标号池 ID 无效": "ID pool đích không hợp lệ",
  "代理 ID 无效": "ID proxy không hợp lệ",
  "Codex 指纹收敛模式无效": "Chế độ hội tụ vân tay Codex không hợp lệ",
  "{0}必须是数字": "{0} phải là số",
  "{0}范围必须是 {1} 到 {2}": "{0} phải trong khoảng {1} đến {2}",
  "支持模型最多填写 200 个": "Chỉ được nhập tối đa 200 model",
  "支持模型名称格式不正确": "Tên model sai định dạng",
  // The server appends "：<detail>" right after the status code; the detail is
  // captured into {0} and translated as its own clause.
  "Sub2API 返回 HTTP {0}": "Sub2API trả về HTTP {0}",
  "Sub2API 请求已因服务关闭而取消": "Yêu cầu Sub2API đã bị hủy vì dịch vụ đang tắt",
  "Sub2API 请求超时": "Yêu cầu Sub2API quá thời gian chờ",
  "无法连接 Sub2API 后端：{0}": "Không kết nối được backend Sub2API: {0}",
  "Sub2API 号池监控未启用": "Chưa bật giám sát pool Sub2API",
  "服务正在关闭，已停止号池巡检": "Dịch vụ đang tắt, đã dừng kiểm tra pool",
  "Sub2API 账号 {0} 返回数据不完整": "Dữ liệu trả về cho tài khoản Sub2API {0} không đầy đủ",
  "新授权文件中没有可更新的账号凭据": "File ủy quyền mới không có thông tin xác thực tài khoản để cập nhật",

  // console-server.mjs · Sub2API pool monitor
  "Sub2API 号池发现 {0} 条异常记录，已自动加入重新登录并授权队列。":
    "Pool Sub2API có {0} bản ghi lỗi, đã tự thêm vào hàng đợi đăng nhập lại và ủy quyền.",
  "读取待重传的 Sub2API 账号失败：{0}。": "Đọc tài khoản Sub2API chờ tải lại thất bại: {0}.",
  "{0} 条待重传账号已从 Sub2API 删除，已停止重试。": "{0} tài khoản chờ tải lại đã bị xóa khỏi Sub2API, đã dừng thử lại.",
  "正在重传 {0} 条上次未完成的 Sub2API 更新，不重复登录。":
    "Đang tải lại {0} cập nhật Sub2API chưa xong lần trước, không đăng nhập lại.",
  "已用新授权覆盖更新 Sub2API 中的 {0} 条账号记录。": "Đã dùng ủy quyền mới ghi đè {0} bản ghi tài khoản trên Sub2API.",
  "新授权已生成，但更新 Sub2API 失败：{0}。下次巡检会优先重传，不会重复登录。":
    "Đã tạo ủy quyền mới nhưng cập nhật Sub2API thất bại: {0}. Lần kiểm tra tới sẽ ưu tiên tải lại, không đăng nhập lại.",
  "自动重新登录并授权未完成": "Tự đăng nhập lại và ủy quyền chưa hoàn tất",
  "自动授权确认账号已永久不可用，已停止后续巡检。":
    "Ủy quyền tự động xác nhận tài khoản đã vĩnh viễn không dùng được, đã dừng các lần kiểm tra sau.",
  "本次自动授权未完成，{0} 分钟内不会重复启动。": "Lần ủy quyền tự động này chưa xong, sẽ không chạy lại trong {0} phút.",
  "账号已确认封禁、删除或永久停用": "Tài khoản đã được xác nhận bị khóa, xóa hoặc vô hiệu hóa vĩnh viễn",
  "上次授权不是全自动完成": "Lần ủy quyền trước không hoàn tất tự động hoàn toàn",
  "已保存的密码无法读取": "Không đọc được mật khẩu đã lưu",
  "缺少可自动收取邮箱验证码的 API": "Thiếu API để tự nhận mã email",
  "已保存的 2FA 密钥无法读取": "Không đọc được khóa 2FA đã lưu",
  "缺少可自动登录的密码或邮件收码 API": "Thiếu mật khẩu hoặc API nhận mã email để đăng nhập tự động",
  "2FA 密钥在当前系统上无法恢复": "Không thể khôi phục khóa 2FA trên hệ thống hiện tại",
  "上次完整登录全自动完成，所需资料仍可用": "Lần đăng nhập đầy đủ trước hoàn tất tự động, thông tin cần thiết vẫn dùng được",
  "账号已被永久停用": "Tài khoản đã bị vô hiệu hóa vĩnh viễn",
  "已确认账号被封禁、删除或永久停用，后续号池巡检将直接跳过。":
    "Đã xác nhận tài khoản bị khóa, xóa hoặc vô hiệu hóa vĩnh viễn; các lần kiểm tra pool sau sẽ bỏ qua.",

  // console-server.mjs · automation bookkeeping
  "尚未完成可验证的全自动登录": "Chưa có lần đăng nhập tự động hoàn toàn nào có thể xác minh",
  "邮箱验证码": "Mã email",
  "登录 2FA 验证码": "Mã 2FA đăng nhập",
  "{0}由用户手动输入": "{0} do người dùng nhập tay",
  "{0}未记录为自动完成": "{0} không được ghi nhận là tự động",
  "没有可用于下次自动登录的密码或邮件收码接口": "Không có mật khẩu hoặc API nhận mã email để lần sau đăng nhập tự động",
  "上次完整登录未需要人工输入密码、邮箱码或登录 2FA": "Lần đăng nhập đầy đủ trước không cần nhập tay mật khẩu, mã email hay 2FA đăng nhập",
  "本次完整登录已记录为可自动修复。": "Lần đăng nhập đầy đủ này đã được ghi nhận là có thể tự sửa.",
  "本次完整登录不可自动修复：{0}。": "Lần đăng nhập đầy đủ này không thể tự sửa: {0}.",
  "旧任务没有自动化参与记录": "Tác vụ cũ không có bản ghi tự động hóa",

  // console-server.mjs · job queue and stages
  "已加入任务队列": "Đã thêm vào hàng đợi",
  "排队中，前方还有 {0} 条任务": "Đang xếp hàng, còn {0} tác vụ phía trước",
  "正在建立登录会话": "Đang tạo phiên đăng nhập",
  "正在重新建立登录会话": "Đang tạo lại phiên đăng nhập",
  "正在使用已有刷新令牌直接生成新授权": "Đang dùng refresh token sẵn có để tạo ủy quyền mới",
  "正在重新验证账号并准备设置 2FA": "Đang xác minh lại tài khoản và chuẩn bị đặt 2FA",
  "正在重新验证账号并准备添加密码": "Đang xác minh lại tài khoản và chuẩn bị thêm mật khẩu",
  "正在使用已有登录状态重试手机号绑定": "Đang dùng trạng thái đăng nhập sẵn có để thử liên kết lại số điện thoại",
  "正在强制重新登录并完成授权": "Đang buộc đăng nhập lại và hoàn tất ủy quyền",
  "已有授权状态已过期，正在重新进行邮箱登录": "Trạng thái ủy quyền hiện có đã hết hạn, đang đăng nhập lại bằng email",
  "刷新令牌已失效，正在重新登录并授权": "Refresh token đã hết hiệu lực, đang đăng nhập lại và ủy quyền",
  "账号资料已更新，正在重新建立登录会话": "Đã cập nhật thông tin tài khoản, đang tạo lại phiên đăng nhập",
  "准备 2FA 设置失败：{0}": "Chuẩn bị đặt 2FA thất bại: {0}",
  "准备添加密码失败：{0}": "Chuẩn bị thêm mật khẩu thất bại: {0}",
  "准备登录任务失败：{0}": "Chuẩn bị tác vụ đăng nhập thất bại: {0}",
  "无法启动 2FA 设置进程：{0}": "Không thể khởi chạy tiến trình đặt 2FA: {0}",
  "无法启动添加密码进程：{0}": "Không thể khởi chạy tiến trình thêm mật khẩu: {0}",
  "无法启动登录进程：{0}": "Không thể khởi chạy tiến trình đăng nhập: {0}",
  "授权完成，可以下载导入文件": "Ủy quyền xong, có thể tải file import",
  "登录进程被 {0} 终止": "Tiến trình đăng nhập bị dừng bởi {0}",
  "登录流程中断": "Quy trình đăng nhập bị gián đoạn",
  "登录进程退出，代码 {0}": "Tiến trình đăng nhập đã thoát, mã {0}",
  "未知": "không rõ",
  "收尾处理失败：{0}": "Xử lý bước cuối thất bại: {0}",
  "流程失败": "Quy trình thất bại",
  "流程已取消": "Đã hủy quy trình",
  "请输入邮箱验证码": "Hãy nhập mã email",
  "请输入账号密码": "Hãy nhập mật khẩu tài khoản",
  "请输入 6 位 2FA 验证码": "Hãy nhập mã 2FA 6 số",
  "请输入需要绑定的手机号": "Hãy nhập số điện thoại cần liên kết",
  "请输入手机短信验证码": "Hãy nhập mã SMS",
  "短信验证码已发送至 {0}": "Đã gửi mã SMS tới {0}",
  "请重新输入发送至 {0} 的验证码": "Hãy nhập lại mã đã gửi tới {0}",
  "请重新输入手机验证码": "Hãy nhập lại mã SMS",
  "邮箱验证码错误，请重新输入或重新发送": "Mã email sai, hãy nhập lại hoặc gửi lại",
  "正在等待收码接口返回新验证码，也可以手动输入": "Đang chờ API nhận mã trả về mã mới, cũng có thể nhập tay",
  "新登录状态被服务端拒绝，正在自动重新获取邮箱验证码": "Trạng thái đăng nhập mới bị máy chủ từ chối, đang tự lấy lại mã email",
  "正在验证账号密码": "Đang xác minh mật khẩu tài khoản",
  "正在验证 2FA 验证码": "Đang xác minh mã 2FA",
  "正在激活新的 2FA": "Đang kích hoạt 2FA mới",
  "正在验证邮箱验证码": "Đang xác minh mã email",
  "正在重新发送邮箱验证码": "Đang gửi lại mã email",
  "正在向 {0} 发送手机验证码": "Đang gửi mã SMS tới {0}",
  "正在验证手机验证码": "Đang xác minh mã SMS",
  "正在向 {0} 重新发送验证码": "Đang gửi lại mã tới {0}",
  "正在重新发送手机验证码": "Đang gửi lại mã SMS",
  "当前手机号不可用，正在返回换号步骤": "Số điện thoại hiện tại không dùng được, đang quay lại bước đổi số",
  "正在返回手机号输入": "Đang quay lại bước nhập số điện thoại",
  "正在完成授权并生成文件": "Đang hoàn tất ủy quyền và tạo file",
  "账号已绑定手机号，正在继续授权": "Tài khoản đã liên kết số điện thoại, đang tiếp tục ủy quyền",
  "导入文件已生成，正在收尾": "Đã tạo file import, đang hoàn tất",
  "已自动获取邮箱验证码，正在验证": "Đã tự lấy mã email, đang xác minh",
  "自动收码等待超时，请手动输入或重新发送": "Hết thời gian chờ tự nhận mã, hãy nhập tay hoặc gửi lại",
  "自动收码等待超时，请手动输入邮箱验证码": "Hết thời gian chờ tự nhận mã, hãy nhập tay mã email",
  "读取收码接口失败": "Đọc API nhận mã thất bại",

  // console-server.mjs · retries, refresh and relogin (log lines)
  "开始第 {0} 次手动重试；优先复用已有登录检查点。": "Bắt đầu thử lại thủ công lần {0}; ưu tiên dùng lại checkpoint đăng nhập sẵn có.",
  "开始第 {0} 次授权登录。": "Bắt đầu đăng nhập ủy quyền lần {0}.",
  "第 {0} 次生成：优先使用已有刷新令牌。": "Tạo lần {0}: ưu tiên dùng refresh token sẵn có.",
  "第 {0} 次授权：跳过刷新令牌并强制重新登录。": "Ủy quyền lần {0}: bỏ qua refresh token và buộc đăng nhập lại.",
  "本地未能读取已记录的 2FA 密钥，遇到 2FA 时需要手动输入验证码。":
    "Không đọc được khóa 2FA đã lưu trên máy; khi gặp 2FA sẽ cần nhập mã thủ công.",
  "刷新令牌已失效，自动回退到邮箱验证码登录。": "Refresh token đã hết hiệu lực, tự chuyển sang đăng nhập bằng mã email.",
  "登录方式与验证资料已按邮箱唯一键更新，敏感字段未写入日志。":
    "Đã cập nhật phương thức đăng nhập và thông tin xác minh theo email; các trường nhạy cảm không ghi vào log.",
  "账号代理配置已更新。": "Đã cập nhật cấu hình proxy tài khoản.",
  "已停止使用旧配置的登录进程，并使用新配置重新排队。": "Đã dừng tiến trình đăng nhập dùng cấu hình cũ và xếp hàng lại với cấu hình mới.",

  // console-server.mjs · 2FA setup
  "开始第 {0} 次 2FA 设置，原授权文件保持不变。": "Bắt đầu đặt 2FA lần {0}, file ủy quyền gốc giữ nguyên.",
  "原授权文件仍然可用，2FA 密钥尚未完成安全保存": "File ủy quyền gốc vẫn dùng được, khóa 2FA chưa được lưu an toàn",
  "{0}；已保留 2FA 结果文件，请重试保存": "{0}; đã giữ lại file kết quả 2FA, hãy thử lưu lại",
  "2FA 设置结果文件格式不正确": "File kết quả đặt 2FA sai định dạng",
  "2FA 设置地址格式不正确": "Địa chỉ thiết lập 2FA sai định dạng",
  "2FA 密钥已生成，正在自动激活": "Đã tạo khóa 2FA, đang tự kích hoạt",
  "密钥已生成，请添加到验证器后输入当前 6 位验证码": "Đã tạo khóa, hãy thêm vào ứng dụng xác thực rồi nhập mã 6 số hiện tại",
  "请将密钥添加到验证器后输入当前 6 位验证码": "Hãy thêm khóa vào ứng dụng xác thực rồi nhập mã 6 số hiện tại",
  "正在自动完成 2FA 验证": "Đang tự hoàn tất xác minh 2FA",
  "正在准备 2FA 验证": "Đang chuẩn bị xác minh 2FA",
  "账号已经启用 2FA，但服务端不会返回原始密钥": "Tài khoản đã bật 2FA nhưng máy chủ sẽ không trả về khóa gốc",
  "如需自动登录，请重新导入这个账号原有的 2FA 密钥": "Muốn đăng nhập tự động, hãy nhập lại khóa 2FA gốc của tài khoản này",
  "2FA 已激活并保存，但最终状态确认未完成": "Đã kích hoạt và lưu 2FA nhưng chưa xác nhận xong trạng thái cuối",
  "2FA 已设置并安全保存，可以继续未完成的 Codex 授权": "Đã đặt và lưu an toàn 2FA, có thể tiếp tục ủy quyền Codex còn dang dở",
  "2FA 已设置并安全保存，可以继续下载或重新授权": "Đã đặt và lưu an toàn 2FA, có thể tiếp tục tải xuống hoặc ủy quyền lại",
  "当前系统不支持持久凭据存储，2FA 密钥已保留在私有结果文件中，请不要删除该任务目录":
    "Hệ thống hiện tại không hỗ trợ lưu thông tin đăng nhập lâu dài; khóa 2FA được giữ trong file kết quả riêng, đừng xóa thư mục tác vụ này",
  "激活接口已返回成功，但后续确认请求失败；密钥已保留": "API kích hoạt báo thành công nhưng yêu cầu xác nhận sau đó thất bại; khóa đã được giữ lại",
  "2FA 设置成功，密钥已写入系统凭据存储，未写入协议日志。":
    "Đặt 2FA thành công; khóa đã ghi vào kho thông tin đăng nhập của hệ thống, không ghi vào log giao thức.",
  "2FA 设置成功，但当前系统不支持持久凭据存储；密钥已保留在私有结果文件中。":
    "Đặt 2FA thành công nhưng hệ thống hiện tại không hỗ trợ lưu thông tin đăng nhập lâu dài; khóa được giữ trong file kết quả riêng.",
  "本次 2FA 设置未完成，原登录检查点仍可继续": "Lần đặt 2FA này chưa xong, checkpoint đăng nhập cũ vẫn có thể tiếp tục",
  "授权文件仍然可用，本次 2FA 设置未完成": "File ủy quyền vẫn dùng được, lần đặt 2FA này chưa xong",
  "2FA 设置进程被 {0} 终止": "Tiến trình đặt 2FA bị dừng bởi {0}",
  "2FA 设置进程退出，代码 {0}": "Tiến trình đặt 2FA đã thoát, mã {0}",
  "2FA 密钥已经生成，正在安全读取": "Đã tạo khóa 2FA, đang đọc an toàn",
  "无法读取 2FA 密钥：{0}": "Không đọc được khóa 2FA: {0}",
  "账号已经启用 2FA，正在收尾": "Tài khoản đã bật 2FA, đang hoàn tất",
  "2FA 已激活，正在安全保存密钥": "Đã kích hoạt 2FA, đang lưu khóa an toàn",
  "本次登录需要浏览器安全校验，2FA 尚未设置": "Lần đăng nhập này cần kiểm tra bảo mật trên trình duyệt, 2FA chưa được đặt",
  "账号资料校验未通过，2FA 尚未设置": "Kiểm tra thông tin tài khoản không đạt, 2FA chưa được đặt",
  "设置 2FA 时登录状态失效，请稍后重试": "Trạng thái đăng nhập hết hiệu lực khi đặt 2FA, hãy thử lại sau",
  "授权文件仍然可用，2FA 设置已取消": "File ủy quyền vẫn dùng được, đã hủy đặt 2FA",
  "2FA 设置已取消，原登录检查点仍可继续": "Đã hủy đặt 2FA, checkpoint đăng nhập cũ vẫn có thể tiếp tục",
  "用户取消了本次 2FA 设置": "Người dùng đã hủy lần đặt 2FA này",

  // console-server.mjs · add password
  "开始为无密码账号添加密码，新密码不会写入协议日志。":
    "Bắt đầu thêm mật khẩu cho tài khoản chưa có mật khẩu; mật khẩu mới sẽ không ghi vào log giao thức.",
  "添加密码结果无法读取：{0}": "Không đọc được kết quả thêm mật khẩu: {0}",
  "当前系统不支持持久凭据存储，新密码仅在本次服务运行期间可用":
    "Hệ thống hiện tại không hỗ trợ lưu thông tin đăng nhập lâu dài; mật khẩu mới chỉ dùng được trong lần chạy dịch vụ này",
  "密码添加成功，可以继续未完成的 Codex 授权": "Đã thêm mật khẩu, có thể tiếp tục ủy quyền Codex còn dang dở",
  "密码添加成功，账号原始信息已经更新": "Đã thêm mật khẩu, thông tin gốc của tài khoản đã được cập nhật",
  "密码添加成功，但新密码未能持久保存": "Đã thêm mật khẩu nhưng không lưu lâu dài được mật khẩu mới",
  "密码添加成功，新密码已安全保存，未写入协议日志。":
    "Đã thêm mật khẩu; mật khẩu mới đã được lưu an toàn và không ghi vào log giao thức.",
  "密码添加成功，但当前系统不支持持久保存新密码。": "Đã thêm mật khẩu nhưng hệ thống hiện tại không hỗ trợ lưu lâu dài mật khẩu mới.",
  "本次添加密码未完成，原登录检查点仍可继续": "Lần thêm mật khẩu này chưa xong, checkpoint đăng nhập cũ vẫn có thể tiếp tục",
  "原授权文件仍可使用，本次添加密码未完成": "File ủy quyền gốc vẫn dùng được, lần thêm mật khẩu này chưa xong",
  "添加密码进程被 {0} 终止": "Tiến trình thêm mật khẩu bị dừng bởi {0}",
  "添加密码进程退出，代码 {0}": "Tiến trình thêm mật khẩu đã thoát, mã {0}",
  "ChatGPT 登录状态已保留，点击继续流程即可重新开始 Codex 授权":
    "Đã giữ trạng thái đăng nhập ChatGPT; bấm \"Tiếp tục\" để bắt đầu lại ủy quyền Codex",
  "点击继续流程可恢复 Codex 授权": "Bấm \"Tiếp tục\" để khôi phục ủy quyền Codex",
  "添加密码需要浏览器安全校验，请稍后重试或更换代理 IP":
    "Thêm mật khẩu cần kiểm tra bảo mật trên trình duyệt, hãy thử lại sau hoặc đổi proxy IP",
  "账号资料校验未通过，密码尚未添加": "Kiểm tra thông tin tài khoản không đạt, mật khẩu chưa được thêm",
  "添加密码时登录状态失效，请稍后重试": "Trạng thái đăng nhập hết hiệu lực khi thêm mật khẩu, hãy thử lại sau",
  "密码已添加，正在安全保存新密码": "Đã thêm mật khẩu, đang lưu an toàn mật khẩu mới",
  "原授权文件仍可使用，添加密码已取消": "File ủy quyền gốc vẫn dùng được, đã hủy thêm mật khẩu",
  "用户取消了本次添加密码": "Người dùng đã hủy lần thêm mật khẩu này",

  // console-server.mjs · proxy rotation and security checks
  "正在检测第 {0}/{1} 个新代理会话。": "Đang kiểm tra phiên proxy mới {0}/{1}.",
  "自动更换代理会话失败：{0}": "Tự đổi phiên proxy thất bại: {0}",
  "Cloudflare 安全校验未能完成，直连 TLS 指纹筛选已经使用过，请稍后重试":
    "Không hoàn tất được kiểm tra bảo mật Cloudflare, đã dùng hết phương án lọc vân tay TLS kết nối trực tiếp; hãy thử lại sau",
  "Cloudflare 求解未完成，正在启用直连 TLS 指纹筛选兜底（{0}）。":
    "Chưa giải xong Cloudflare, đang chuyển sang phương án dự phòng lọc vân tay TLS kết nối trực tiếp ({0}).",
  "当前代理没有可识别的会话编号，无法自动轮换；请更换代理配置后重试":
    "Proxy hiện tại không có số phiên nhận diện được nên không thể tự xoay; hãy đổi cấu hình proxy rồi thử lại",
  "代理会话已自动更换 {0} 次，仍然触发安全校验": "Đã tự đổi phiên proxy {0} lần nhưng vẫn bị kiểm tra bảo mật",
  "代理连接连续失败 {0} 次，已停止自动重试": "Kết nối proxy thất bại liên tiếp {0} lần, đã dừng tự thử lại",
  "代理连接失败，HTTP 检测次数仍为 {0}/{1}；连接失败 {2}/{3}。":
    "Kết nối proxy thất bại; số lần kiểm tra HTTP vẫn là {0}/{1}; kết nối lỗi {2}/{3}.",
  "登录阶段触发安全校验，已使用 {0}/{1} 个代理会话，正在继续更换。":
    "Bước đăng nhập bị kiểm tra bảo mật, đã dùng {0}/{1} phiên proxy, đang tiếp tục đổi.",
  "代理连接失败，{0} 秒后更换会话": "Kết nối proxy thất bại, đổi phiên sau {0} giây",
  "代理连接失败，正在更换会话；HTTP 检测次数仍为 {0}/{1}": "Kết nối proxy thất bại, đang đổi phiên; số lần kiểm tra HTTP vẫn là {0}/{1}",
  "代理触发安全校验，已使用 {0}/{1} 个代理会话": "Proxy bị kiểm tra bảo mật, đã dùng {0}/{1} phiên proxy",
  "原授权文件仍然可用，自动更换代理未能完成本次操作": "File ủy quyền gốc vẫn dùng được; tự đổi proxy không hoàn tất được thao tác lần này",
  "登录状态已失效，需要重新授权": "Trạng thái đăng nhập đã hết hiệu lực, cần ủy quyền lại",
  "手机号绑定需要浏览器安全校验": "Liên kết số điện thoại cần kiểm tra bảo mật trên trình duyệt",
  "邮箱登录已经成功，但服务端拒绝了本次纯协议短信请求；可以手动重试，若仍被拒绝则需要稍后再试":
    "Đăng nhập email đã thành công nhưng máy chủ từ chối yêu cầu SMS thuần giao thức lần này; có thể thử lại thủ công, nếu vẫn bị từ chối thì thử lại sau",
  "账号资料创建需要安全校验": "Tạo thông tin tài khoản cần kiểm tra bảo mật",
  "邮箱验证码已经通过，但账号资料创建仍被 Sentinel 安全校验拒绝；可以点击重新授权再次生成动态校验令牌":
    "Mã email đã qua nhưng việc tạo thông tin tài khoản vẫn bị Sentinel từ chối; có thể bấm \"Ủy quyền lại\" để tạo lại token xác minh động",
  "账号注册资料未完成": "Thông tin đăng ký tài khoản chưa hoàn tất",
  "邮箱验证已经成功，但该邮箱还没有完成账号资料填写。请先在官方页面完成姓名和出生日期后再重新授权。":
    "Xác minh email đã thành công nhưng email này chưa điền xong thông tin tài khoản. Hãy điền họ tên và ngày sinh trên trang chính thức rồi ủy quyền lại.",
  "邮箱登录检查点仍然有效，可以继续手机号绑定": "Checkpoint đăng nhập email vẫn còn hiệu lực, có thể tiếp tục liên kết số điện thoại",
  "{0}，继续时会优先恢复已保存状态；状态失效才重新获取邮箱验证码":
    "{0}; khi tiếp tục sẽ ưu tiên khôi phục trạng thái đã lưu, chỉ lấy lại mã email khi trạng thái hết hiệu lực",

  // console-server.mjs · phone verification and SMS providers
  "当前登录状态已经失效，继续更换手机号也无法发送验证码":
    "Trạng thái đăng nhập hiện tại đã hết hiệu lực, có đổi số điện thoại cũng không gửi được mã",
  "该平台手机号无法接收验证码，请重新取号或手动输入其他手机号":
    "Số của nền tảng này không nhận được mã, hãy lấy số khác hoặc tự nhập số điện thoại khác",
  "手机号 {0} 无法接收验证码，请更换手机号": "Số {0} không nhận được mã, hãy đổi số điện thoại",
  "平台返回的验证码未通过验证，请重新发送或更换手机号": "Mã do nền tảng trả về không qua được xác minh, hãy gửi lại hoặc đổi số điện thoại",
  "当前手机号已被服务端拒绝，停止提交旧验证码并自动返回换号步骤。":
    "Số điện thoại hiện tại bị máy chủ từ chối; dừng gửi mã cũ và tự quay lại bước đổi số.",
  "无法自动返回换号步骤：{0}": "Không thể tự quay lại bước đổi số: {0}",
  "该手机号触发了风控，请更换手机号或稍后重试": "Số điện thoại này bị kiểm soát rủi ro, hãy đổi số hoặc thử lại sau",
  "短信发送过于频繁，请稍后重试或更换手机号": "Gửi SMS quá thường xuyên, hãy thử lại sau hoặc đổi số điện thoại",
  "该手机号不可用或已被使用，请更换手机号": "Số điện thoại này không dùng được hoặc đã được dùng, hãy đổi số",
  "短信验证码发送失败，请更换手机号后重试": "Gửi mã SMS thất bại, hãy đổi số điện thoại rồi thử lại",
  "该手机号近期已被使用，已停止重复提交，请更换手机号": "Số điện thoại này vừa được dùng gần đây, đã dừng gửi lặp lại; hãy đổi số",
  "该手机号已绑定其他账号，请更换手机号": "Số điện thoại này đã liên kết với tài khoản khác, hãy đổi số",
  "手机验证码已过期，请重新发送或更换手机号": "Mã SMS đã hết hạn, hãy gửi lại hoặc đổi số điện thoại",
  "验证次数过多，已停止自动提交，请稍后更换手机号": "Xác minh quá nhiều lần, đã dừng tự gửi; hãy đổi số điện thoại sau",
  "手机验证码不正确，请重新输入；也可以重新发送或更换手机号": "Mã SMS không đúng, hãy nhập lại; cũng có thể gửi lại hoặc đổi số điện thoại",
  "已从 {0} 获取手机号并提交，等待短信发送结果。": "Đã lấy số điện thoại từ {0} và gửi đi, đang chờ kết quả gửi SMS.",
  "{0} 更新号码就绪状态失败：{1}": "{0}: cập nhật trạng thái sẵn sàng của số thất bại: {1}",
  "接码平台仍返回已提交过的验证码，已停止重复提交": "Nền tảng nhận mã vẫn trả về mã đã gửi trước đó, đã dừng gửi lặp lại",
  "{0} 返回了已提交过的验证码，已停止本次自动轮询。": "{0} trả về mã đã gửi trước đó, đã dừng lần tự truy vấn này.",
  "已从 {0} 获取短信验证码并自动提交。": "Đã lấy mã SMS từ {0} và tự gửi.",
  "{0}，可以手动输入验证码或更换手机号": "{0}; có thể nhập mã thủ công hoặc đổi số điện thoại",
  "{0}，正在自动重试": "{0}; đang tự thử lại",
  "等待平台短信超时，可以手动输入验证码或更换手机号": "Hết thời gian chờ SMS từ nền tảng, có thể nhập mã thủ công hoặc đổi số điện thoại",
  "{0} 号码释放请求失败，请在平台控制台检查订单。": "{0}: yêu cầu trả số thất bại, hãy kiểm tra đơn trên bảng điều khiển của nền tảng.",
  "手机验证码已通过，正在完成 {0} 订单。": "Mã SMS đã qua, đang hoàn tất đơn {0}.",
  "{0} 完成订单失败：{1}": "{0}: hoàn tất đơn thất bại: {1}",
  "服务重启后已停止自动收短信，可手动输入验证码或换号": "Sau khi dịch vụ khởi động lại đã dừng tự nhận SMS; có thể nhập mã thủ công hoặc đổi số",
  "接码平台请求失败": "Yêu cầu tới nền tảng nhận mã thất bại",

  // console-server.mjs · mail OTP polling
  "已记录收码接口中的 {0} 个旧邮件验证码标识，等待新邮件。": "Đã ghi nhận {0} mã email cũ từ API nhận mã, đang chờ email mới.",
  "首次读取收码接口失败：{0}": "Đọc API nhận mã lần đầu thất bại: {0}",
  "已从收码接口自动取得新验证码并提交。": "Đã tự lấy mã mới từ API nhận mã và gửi đi.",

  // console-server.mjs · restore after restart
  "已恢复成功激活的 2FA 密钥，可以继续未完成的 Codex 授权":
    "Đã khôi phục khóa 2FA đã kích hoạt thành công, có thể tiếp tục ủy quyền Codex còn dang dở",
  "已恢复成功添加的新密码，可以继续未完成的 Codex 授权":
    "Đã khôi phục mật khẩu mới đã thêm thành công, có thể tiếp tục ủy quyền Codex còn dang dở",
  "检测到邮箱登录检查点，可以继续手机号绑定": "Phát hiện checkpoint đăng nhập email, có thể tiếp tục liên kết số điện thoại",
  "已恢复上次操作状态，登录检查点仍然保留": "Đã khôi phục trạng thái thao tác lần trước, checkpoint đăng nhập vẫn được giữ",
  "已从中断的 2FA 设置流程恢复并安全保存密钥。": "Đã khôi phục từ quy trình đặt 2FA bị gián đoạn và lưu khóa an toàn.",
  "已从中断的添加密码流程恢复并安全保存新密码。": "Đã khôi phục từ quy trình thêm mật khẩu bị gián đoạn và lưu mật khẩu mới an toàn.",
  "已恢复 {0} 阶段的登录检查点。": "Đã khôi phục checkpoint đăng nhập ở bước {0}.",
  "上次流程在生成授权文件前中断": "Quy trình trước bị gián đoạn trước khi tạo file ủy quyền",
  "登录资料需要重新确认": "Thông tin đăng nhập cần xác nhận lại",
  "服务重启后已恢复，等待任务槽位": "Đã khôi phục sau khi dịch vụ khởi động lại, đang chờ slot tác vụ",
  "上次流程因服务重启中断，可以重新授权": "Quy trình trước bị gián đoạn do dịch vụ khởi động lại, có thể ủy quyền lại",
  "已恢复上次任务状态": "Đã khôi phục trạng thái tác vụ lần trước",
  "请重新导入或填写{0}后重试，任务不会使用缺失的资料自动登录":
    "Hãy nhập lại hoặc điền {0} rồi thử lại; tác vụ sẽ không tự đăng nhập khi thiếu thông tin",
  "上次 {0} 阶段未完成": "Bước {0} lần trước chưa hoàn tất",
  "系统安全凭据存储中无法恢复{0}，已停止自动启动。":
    "Không khôi phục được {0} từ kho thông tin đăng nhập an toàn của hệ thống, đã dừng tự khởi chạy.",
  "已恢复排队任务，等待可用任务槽位。": "Đã khôi phục tác vụ đang xếp hàng, chờ slot tác vụ trống.",
  "上次任务在生成授权文件前中断，已恢复为可重试状态。":
    "Tác vụ trước bị gián đoạn trước khi tạo file ủy quyền, đã khôi phục về trạng thái có thể thử lại.",
  "已恢复上次任务状态。": "Đã khôi phục trạng thái tác vụ lần trước.",
  "2FA 结果文件无法读取：{0}": "Không đọc được file kết quả 2FA: {0}",
  "2FA 已激活，但当前系统不支持持久凭据存储；结果文件已保留":
    "Đã kích hoạt 2FA nhưng hệ thống hiện tại không hỗ trợ lưu thông tin đăng nhập lâu dài; đã giữ file kết quả",
  "2FA 已激活，但密钥恢复失败：{0}；结果文件已保留": "Đã kích hoạt 2FA nhưng khôi phục khóa thất bại: {0}; đã giữ file kết quả",
  "添加密码结果文件无法读取：{0}": "Không đọc được file kết quả thêm mật khẩu: {0}",
  "添加密码结果文件格式不正确": "File kết quả thêm mật khẩu sai định dạng",
  "密码已经添加，但当前系统不支持持久凭据存储；结果文件已保留":
    "Đã thêm mật khẩu nhưng hệ thống hiện tại không hỗ trợ lưu thông tin đăng nhập lâu dài; đã giữ file kết quả",
  "密码已经添加，但新密码恢复失败：{0}；结果文件已保留": "Đã thêm mật khẩu nhưng khôi phục mật khẩu mới thất bại: {0}; đã giữ file kết quả",
  "已恢复上次成功添加的新密码，原授权文件仍可下载": "Đã khôi phục mật khẩu mới thêm thành công lần trước, file ủy quyền gốc vẫn tải được",
  "原授权文件仍可下载，新密码需要重试恢复": "File ủy quyền gốc vẫn tải được, mật khẩu mới cần thử khôi phục lại",
  "服务重启中断了添加密码，原授权文件仍可下载": "Dịch vụ khởi động lại làm gián đoạn việc thêm mật khẩu, file ủy quyền gốc vẫn tải được",
  "添加密码尚未完成，请重新点击添加密码": "Chưa thêm xong mật khẩu, hãy bấm \"Thêm mật khẩu\" lại",
  "添加密码被服务重启中断，旧授权文件未受影响。": "Việc thêm mật khẩu bị gián đoạn do dịch vụ khởi động lại, file ủy quyền cũ không bị ảnh hưởng.",
  "已恢复上次成功激活的 2FA 密钥，原授权文件仍可下载": "Đã khôi phục khóa 2FA kích hoạt thành công lần trước, file ủy quyền gốc vẫn tải được",
  "原授权文件仍可下载，2FA 密钥需要重试恢复": "File ủy quyền gốc vẫn tải được, khóa 2FA cần thử khôi phục lại",
  "上次操作因服务重启中断，旧授权文件仍可下载": "Thao tác trước bị gián đoạn do dịch vụ khởi động lại, file ủy quyền cũ vẫn tải được",
  "服务重启时 2FA 设置未完成": "Đặt 2FA chưa xong khi dịch vụ khởi động lại",
  "服务重启时添加密码未完成，请重新发起": "Thêm mật khẩu chưa xong khi dịch vụ khởi động lại, hãy thực hiện lại",
  "检测到旧授权文件，同时保留了上次中断的操作状态。": "Phát hiện file ủy quyền cũ, đồng thời giữ lại trạng thái thao tác bị gián đoạn lần trước.",
  "已从本地输出目录恢复，可以下载导入文件": "Đã khôi phục từ thư mục đầu ra cục bộ, có thể tải file import",
  "旧授权文件仍可下载，已恢复最近一次操作状态": "File ủy quyền cũ vẫn tải được, đã khôi phục trạng thái thao tác gần nhất",
  "已恢复任务状态，旧授权文件时间 {0}。": "Đã khôi phục trạng thái tác vụ, thời gian file ủy quyền cũ: {0}.",

  // credential-store.mjs
  "无法使用 Windows DPAPI（数据保护接口）保存登录凭据和代理配置，请确认 PowerShell 可正常运行":
    "Không thể dùng Windows DPAPI để lưu thông tin đăng nhập và cấu hình proxy, hãy kiểm tra PowerShell có chạy bình thường không",
  "持久保存登录凭据和代理配置目前支持 macOS Keychain（钥匙串）和 Windows DPAPI（数据保护接口）":
    "Lưu lâu dài thông tin đăng nhập và cấu hình proxy hiện chỉ hỗ trợ macOS Keychain và Windows DPAPI",
  "无法从 macOS Keychain（钥匙串）删除该邮箱的登录凭据": "Không thể xóa thông tin đăng nhập của email này khỏi macOS Keychain",
  "无法删除 Windows DPAPI（数据保护接口）凭据文件": "Không thể xóa file thông tin đăng nhập Windows DPAPI",
  "macOS Keychain（钥匙串）中的加密密钥无法读取，已保留现有凭据文件":
    "Không đọc được khóa mã hóa trong macOS Keychain, đã giữ nguyên file thông tin đăng nhập hiện có",
  "无法将登录凭据密钥保存到 macOS Keychain（钥匙串），请先解锁登录钥匙串":
    "Không thể lưu khóa thông tin đăng nhập vào macOS Keychain, hãy mở khóa Keychain đăng nhập trước",
  "无法写入 macOS 凭据文件：{0}": "Không thể ghi file thông tin đăng nhập macOS: {0}",

  // sms-providers.mjs · provider definitions shown in the SMS settings dialog
  "使用供应商编号获取手机号": "Lấy số điện thoại bằng mã nhà cung cấp",
  "输入 LubanSMS API Key": "Nhập API Key LubanSMS",
  "供应商编号": "Mã nhà cung cấp",
  "例如 121949": "Ví dụ 121949",
  "查询 OpenAI 实时价格和库存后选择国家": "Truy vấn giá và số lượng còn cho OpenAI theo thời gian thực rồi chọn quốc gia",
  "输入 SMSBower API Key": "Nhập API Key SMSBower",
  "服务代码": "Mã dịch vụ",
  "国家与价格": "Quốc gia và giá",
  "最高价格": "Giá tối đa",
  "国家名称": "Tên quốc gia",
  "自定义接码": "Nhận mã tùy chỉnh",
  "批量粘贴手机号和对应的接码 API": "Dán hàng loạt số điện thoại và API nhận mã tương ứng",
  "手机号与接码 API": "Số điện thoại và API nhận mã",
  "请输入有效的 LubanSMS 供应商编号": "Hãy nhập mã nhà cung cấp LubanSMS hợp lệ",
  "请输入有效的 SMSBower 服务代码": "Hãy nhập mã dịch vụ SMSBower hợp lệ",
  "请输入有效的 SMSBower 国家 ID": "Hãy nhập ID quốc gia SMSBower hợp lệ",
  "请重新查询 SMSBower 国家价格": "Hãy truy vấn lại giá theo quốc gia của SMSBower",
  "请选择受支持的接码平台": "Hãy chọn nền tảng nhận mã được hỗ trợ",
  "请输入有效的 {0} API Key": "Hãy nhập API Key {0} hợp lệ",

  // custom-sms.mjs
  "自定义接码一次最多导入 {0} 条": "Nhận mã tùy chỉnh tối đa {0} dòng mỗi lần",
  "第 {0} 行手机号必须使用 E.164 国际格式": "Số điện thoại ở dòng {0} phải theo định dạng quốc tế E.164",
  "这批自定义手机号已全部分配，请补充新号码": "Đã dùng hết lô số điện thoại tùy chỉnh này, hãy bổ sung số mới",
  "读取 {0} 的接码 API 失败：{1}": "Đọc API nhận mã của {0} thất bại: {1}",
  "自定义接码任务不存在": "Tác vụ nhận mã tùy chỉnh không tồn tại",
  "读取接码 API 失败：{0}": "Đọc API nhận mã thất bại: {0}",

  // luban-sms.mjs / smsbower.mjs
  "LubanSMS API 地址必须使用 HTTP 或 HTTPS": "Địa chỉ API LubanSMS phải dùng HTTP hoặc HTTPS",
  "SMSBower API 地址必须使用 HTTP 或 HTTPS": "Địa chỉ API SMSBower phải dùng HTTP hoặc HTTPS",
  "接码平台返回 HTTP {0}": "Nền tảng nhận mã trả về HTTP {0}",
  "接码平台返回了无效数据": "Nền tảng nhận mã trả về dữ liệu không hợp lệ",
  "接码平台返回了空响应": "Nền tảng nhận mã trả về phản hồi rỗng",
  "接码平台请求超时": "Yêu cầu tới nền tảng nhận mã quá thời gian chờ",
  "接码平台请求失败：{0}": "Yêu cầu tới nền tảng nhận mã thất bại: {0}",
  "获取手机号失败": "Lấy số điện thoại thất bại",
  "获取短信失败": "Lấy SMS thất bại",
  "释放手机号失败": "Trả số điện thoại thất bại",
  "更新号码状态失败": "Cập nhật trạng thái số thất bại",
  "接码平台返回内容中没有找到独立的 6 位数字验证码": "Không tìm thấy mã 6 chữ số riêng biệt trong nội dung nền tảng nhận mã trả về",
  "接码平台返回的手机号不是有效的国际格式": "Số điện thoại nền tảng nhận mã trả về không đúng định dạng quốc tế",
  "价格接口返回格式不正确": "API giá trả về sai định dạng",
  "国家接口返回格式不正确": "API quốc gia trả về sai định dạng",
  "号码激活已被平台取消": "Nền tảng đã hủy kích hoạt số",
  "API Key 不正确": "API Key không đúng",
  "接口动作不正确": "Hành động API không đúng",
  "服务代码不正确": "Mã dịch vụ không đúng",
  "当前国家和服务暂无可用号码": "Quốc gia và dịch vụ này hiện không có số khả dụng",
  "账户余额不足": "Số dư tài khoản không đủ",
  "激活订单不存在": "Đơn kích hoạt không tồn tại",
  "号码状态不正确": "Trạng thái số không đúng",
  "当前订单暂时不允许取消": "Đơn hiện tại tạm thời chưa được phép hủy",
  "OpenAI 当前没有可购买的国家号码": "Hiện không có số quốc gia nào mua được cho OpenAI",
  "马来西亚": "Malaysia",
  "美国（虚拟号码）": "Hoa Kỳ (số ảo)",
  "英国": "Vương quốc Anh",
  "美国": "Hoa Kỳ",
  "日本": "Nhật Bản",

  // mail-otp.mjs
  "收码接口必须是有效的 HTTP 或 HTTPS 地址": "API nhận mã phải là địa chỉ HTTP hoặc HTTPS hợp lệ",
  "收码接口返回 HTTP {0}": "API nhận mã trả về HTTP {0}",
  "收码接口请求超时": "Yêu cầu tới API nhận mã quá thời gian chờ",
  "收码接口响应超过 2 MB 限制": "Phản hồi của API nhận mã vượt giới hạn 2 MB",

  // protocol-login.mjs (login child process output)
  "邮箱验证码错误，请重新输入，或输入 r 重新发送。": "Mã email sai, hãy nhập lại hoặc nhập r để gửi lại.",
  "动态 Sentinel 令牌需要启用 Python curl_cffi 传输层": "Token Sentinel động cần bật lớp truyền tải Python curl_cffi",
  "无法读取原 sub2api 文件：{0}": "Không đọc được file sub2api gốc: {0}",
  "原文件缺少 OAuth 账号或 refresh_token": "File gốc thiếu tài khoản OAuth hoặc refresh_token",
  "OAuth 刷新接口返回非 JSON，HTTP {0}": "API làm mới OAuth trả về dữ liệu không phải JSON, HTTP {0}",
  "刷新令牌已失效": "Refresh token đã hết hiệu lực",
  "OAuth 刷新失败，HTTP {0}：{1}": "Làm mới OAuth thất bại, HTTP {0}: {1}",
  "OAuth 刷新响应缺少 access_token": "Phản hồi làm mới OAuth thiếu access_token",

  // tls-transport.mjs / tls_transport.py (login child process output)
  "本机直连指纹探测通过：{0}（共探测 {1} 个候选）。": "Dò vân tay kết nối trực tiếp từ máy này thành công: {0} (đã dò {1} ứng viên).",
  "代理会话检测额度已用尽": "Đã dùng hết lượt kiểm tra phiên proxy",
  "未检测到可轮换的会话编号，仅检测当前代理 1 次": "Không phát hiện số phiên có thể xoay, chỉ kiểm tra proxy hiện tại 1 lần",
  "代理检测通过（第 {0} 次，出口会话 {1}）": "Kiểm tra proxy đạt (lần {0}, phiên đầu ra {1})",
  "返回安全校验页面": "trả về trang kiểm tra bảo mật",
  "本次代理检测失败：{0}，等待更换会话": "Lần kiểm tra proxy này thất bại: {0}; đang chờ đổi phiên",
  "代理检测失败：{0}": "Kiểm tra proxy thất bại: {0}",
  "本次代理连接失败：{0}，等待更换会话": "Lần kết nối proxy này thất bại: {0}; đang chờ đổi phiên",
  "代理连接失败：{0}": "Kết nối proxy thất bại: {0}",
  "代理本次检测失败：{0}": "Lần kiểm tra proxy này thất bại: {0}",
  "未知错误": "Lỗi không xác định",
  "安全校验已完成，正在使用原代理会话重放 {0} 请求。": "Đã qua kiểm tra bảo mật, đang phát lại yêu cầu {0} bằng phiên proxy cũ.",
  "校验后重放仍返回安全校验，继续执行代理兜底流程。": "Phát lại sau kiểm tra vẫn bị kiểm tra bảo mật, tiếp tục quy trình proxy dự phòng.",
  "安全校验未通过（HTTP {0}），继续执行代理兜底流程。": "Không qua kiểm tra bảo mật (HTTP {0}), tiếp tục quy trình proxy dự phòng.",
  "安全校验处理失败：{0}，继续执行代理兜底流程。": "Xử lý kiểm tra bảo mật thất bại: {0}; tiếp tục quy trình proxy dự phòng.",
  "同一代理连续重试 {0} 次仍触发安全校验，准备更换代理会话。":
    "Thử lại cùng một proxy {0} lần liên tiếp vẫn bị kiểm tra bảo mật, chuẩn bị đổi phiên proxy.",
  "当前代理出口触发安全校验，保持同一代理重试 {0}/{1}。": "IP ra của proxy hiện tại bị kiểm tra bảo mật, giữ nguyên proxy và thử lại {0}/{1}.",
  "动态 Sentinel 令牌需要启用 Python TLS 传输层": "Token Sentinel động cần bật lớp truyền tải Python TLS",
  "未找到可用的 Python curl_cffi 环境，请先运行 python -m pip install -r requirements.txt；也可以设置 TOSUB2_PYTHON 指定 Python 路径":
    "Không tìm thấy môi trường Python curl_cffi khả dụng, hãy chạy python -m pip install -r requirements.txt trước; cũng có thể đặt TOSUB2_PYTHON để chỉ định đường dẫn Python",
  "自动探测返回了无效的 TLS 指纹：{0}": "Tự dò trả về vân tay TLS không hợp lệ: {0}",
  "指纹 {0} 不受当前 curl_cffi 支持，已降级为 {1}": "Vân tay {0} không được curl_cffi hiện tại hỗ trợ, đã hạ xuống {1}",
};

// Redaction markers the server splices into otherwise untranslated text
// (third-party error messages), replaced wherever they appear.
export const SERVER_VI_FRAGMENTS = [
  ["<已隐藏接口地址>", "<URL đã ẩn>"],
  ["<已隐藏地址>", "<địa chỉ đã ẩn>"],
  ["<已隐藏密钥>", "<khóa đã ẩn>"],
  ["<已隐藏>", "<đã ẩn>"],
];
