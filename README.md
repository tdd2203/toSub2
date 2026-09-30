# toSub2

> Fork of [poxiao33/toSub2](https://github.com/poxiao33/toSub2), optimized for security and user experience.

toSub2 is a local web tool that logs into ChatGPT and completes Codex OAuth through protocol requests, automatically decides whether an account still needs a phone number, and produces a JSON file ready to import into sub2api.

> This project is not affiliated with OpenAI. Upstream login endpoints can change at any time.

![toSub2 console](docs/console.png)

## Workflow

1. Sign in to ChatGPT with an email verification code or a password.
2. When the account has 2FA enabled, generate and submit the TOTP automatically.
3. Start Codex OAuth (authorization login).
4. Read the server response to decide whether the account is already bound to a phone number.
5. If it is not, go through SMS verification: manual number, LubanSMS, SMSBower, or a custom code API.
6. Pick a workspace and exchange the OAuth token.
7. Generate a standard `sub2api-data` import file.

## Features

- Local web console that manages many login tasks at once.
- Up to 20 tasks run in parallel; the rest queue automatically.
- Manual email verification codes, or automatic pickup through an email code API.
- Password login, plus 2FA after either a password or an email-code login.
- Built-in temporary mailbox creation: pick a domain (root or subdomain), a count and an optional tag, generate the addresses, and drop them straight into the batch box.
- Accounts already signed in to ChatGPT can create new TOTP 2FA one at a time or in bulk, without first binding a phone number or finishing Codex OAuth. The activation code is generated and submitted automatically, the secret never lands in the protocol log, and the original flow can continue afterwards.
- Passwordless accounts can get a random strong password added, one at a time or in bulk; accounts that already have one are skipped. Email codes can be picked up automatically or entered by hand; on success the local account record is updated. Only a saved email-login checkpoint is required, not a phone binding or Codex OAuth.
- Accounts already bound to a phone number are skipped automatically.
- Unbound accounts support a manual phone number and code, plus automatic number rental and code pickup via LubanSMS, SMSBower, or a custom number pool.
- A checkpoint is saved as soon as email login succeeds, so an interrupted run can resume at the phone step.
- Single and bulk re-authorization: "re-authorize" reuses an existing refresh token first, while "re-login and authorize" skips the refresh token and old checkpoint and forces a full login and authorization.
- Pagination, precise filtering, cross-page multi-select, bulk delete, stop-all, bulk re-authorization, and bulk download.
- Optional five-minute watch over faulty Sub2API accounts: tasks that last logged in fully automatically are re-logged-in and their remote authorization is refreshed.
- Final output is the sub2api import format, with a timestamp appended to the download filename.

## Requirements

- Node.js 20 or later (Node.js 22 recommended).
- Python 3.9 or later. The default protocol-login flow needs `curl_cffi` (a browser-TLS-fingerprint HTTP library), even without a proxy.
- On macOS, passwords, 2FA secrets, and account proxies are persisted in the Keychain.
- On Windows they are encrypted with the current user's DPAPI; the ciphertext lives in `%LOCALAPPDATA%\toSub2\credentials` and can only be decrypted by the same Windows user.
- On Linux the email-code flow still works, but passwords, 2FA secrets, and account proxies are not persisted; after a restart, queued tasks that had a proxy configured will not silently fall back to the local network.

## Install and run

```bash
git clone https://github.com/tdd2203/toSub2.git
cd toSub2
npm install
python -m pip install -r requirements.txt
npm run dev
```

Default address:

```text
http://127.0.0.1:4399
```

Use a different port:

```bash
npm run dev -- --port 4400
```

Allow devices on the local network:

```bash
npm run dev -- --host 0.0.0.0
```

LAN mode has no access authentication, so only use it briefly inside a trusted network.

### Run as a daemon with PM2

The pool watcher needs the console service to keep running. For automatic restart after a crash, or start on boot, use the bundled PM2 config:

```bash
npm install -g pm2
npm run daemon:start
pm2 save
pm2 startup
```

`pm2 startup` prints a system command; run it to finish enabling start on boot. Defaults are `127.0.0.1:4399` and the in-project data directory `tmp/chatgpt-onboarding-console`.

To keep an existing data directory and open the LAN, pass the variables on first start. macOS/Linux:

```bash
ONBOARDING_OUTPUT_ROOT=/path/to/existing-data ONBOARDING_HOST=0.0.0.0 npm run daemon:start
```

Windows PowerShell:

```powershell
$env:ONBOARDING_OUTPUT_ROOT="C:\path\to\existing-data"
$env:ONBOARDING_HOST="0.0.0.0"
npm run daemon:start
```

Common management commands:

```bash
npm run daemon:restart
npm run daemon:logs
npm run daemon:stop
```

PM2 only restarts the process after an abnormal exit. On a normal shutdown, toSub2 still cancels watcher requests, stops login tasks, and saves task state first.

## Account proxy and TLS fingerprint

The "Proxy IP" box at the top of the page sets the proxy used for account login. Supported formats:

```text
http://user:pass@host:port
socks5h://user:pass@host:port
socks5h://account-id:proxy-secret-JP-91977332-20m@proxy.example.com:1000
```

A format helper next to the box converts a `host:port:user:pass` string into a full URL for either SOCKS5 or HTTP.

If the username contains a session field like `-sid-xxxxxxxx-t-20`, or the password contains one like `-JP-12345678-20m`, toSub2 generates a fresh session id for every task and uses `curl_cffi` with a Chrome TLS fingerprint to reach `chatgpt.com` and check the exit. With no proxy configured it uses `chrome146` directly and does not screen fingerprints before a normal task starts. On a Cloudflare challenge it tries the local solver first, and only if that fails does it run a single shared direct-connection fingerprint screen as a fallback, then retries the task with the chosen fingerprint. An explicit `--tls-profile` or `TOSUB2_TLS_PROFILE` pins a fingerprint; pass `auto` to enable probing. If the local `curl_cffi` or its underlying library does not support the requested fingerprint, it falls back to a compatible one and passes the real result on to later steps. The protocol requests' User-Agent, Client Hints, OAuth headers, and the Sentinel browser environment used when filling in account details all follow the final fingerprint version rather than mixing a fixed version or a different OS.

HTTP risk-control responses rotate the session, using up to 10 responding proxy sessions; pure connection failures (TLS, timeout) do not count against those 10, but 20 consecutive connection failures also stop the task to avoid an endless loop on a bad network. Once the proxy check passes, if a 403 HTML risk-control page appears again during email login, 2FA, phone binding, workspace selection, or OAuth, the task clears the failed login state, rotates to a new proxy session, and retries from the start of the current stage. A fixed proxy with no recognizable session field is not rotated; on failure it simply tells you to change the proxy.

After the first proxy check passes, if the real login and authorization flow hits a clear security-check page again, it keeps the current proxy exit and retries up to 3 times; the phone-code send endpoint only uses that strategy on a `400/409` that also carries a security-check response header or an actual security-check page. Only after 3 retries still trip risk control does it rotate the proxy and re-authorize. Business errors like an unusable phone number or `invalid_state` JSON do not trigger a proxy retry; they only prompt you to change the current phone number.

When a response includes a runnable Cloudflare challenge config, toSub2 runs the parent challenge and the Turnstile sub-challenge inside the current `curl_cffi` session first. After it gets `cf_clearance`, it replays the original request over the same proxy exit, TLS fingerprint, and cookie session. Only if the challenge cannot complete, or the replay is still blocked, does it fall back to the same-exit retry and random session id above. This runtime depends on `jsdom`, installed automatically by `npm install`.

Sentinel no longer uses a bundled static PoW/DX generator. Each login session downloads the Sentinel loader and the current SDK live, runs them in an isolated `jsdom` parent page and iframe, and submits the SDK's requests through the current `curl_cffi` session. Generation reuses the account's current proxy, cookies, device id, TLS fingerprint, User-Agent, and platform language; when the proxy session or `sid` changes, the old Sentinel runtime is destroyed and re-initialized. It produces `OpenAI-Sentinel-Token` as required, plus `OpenAI-Sentinel-SO-Token` when Session Observer data is present.

An empty proxy box means the local network is used. Page settings are stored in the current browser's `localStorage`; creating a task, retrying, and re-authorizing read the box's latest value. The proxy a task actually used is also saved in the system credential store so queued tasks can be restored after a restart. The proxy password is never written to `job-meta.json` or the logs.

Python helper processes use `python3` (macOS/Linux) or `python` / `py -3` (Windows) by default. If several Python versions are installed, set `TOSUB2_PYTHON` to the interpreter path.

## Batch add format

One account per line. toSub2 recognizes the email, password, email code API, and 2FA secret by their shape, so field order is not fixed. The existing `----` format is still fully supported:

```text
email
email----email-code-api
email----password
email----password----2FA-secret
email----password----email-code-api
email----password----email-code-api----2FA-secret
email----email-code-api----2FA-secret
email--------2FA-secret
```

Example:

```text
name@example.com
name2@example.com----https://mail.example/messages/account-token
name3@example.com----password----JBSWY3DPEHPK3PXP
name4@example.com----password----https://mail.example/messages/name4
name5@example.com----password----https://mail.example/messages/name5----JBSWY3DPEHPK3PXP
name6@example.com----https://mail.example/messages/account-token----JBSWY3DPEHPK3PXP
name7@example.com--------JBSWY3DPEHPK3PXP
```

Fields may also be separated by `|`, tab, `::`, comma, semicolon, or runs of spaces:

```text
https://mail.example/messages/name|JBSWY3DPEHPK3PXP|password|name@example.co.uk
JBSWY3DPEHPK3PXP::name+tag@example.dev::password
```

The parser first locks the full URL, the standalone email, and the Base32 2FA secret, then infers the separator from their boundaries and keeps the rest as the password, so a password containing `|` and similar characters is preserved as far as possible. Legitimate hyphens inside an email are merged back into the full email rather than treating the local part as a password. If a line has more than one possible split, more than one full email, or a URL whose comma or semicolon could be read as a separator, it reports a clear error and asks you to use `----` instead of guessing silently. An account with only an email and a 2FA secret still uses `email--------2FA-secret` for an empty password; `email----password--------2FA-secret` is also parsed correctly. With only an email, one Base32 field, and an email API, the Base32 field is kept as the password before the API and treated as the 2FA secret after it; if another plain field is also present, the Base32 field is the 2FA secret. A lone `http://` or `https://` field is treated as the email API; a "URL-shaped password" is not auto-detected. Emails support multi-level domains and common prefixes with dots, hyphens, underscores, and plus signs, and are not limited to a `.com` suffix. The email is the only key, so re-importing updates the existing task.

## SMS provider config

The "SMS platform" area at the top of the page opens a shared config screen. Each platform is configured separately and saved to the current browser's `localStorage`; the server does not persist API keys.

Supported today:

- LubanSMS: enter the API key and the service id.
- SMSBower: enter the API key, click "check prices", then pick a country from the dropdown. The list shows country names, prices, and stock, sorted by price.
- Custom code API: one `+phone----code-api` per line, up to 500 at once. Duplicate numbers keep the last line, and parallel tasks take unassigned numbers in order.

```text
+8613711111111----https://example.com/messages/13711111111
+8613822222222----https://example.com/messages/13822222222
```

When a task reaches the phone step it rents a number from the selected platform. SMSBower rental carries the highest price you chose, so a later price rise does not buy at a higher one. The custom code API records the existing code before sending an SMS and only submits a newer one. The server polls SMS automatically, extracts the standalone 6-digit code, and submits it. Manual number and manual code flows are always available.

API keys are sent to the local service only with a rental request; they are never written to task metadata, the protocol log, or export files.

## Upload straight to Sub2API

When a task finishes, use the "upload" button on a single task, or "upload to Sub2API" in the top bulk actions, to write the generated OAuth account straight into a chosen Sub2API pool.

On first use, fill in the "Sub2API" config area:

- The Sub2API backend address, for example `http://127.0.0.1:8080`.
- The admin API key, sent in the `x-api-key` header.
- Click "read config" to load the target pools and proxy list. Pools support multi-select; with none chosen, the backend's default pool is used.
- Optionally set a shared proxy IP, concurrency, load factor, and priority. Leave a number blank to keep each account's own value.
- Optionally list allowed models, one per line or comma-separated, for example `gpt-5`, `gpt-5-mini`.

Upload options are saved to the current browser's `localStorage`. In a bulk upload, unfinished tasks are skipped, and the backend's reported failure count is shown in the console.

### Sub2API pool watch

With "watch faulty accounts every 5 minutes" enabled in the Sub2API config, the local service reads `error`-status accounts on the `openai` platform page by page, extracts the email, and matches a local task. With pools configured it checks only the selected pools; otherwise it checks all OpenAI accounts.

A task is re-logged-in and re-authorized automatically only when all of these hold:

- The last full login succeeded, and the password, email code, and login 2FA were none of them entered by hand.
- The last password and 2FA secret are still readable from the system credential store, and the email code API still exists.
- The task is not currently running, queued, or doing something else.

A manually entered phone binding or phone code does not affect eligibility, since an account usually only needs to bind once. After a successful re-authorization, toSub2 updates the credential by the Sub2API remote account id rather than creating a duplicate through the bulk-create endpoint; non-sensitive settings such as remote model mappings are preserved, and the account is restored to a schedulable state.

A temporary network error, proxy risk control, `429`, or a brief Sub2API outage only triggers a 5-minute cooldown. If login returns a clear `account_deactivated`, `account_deleted`, or similar permanent status, the task is marked permanently skipped and not retried on the next pass. You can still click "re-login and authorize" to re-check an account by hand.

With the watch on, the Sub2API backend address and admin API key are saved by the local service in `sub2api-monitor.json` in the data directory, but never in task metadata, the protocol log, the status endpoint, or export files.

## Output files

Task run data is saved by default under:

```text
tmp/chatgpt-onboarding-console/<task-id>/
```

Each finished task produces `sub2api-import-oauth.json`. Single and bulk downloads both output the standard `sub2api-data` format.

You can also use the CLI directly:

```bash
node src/protocol-login.mjs --email you@example.com --verbose
```

See all options:

```bash
node src/protocol-login.mjs --help
```

## Security notes

- `tmp/` holds cookies, OAuth tokens, and login checkpoints. Never commit or share it.
- On Windows, saved passwords and 2FA secrets are encrypted for the current user with DPAPI and are not written in plaintext to the task directory.
- A sub2api import file contains usable authorization tokens; protect it like a password file.
- Never commit API keys, passwords, 2FA secrets, verification codes, cookies, or tokens to a Git repository.
- The web console is for local or trusted-LAN use; it has no authentication for a public deployment.
- Only work with accounts you own or are clearly authorized to manage.

## Disclaimer

This project is for learning, research, and managing your own accounts. It is not affiliated with or endorsed by OpenAI. You are responsible for following OpenAI's terms, the relevant platform rules, and your local laws. Any consequences of endpoint changes, account limits, data leaks, or misuse are your own.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for version history and upgrade notes.

## License

[MIT](LICENSE)

toSub2 was originally created by [poxiao33](https://github.com/poxiao33). Thank you to the original author for the project this fork builds on.
