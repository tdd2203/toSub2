# Browser login auto-flow — gaps + fix plan

Tổng hợp các lỗi gặp khi tạo 4+ account qua CloakBrowser browser lane và kế hoạch fix từng cái. Mục tiêu: **từ bật lệnh POST tới sub2api JSON ghi hoàn toàn không cần drive thủ công**.

## Gaps đã gặp (xếp theo tần suất)

### G1 — LANDING click Login/Sign up
**Triệu chứng**: worker ở landing page `chatgpt.com/`, visible button `<button>Log in</button>`, nhưng Playwright locator click + JS dispatchEvent đều không mở modal.

**Root cause**: ChatGPT là React SPA. HTML render từ server, nhưng `onClick` handler chỉ attach sau khi React hydrate (1-3s). Click quá sớm → fire vào DOM nhưng React synthetic listener chưa gắn → modal không mở.

**Fix hiện tại** (commit `097de6a`): sau `page.goto` chờ `waitForLoadState('networkidle', 15s)` + `waitForTimeout(1500ms)` → React xong hydrate rồi mới click. Chạy OK từ account thứ 4.

### G2 — WORKSPACE_SELECT click account card
**Triệu chứng**: `/choose-an-account` page, worker vào handler, click JS evaluate walk ancestor không fire React onClick.

**Root cause**: cùng G1 — page vừa redirect vào, React hydrate chưa xong.

**Fix hiện tại** (commit `ce3e943`): WORKSPACE_SELECT handler chờ networkidle + 1.2s trước click.

### G3 — OAUTH_CONSENT click Continue
**Triệu chứng**: consent page `/sign-in-with-chatgpt/codex/consent`, button "Continue" visible, worker không click.

**Fix hiện tại** (commit `ce3e943`): tương tự, chờ hydrate.

### G4 — PROFILE Full name + Age fill
**Triệu chứng**: field "Full name" / "Age" trống, worker không fill.

**Root cause**: OpenAI dùng Material-style floating label (không `<label for>`), `page.getByLabel` không match. Age field có mask hoặc là birthday MM/DD/YYYY.

**Fix hiện tại** (commit `3a014f1`): fallback `getByLabel → getByPlaceholder → input[type=text]:nth(N)`. Age handler phân biệt isBirthday (type từng digit theo mask) vs age number.

### G5 — PHONE_NUMBER fill phone input
**Triệu chứng**: `/add-phone` page, worker không fill phone number. User phải paste thủ công `+84...`.

**Root cause**: 
- (a) Country dropdown default +1 US, worker không chọn Vietnam → nhưng paste full `+84...` E.164 vào input thì OpenAI auto-detect country. Trick này user tìm ra.
- (b) Playwright `fill` có thể bị React controlled input reject (fill set `.value` nhưng React không update state).

**Fix hiện tại** (commit `3a014f1`): paste full E.164 (bypass country dropdown). Vẫn chưa đủ — fill fail ở hongdoan.

### G6 — PHONE_OTP fill OTP code
**Triệu chứng**: `/phone-verification` page, worker chưa fill OTP code từ SMSCode.

**Root cause**: tương tự G5, React controlled input + locator miss.

### G7 — Worker loop re-fire markers
**Triệu chứng**: handler re-run mỗi tick nếu URL không đổi → prompt bật-tắt giữa 2 state → noisy.

**Root cause**: loop structure không check "handler succeeded" vs "handler failed silently". Nếu URL không advance sau handler, loop re-tries.

## Kế hoạch fix comprehensive

### P1 — Universal React hydrate helper
```js
async function waitForReactReady(page) {
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(1200);
  // Optional strict: wait for a React root marker
  await page.waitForFunction(() => {
    return document.readyState === 'complete' &&
      (document.querySelector('[data-reactroot], #__next, [id*="react"]') || true);
  }, { timeout: 5000 }).catch(() => {});
}
```
Gọi ở ĐẦU mỗi handler. Thay vì copy-paste wait trong từng handler.

### P2 — Universal reactSafeFill helper
```js
async function reactSafeFill(page, locator, value) {
  await locator.waitFor({ state: 'visible', timeout: 15_000 });
  await locator.click({ timeout: 5000, force: true });
  await locator.press('End');
  for (let i = 0; i < 50; i++) await locator.press('Backspace');
  await locator.type(value, { delay: 30 });
  // React controlled input: dispatch input event để state update
  await locator.evaluate((el, val) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}
```
Giải quyết G5/G6 — React controlled input cần native setter + input event.

### P3 — Universal reactSafeClick helper
```js
async function reactSafeClick(page, locator) {
  await locator.waitFor({ state: 'visible', timeout: 10_000 });
  // 1. Real Playwright click (CDP mouse)
  try { await locator.click({ timeout: 5000, force: true }); return; } catch {}
  // 2. JS MouseEvent dispatch
  await locator.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, view: window, button: 0,
      clientX: rect.left + rect.width/2, clientY: rect.top + rect.height/2 };
    ['mousedown', 'mouseup', 'click'].forEach(t => el.dispatchEvent(new MouseEvent(t, opts)));
    el.click();
  });
}
```

### P4 — Success verification sau mỗi handler
```js
async function withVerify(session, kind, handler, expectUrlRegex) {
  const beforeUrl = session.page.url();
  await handler();
  await session.page.waitForTimeout(1500);
  const afterUrl = session.page.url();
  if (beforeUrl === afterUrl && expectUrlRegex && !expectUrlRegex.test(afterUrl)) {
    console.log(`[${kind}] URL không advance (${beforeUrl}) — handler fail`);
    // Dump DOM để debug
    return false;
  }
  return true;
}
```

### P5 — Smart form detection
Thay vì hardcode SELECTORS, scan all visible inputs mỗi lần, map theo:
- Label text liền kề
- aria-label / placeholder
- Position in form (first input = email, second = password/number, ...)

### P6 — Test harness
Mock HTML pages cho mỗi stage (modal signup, email verify, profile, phone, consent). Run worker against local mocks → test selector + fill + click reliability without burn account.

### P7 — Document user drive-points
Một số bước có thể KHÔNG BAO GIỜ auto reliably:
- Arkose FunCaptcha / reCAPTCHA (nếu OpenAI serve)
- Email that requires physical SIM OTP đọc tay
- Cloudflare Challenge interstitial

Document rõ: những bước này bạn drive thủ công, worker tự tiếp phần sau.

## Prioritize

Thực tế các bug phổ biến nhất hiện tại:
1. **G5 (PHONE_NUMBER fill)** — ảnh hưởng ~50% signup → ưu tiên P2 reactSafeFill
2. **G1-G3 (click fail)** — fixed phần lớn bằng React hydrate wait (commit 097de6a, ce3e943) — monitor thêm
3. **G4 (PROFILE fill)** — fallback đã có, cần test lại với reactSafeFill
4. **G7 (loop noise)** — low priority, không ảnh hưởng correctness

## Milestones

- [ ] P1 waitForReactReady helper (1h)
- [ ] P2 reactSafeFill helper + apply to EMAIL_OTP/PASSWORD/PROFILE/PHONE_NUMBER/PHONE_OTP (2h)
- [ ] P3 reactSafeClick helper + apply to LANDING/WORKSPACE/OAUTH (1h)
- [ ] P4 success verification wrapper (1h)
- [ ] Test with 5 account liên tục full-auto, log drive-points (3h)
- [ ] Document user drive-points còn lại (0.5h)

Tổng ~8-10h fix comprehensive + validate.
