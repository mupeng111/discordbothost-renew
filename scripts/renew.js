// DiscordBotHost auto-renew — same steps as doing it in the browser:
//   1. Open the panel; if logged out, go through Discord OAuth (account + password).
//   2. Open the bot page and read its status / expiry.
//   3. If it is online and the run is not about to end: nothing to do, exit 0.
//   4. If it is offline (renew only opens then): pass the Turnstile check,
//      click "Renew for 7 days", confirm the new expiry.
//   5. If the bot is stopped after renewing: click Start, wait until Online.
// Secrets (GitHub repo Settings -> Secrets and variables -> Actions):
//   DISCORD_EMAIL     Discord account email
//   DISCORD_PASSWORD  Discord account password
//   BOT_ID            bot id on the panel (default: 8edd6402)
const { chromium } = require('playwright');
const fs = require('fs');

const PANEL = 'https://my.discordbothost.com';
const BOT_ID = process.env.BOT_ID || '8edd6402';
const BOT_URL = `${PANEL}/bots/${BOT_ID}`;
const EMAIL = process.env.DISCORD_EMAIL;
const PASSWORD = process.env.DISCORD_PASSWORD;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const LOGGED_OUT = /log in to see your bots/i;

async function shot(page, name) {
  try {
    fs.mkdirSync('artifacts', { recursive: true });
    await page.screenshot({ path: `artifacts/${name}.png`, fullPage: true });
  } catch {}
}

async function bodyText(page) {
  return (await page.locator('body').innerText()).replace(/\s+/g, ' ');
}

async function loginIfNeeded(page) {
  await page.goto(PANEL, { waitUntil: 'domcontentloaded' });
  await sleep(3000);
  let text = await bodyText(page);
  if (!LOGGED_OUT.test(text) && !page.url().includes('discord.com')) {
    console.log('already logged in');
    return;
  }
  console.log('logged out — starting Discord OAuth login');
  const loginLink = page.locator('a:has-text("Log in"), button:has-text("Log in")').first();
  if (await loginLink.count()) { await loginLink.click(); await sleep(4000); }

  // Discord OAuth page may go straight to the authorize screen when the
  // Discord session exists, or show the email/password form first.
  for (let i = 0; i < 10; i++) {
    if (page.url().includes('discordbothost.com') && !page.url().includes('discord.com')) break;
    const emailInput = page.locator('input[name="email"]');
    if (await emailInput.count()) {
      if (!EMAIL || !PASSWORD) throw new Error('DISCORD_EMAIL / DISCORD_PASSWORD secrets are not set');
      await emailInput.fill(EMAIL);
      await page.locator('input[name="password"]').fill(PASSWORD);
      await page.locator('button[type="submit"]').click();
      await sleep(6000);
      text = await bodyText(page);
      if (/new login location|check your email/i.test(text))
        throw new Error('Discord asks for new-login-location email verification; approve it once in the mailbox, then re-run.');
      if (/captcha|hcaptcha/i.test(text) && await page.locator('input[name="email"]').count())
        throw new Error('Discord login is blocked by a captcha in the CI browser');
      continue;
    }
    const authorize = page.locator('button:has-text("Authorize"), button:has-text("授权")').first();
    if (await authorize.count()) { await authorize.click(); await sleep(5000); continue; }
    await sleep(3000);
  }
  await page.goto(PANEL, { waitUntil: 'domcontentloaded' });
  await sleep(3000);
  text = await bodyText(page);
  if (LOGGED_OUT.test(text)) throw new Error('login did not complete — panel still shows the logged-out page');
  console.log('logged in');
}

async function passTurnstile(page) {
  // Click the Turnstile checkbox once, then wait for the token like a human would.
  const frame = page.frames().find(f => f.url().includes('challenges.cloudflare.com'));
  if (frame) {
    const box = frame.locator('input[type="checkbox"], body');
    try { await box.first().click({ position: { x: 30, y: 30 }, timeout: 5000 }); } catch {}
  } else {
    const el = page.locator('text=/verify you are human|请验证您是真人/i').first();
    if (await el.count()) { try { await el.click({ timeout: 5000 }); } catch {} }
  }
  for (let i = 0; i < 30; i++) {
    await sleep(3000);
    const token = await page.evaluate(() => {
      const t = document.querySelector('textarea[name="cf-turnstile-response"], input[name="cf-turnstile-response"]');
      return t ? t.value : '';
    }).catch(() => '');
    if (token) { console.log('turnstile passed'); return true; }
    const enabled = await page.locator('button:has-text("Renew for 7 days"):not([disabled])').count();
    if (enabled) { console.log('renew button enabled'); return true; }
  }
  return false;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await loginIfNeeded(page);
    await page.goto(BOT_URL, { waitUntil: 'domcontentloaded' });
    await sleep(3000);
    let text = await bodyText(page);
    console.log('status:', text.slice(0, 300));
    if (LOGGED_OUT.test(text) || !/goes offline|days? left|renew|offline|online/i.test(text))
      throw new Error('bot page did not load — unexpected page content: ' + text.slice(0, 200));

    const offline = /offline/i.test(text);
    const renewBtn = page.locator('button:has-text("Renew for 7 days")').first();
    const renewVisible = (await renewBtn.count()) > 0;

    if (!offline && !renewVisible) {
      console.log('bot is online and renew is not open yet — nothing to do');
      return;
    }
    if (!renewVisible) {
      console.log('renew button not found — nothing to click');
      await shot(page, 'no-renew-button');
      return;
    }

    if (!(await passTurnstile(page))) {
      await shot(page, 'turnstile-failed');
      throw new Error('Turnstile check did not pass in CI browser');
    }
    await renewBtn.click();
    await sleep(6000);
    text = await bodyText(page);
    const m = text.match(/goes offline[^.]*|expires[^.]*/i);
    console.log('after renew:', m ? m[0] : text.slice(0, 200));

    const startBtn = page.locator('button:has-text("Start"):not([disabled])').first();
    if (await startBtn.count()) {
      await startBtn.click();
      console.log('start clicked');
      for (let i = 0; i < 20; i++) {
        await sleep(3000);
        text = await bodyText(page);
        if (/\bonline\b/i.test(text)) { console.log('bot is online'); break; }
      }
    }
    await shot(page, 'done');
    console.log('renew flow finished');
  } catch (e) {
    await shot(page, 'error');
    console.error('FAILED:', e.message);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
