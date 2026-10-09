const path = require("node:path");

const host = String(process.env.ONBOARDING_HOST || "127.0.0.1").trim();
const port = String(process.env.ONBOARDING_PORT || "4399").trim();
const outputRoot = process.env.ONBOARDING_OUTPUT_ROOT
  || path.join(__dirname, "tmp", "chatgpt-onboarding-console");

module.exports = {
  apps: [{
    name: "tosub2",
    cwd: __dirname,
    script: "src/console-server.mjs",
    args: ["--host", host, "--port", port],
    interpreter: process.execPath,
    autorestart: true,
    exp_backoff_restart_delay: 1_000,
    max_restarts: 20,
    min_uptime: "10s",
    kill_timeout: 15_000,
    time: true,
    env: {
      NODE_ENV: "production",
      ONBOARDING_OUTPUT_ROOT: outputRoot,
      // Profile curl_cffi cho TÀI KHOẢN MỚI (tài khoản cũ giữ chrome146 đã đóng dấu).
      // Đổi giá trị ở đây rồi chạy `pm2 restart tosub2 --update-env` để áp dụng.
      TOSUB2_TLS_PROFILE: String(process.env.TOSUB2_TLS_PROFILE || "chrome142"),
      // Signup backend mặc định cho job mới qua UI "Đưa vào tác vụ":
      // "browser" (CloakBrowser + full automation) hoặc "tls" (protocol-login
      // cũ qua curl_cffi). UI không pass signupBackend → fallback về giá trị này.
      TOSUB2_SIGNUP_BACKEND: String(process.env.TOSUB2_SIGNUP_BACKEND || "browser"),
      // Engine cho browser lane: "cloak" (CloakBrowser 146, SOCKS5+auth native)
      // hoặc "patchright" (Google Chrome stable). Mặc định cloak.
      CHATGPT_BROWSER_ENGINE: String(process.env.CHATGPT_BROWSER_ENGINE || "cloak"),
    },
  }],
};
