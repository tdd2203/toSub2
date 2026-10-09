# toSub2

toSub2 is a local web console that creates ChatGPT accounts, completes Codex OAuth for them, and delivers the result to a Sub2API pool. It manages the whole pipeline in one place: temp mailboxes, proxy allocation, SMS number rental, per-account device identity, authorization, upload, and repair of accounts that later fail.

Most of the rules in this system come from running it against real accounts and watching which ones survived. They are written down in [Operating rules](#operating-rules) and enforced in code, not left to the operator.

> This project is not affiliated with OpenAI. Upstream endpoints and risk controls change without notice.

## The console in four steps

The UI is in Vietnamese or Chinese (switch in the top bar) and follows the pipeline top to bottom.

| Step | What you do |
|---|---|
| 1. Prepare tools | Configure proxies, the SMS platform, and the mail API |
| 2. Connect Sub2API | Enter the backend address and admin key, pick target pools |
| 3. Create accounts | Generate mailboxes or paste a batch, then start the tasks |
| 4. Manage and upload | Filter, re-authorize, set up 2FA, download, upload to Sub2API |

Up to 20 tasks run at once; the rest queue. A batch can hold 500 accounts. Every action on an account (login, retry, re-authorize, 2FA setup, pool repair) takes a per-email lock, so a double click never starts two workers for the same account.

## How an account is made

1. A mailbox is created on the temp-mail service, or you supply your own email plus a code API.
2. A proxy is allocated to the account and stays with it for life.
3. The account signs up (or logs in) with an email code, a password, or both. TOTP is generated and submitted automatically when 2FA is on.
4. If OpenAI asks for a phone number, one is rented from the selected SMS platform and the code is read back automatically.
5. A workspace is selected and the Codex OAuth code is exchanged for tokens.
6. `sub2api-import-oauth.json` is written, ready to upload or download.

A checkpoint is saved as soon as email verification succeeds, so an interrupted task resumes at the phone step instead of requesting a new email code.

### Two signup lanes

| Lane | Selected by | How it works |
|---|---|---|
| `browser` (mandatory for signup) | Always for new accounts; see "Lane routing" below | A real Chromium driven by Patchright or CloakBrowser. An adaptive state machine recognizes each page from its URL first, then its content, and acts on it. |
| `tls` (refresh only, deprecated for signup) | `TOSUB2_ALLOW_TLS_SIGNUP=1` (dev-only) | Pure protocol requests through `curl_cffi` with a Chrome TLS fingerprint. Still used by `chooseRefreshLane` for mature-account refreshes. |

The browser lane keeps one persistent profile per account, keyed by the same device id the TLS lane uses, so an account keeps its identity if it moves between lanes. The Codex OAuth callback (`localhost:1455`) is intercepted inside the browser, so many browsers can run at once without binding the port.

2FA setup and add-password still run on the TLS lane.

### Lane routing

Signup is always done on the browser lane. Refresh / regenerate / auto-repair pick a lane per account from `chooseRefreshLane` in [src/console-server.mjs](src/console-server.mjs):

| Case | Lane | Why |
|---|---|---|
| Signup (new account) | browser (mandatory) | Sentinel/Arkose and the OAuth callback need a real browser. |
| `source=system`, age `< 60 days` since signup | browser | A young account has a narrow fingerprint history; TLS refresh looks like drift. |
| `source=system`, age `≥ 60 days` since signup | TLS (`mode=refresh`) | Mature account, refresh_token is stable, curl is cheap and quiet. |
| `source=external` (imported from outside) | browser | No local Chromium profile to launch into on the first touch; must build one. |
| curl refresh returns `REFRESH_TOKEN_INVALID` | browser (auto-escalate) | `fallbackFromRefresh` sets the force flag and re-enqueues on the browser lane. |
| Operator presses **Force Browser Verify** in the UI | browser | One-shot override that ignores the 60-day cutoff and the `source` rule. Flag auto-clears after the next successful completion. |

The cutoff reads from `TOSUB2_REFRESH_BROWSER_AGE_DAYS` (default 60). The signup-completion timestamp is set once by `handleChildClose` as soon as `sub2api-import-oauth.json` is written for the first time; later refreshes do not overwrite it. Full details and a decision diagram are in [docs/lane-routing.md](docs/lane-routing.md).

## Operating rules

These are the constraints the system enforces. Each one exists because ignoring it lost accounts.

**One IP is shared fate.** When one account on an IP is deactivated, the others on that IP tend to follow. So:

- A proxy is mandatory. The browser lane refuses to sign up without one (`BROWSER_PROXY_REQUIRED`); using the machine's own IP is an explicit choice in the UI, never a silent fallback.
- An account keeps the proxy it registered with. Changing it later also updates the import file and the Sub2API record.
- Every endpoint has a lifetime ledger of accounts that ran on it and how many were deactivated. An endpoint is treated as burned, and no longer allocated, at 5 deactivations, or when at least 2 accounts ran on it and half or more died. The proxy list shows a "needs new IP" warning before that point.

**Signup is throttled by rate, not by concurrency.** OpenAI stops sending verification emails after about two signups per minute from one IP; the request is accepted and the email never arrives. New registrations are limited to 2 per rolling 60 seconds per IP, and extra ones wait in the queue. Accounts that already exist are not limited and can do phone, OAuth, and re-login in parallel.

**A device identity is fixed per account.** The device id is derived from the email. From it the system picks one real Mac configuration (screen, cores, memory, heap that actually ship together) and keeps it across every re-login. A fingerprint that changes each login is itself a signal, and so is one shared by every account on an IP. The TLS profile is likewise stamped on the account at creation and never drifts: existing accounts stay on `chrome146`, new ones get the current new-account profile.

**Phone numbers are single use.** A number is used for one account. Only when the provider keeps returning used numbers (8 rejections in a row) is the cap relaxed to 2 uses, and never beyond. Blocked numbers and use counts live in a ledger, and a number prefix that produced a suspicious result is put on cooldown.

**Repair must not become churn.** The pool watcher waits at least 15 minutes between repair attempts on the same account, with exponential backoff up to 2 hours. A clear `account_deactivated` or `account_deleted` response marks the account permanently skipped, and its email is recorded so it is not retried or reused.

**Deactivation has several causes at once.** In practice it tracks the IP, the email domain, and batch enforcement together. A clean fingerprint does not save an account on a burned IP or a burned domain, so judge a change only against fresh domains on clean IPs.

**The lane is chosen by the account, not the operator.** Signup is always browser. Refresh is browser for young or external-imported accounts and TLS for mature ones. The UI only exposes one override: **Force Browser Verify**, a one-shot flag for debugging drift suspicions. See `chooseRefreshLane` and [docs/lane-routing.md](docs/lane-routing.md).

## Requirements

- Node.js 20 or later (22 recommended).
- Python 3.9 or later with `curl_cffi` (pinned in `requirements.txt`).
- For the browser lane: Chrome Stable for Patchright, or CloakBrowser, which downloads its own build on first run.
- macOS is the primary platform. Secrets are stored in the Keychain, and the temp-mail integration reads its key from there. On Windows secrets are encrypted with DPAPI under `%LOCALAPPDATA%\toSub2\credentials`. On Linux passwords, 2FA secrets, and account proxies are not persisted.

## Install and run

```bash
git clone https://github.com/tdd2203/toSub2.git
cd toSub2
npm install
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
TOSUB2_PYTHON="$PWD/.venv/bin/python" npm run dev
```

The console opens at `http://127.0.0.1:4399`. `TOSUB2_PYTHON` must point at the interpreter binary, not the `.venv` directory; without it the system `python3` is used.

```bash
npm run dev -- --port 4400
npm run dev -- --host 0.0.0.0
```

The console has no login. Bind it to the LAN only on a network you trust.

### Run as a daemon

```bash
npm run daemon:start
npm run daemon:logs
npm run daemon:restart
npm run daemon:stop
```

These wrap PM2 through `npx` using `ecosystem.config.cjs`. On shutdown the server cancels watcher requests, stops running tasks, and saves their state before exiting. Queued tasks are restored on the next start.

### Checks

```bash
npm run check
```

Runs syntax checks on every module and the smoke tests against local mock servers. CI runs the same command on Ubuntu and Windows.

## Configuration

### Proxies

Step 1 takes a proxy list. Accepted forms:

```text
http://user:pass@host:port
socks5h://user:pass@host:port
host:port:user:pass
```

- **Shared pool and per-domain proxies.** A proxy can be reserved for one email domain, which removes it from the shared pool. A domain can have several proxies, and its accounts are spread evenly across them.
- **Session rotation.** If the username or password carries a session field (`-sid-xxxxxxxx-t-20`, `-JP-12345678-20m`), a fresh session id is generated per task and rotated on risk-control responses, for up to 10 responding sessions. A fixed proxy is never rotated; on failure the task asks for a different proxy.
- **Risk-control retries.** A security-check page during the real flow is retried on the same exit up to 3 times before rotating. Business errors such as an unusable phone number do not trigger a proxy retry. 20 consecutive connection failures stop the task.
- **Browser lane.** Patchright cannot authenticate against a SOCKS5 proxy; use an HTTP proxy or set `CHATGPT_BROWSER_ENGINE=cloak`.

The proxy password is stored in the system credential store, never in task metadata or logs.

### Mail

The built-in mailbox creator talks to the temp-mail service and reads its API key from the macOS Keychain entry `magicskill-email-api`. With the key present, you pick a domain, a count, and an optional tag, and the generated addresses go straight into the batch box with their code API attached. Codes are polled automatically; if none arrives within 45 seconds a new one is requested, up to twice.

Without the key you can still paste any email with its own code API, or type codes by hand.

### SMS platforms

| Platform | Notes |
|---|---|
| SMSCode | Platform, country, operator, and a maximum price tier |
| ViOTP | Vietnam and Laos, service picked from the live price list |
| SMSBower | Country picked from a live price and stock list, with a price ceiling |
| LubanSMS | API key and service id |
| Custom | One `+phone----code-api` per line, up to 500 |

Rental, polling, code extraction, and submission are automatic. Every rental, cancellation, and refund is recorded per task, so the console shows what each account cost in SMS. Manual number and manual code entry always remain available.

### Sub2API

Step 2 takes the backend address and the admin API key (`x-api-key`). "Read config" loads the pools and proxies. Upload writes the OAuth account into the chosen pools, assigns the account's own proxy on the Sub2API side, and marks the task as uploaded. Concurrency, load factor, priority, and allowed models are optional overrides.

With the watcher on, every 5 minutes the server reads `error` accounts on the `openai` platform, matches them to local tasks by email, and re-logs-in the ones whose last login was fully automatic and whose credentials are still readable. The repaired credential overwrites the existing remote account by id; nothing is duplicated, and remote settings such as model mappings are kept.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `ONBOARDING_HOST` / `ONBOARDING_PORT` | `127.0.0.1` / `4399` | Listen address |
| `ONBOARDING_OUTPUT_ROOT` | `tmp/chatgpt-onboarding-console` | Data directory |
| `TOSUB2_PYTHON` | `python3` | Python interpreter for the TLS transport |
| `TOSUB2_SIGNUP_BACKEND` | `browser` | Deprecated for signup (ignored unless `TOSUB2_ALLOW_TLS_SIGNUP=1`); still honored as a fallback label |
| `TOSUB2_ALLOW_TLS_SIGNUP` | `0` | Dev-only escape hatch to let a client payload force the TLS lane for signup |
| `TOSUB2_REFRESH_BROWSER_AGE_DAYS` | `60` | Age cutoff for `chooseRefreshLane` — below this many days since signup, refreshes stay on the browser lane |
| `TOSUB2_TLS_PROFILE` | `chrome142` | `curl_cffi` profile stamped on new accounts |
| `CHATGPT_BROWSER_ENGINE` | `patchright` (`cloak` under PM2) | Browser lane engine: `patchright` (Chrome Stable) or `cloak` (CloakBrowser, supports SOCKS5 with credentials) |
| `TOSUB2_BROWSER_MANUAL` | off | `1` keeps the browser open for manual assist |
| `PROXY_SIGNUP_MAX_PER_WINDOW` | `2` | New signups per IP per window |
| `PROXY_SIGNUP_WINDOW_MS` | `60000` | Length of that window |
| `PROXY_BURN_THRESHOLD` | `5` | Deactivations that burn an endpoint outright |
| `PROXY_BURN_RATIO` / `PROXY_BURN_MIN_SAMPLE` | `0.5` / `2` | Ratio rule for small samples |
| `MAIL_AUTO_RESEND_AFTER_MS` | `45000` | Wait before requesting a new email code |
| `SUB2API_MONITOR_INTERVAL_MS` | `300000` | Pool watcher interval |
| `SUB2API_AUTO_REPAIR_COOLDOWN_MS` | `900000` | Minimum gap between repairs of one account |

If the installed `curl_cffi` does not support the requested profile, it falls back to a compatible one, and the User-Agent, Client Hints, and Sentinel environment follow the profile actually used.

## Batch format

One account per line. Fields are recognized by shape, so order is free:

```text
name@example.com
name@example.com----https://mail.example/messages/token
name@example.com----password----JBSWY3DPEHPK3PXP
name@example.com----password----https://mail.example/messages/token----JBSWY3DPEHPK3PXP
name@example.com--------JBSWY3DPEHPK3PXP
```

`|`, tab, `::`, comma, semicolon, and runs of spaces also work as separators. When a line can be split more than one way, the parser reports an error and asks for `----` instead of guessing. The email is the key, so importing the same address again updates the existing task.

## Data and files

Everything lives under the data directory:

| Path | Content |
|---|---|
| `toSub2.db` | SQLite database: tasks, logs, proxy pool and ledger, phone ledger, deactivated emails, SMS costs, watcher state, console settings |
| `<task-id>/` | Per-task session, checkpoint, and `sub2api-import-oauth.json` |

Console settings, including SMS platform and Sub2API keys, are saved in the database so they survive a browser change. Passwords, 2FA secrets, and proxy credentials go to the system credential store instead.

## Command line

Both workers can run without the console:

```bash
node src/protocol-login.mjs --help
node src/browser-login.mjs --help
```

`npm run browser:probe` launches the browser lane against a neutral probe URL and writes a fingerprint report without contacting OpenAI.

## Security

- The data directory holds cookies, OAuth tokens, checkpoints, and API keys. Never commit or share it; `tmp/` and `*.db` are in `.gitignore`.
- An import file contains live authorization tokens. Treat it like a password file.
- The console has no authentication and is meant for the local machine or a trusted LAN.

## Project documents

- [CHANGELOG.md](CHANGELOG.md)
- [Commit and versioning standard](docs/QUY-CHUAN-COMMIT-PHIEN-BAN.md)
- [Lane routing — chi tiết luồng refresh / verify](docs/lane-routing.md)
- [Browser lane: known gaps and fix plan](docs/browser-login-auto-fix-plan.md)

## Disclaimer

Use this only with accounts you own or are authorized to manage. You are responsible for complying with OpenAI's terms, the rules of the services you connect, and your local law.

## License

[MIT](LICENSE). Maintained by [tdd2203](https://github.com/tdd2203).
