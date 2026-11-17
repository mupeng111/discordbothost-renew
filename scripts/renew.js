// DiscordBotHost auto-renew — same steps as doing it in the browser:
//   1. Open the bot page; if it shows the logged-out landing page instead,
//      go through Discord OAuth (account + password) first.
//   2. Read the bot status / expiry from the bot page.
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
const BOT_MARK = /goes offline|days? left of this/i;

async function shot(page, name) {
  try {
    fs.mkdirSync('artifacts', { recursive: true });
    await page.screenshot({ path: `artifacts/${name}.png`, fullPage: true });
  } catch {}
}

async function bodyText(page) {
  return (await page.locator('body').innerText()).replace(/\s+/g, ' ');
}

async function openBotPage(page) {
  await page.goto(BOT_URL, { waitUntil: 'domcontentloaded' });
  await sleep(3000);
  return bodyText(page);
}

// Returns the bot page text once we are really logged in.
async function ensureLogin(page) {
  let text = await openBotPage(page);
  if (!LOGGED_OUT.test(text) && BOT_MARK.test(text)) {
    console.log('already logged in');
    return text;
  }
  console.log('logged out - starting Discord OAuth login');
  await shot(page, 'login-0-botpage-logged-out');
  const loginLink = page.getByRole('link', { name: 'Log in', exact: true }).first();
  if (await loginLink.count()) { await loginLink.click(); await sleep(4000); }
  else {
    const alt = page.locator('a:has-text("Log in")').first();
    if (await alt.count()) { await alt.click(); await sleep(4000); }
  }

  for (let i = 0; i < 15; i++) {
    const url = page.url();
    const t = await bodyText(page).catch(() => '');
    console.log(`login step ${i}: url=${url} text="${t.slice(0, 120)}"`);
    if (url.includes('discordbothost.com') && url.includes('/bots/')) break;
    if (url.includes('discord.com')) {
      const emailInput = page.locator('input[name="email"]');
      if (await emailInput.count()) {
        if (!EMAIL || !PASSWORD) throw new Error('DISCORD_EMAIL / DISCORD_PASSWORD secrets are not set');
        await emailInput.fill(EMAIL);
        await page.locator('input[name="password"]').fill(PASSWORD);
        await shot(page, `login-${i}-discord-form`);
        await page.locator('button[type="submit"]').click();
        await sleep(6000);
        const after = await bodyText(page);
        if (/new login location|check your email/i.test(after))
          throw new Error('Discord asks for new-login-location email verification; approve it once in the mailbox, then re-run.');
        if (await page.locator('iframe[src*="hcaptcha"], div[class*="hcaptcha"]').count()) {
          await shot(page, `login-${i}-hcaptcha`);
          throw new Error('Discord login is blocked by an hCaptcha in the CI browser');
        }
        continue;
      }
      const authorize = page.locator('button:has-text("Authorize")').first();
      if (await authorize.count()) { await authorize.click(); await sleep(5000); continue; }
      await sleep(3000);
      continue;
    }
    // Still on the panel domain: its login page has a Discord button.
    const dBtn = page.locator('a[href*="discord.com/oauth2"], a[href*="discord.com/api"], button:has-text("Discord"), a:has-text("Discord")').first();
    if (await dBtn.count()) { await dBtn.click(); await sleep(4000); continue; }
    await sleep(3000);
  }
  await shot(page, 'login-final');

  text = await openBotPage(page);
  if (LOGGED_OUT.test(text) || !BOT_MARK.test(text))
    throw new Error('login did not complete - bot page still not accessible: ' + text.slice(0, 200));
  console.log('logged in');
  return text;
}

async function passTurnstile(page) {
  // Click the Turnstile checkbox once, then wait for the token like a human would.
  const frame = page.frames().find(f => f.url().includes('challenges.cloudflare.com'));
  if (frame) {
    const box = frame.locator('input[type="checkbox"], body');
    try { await box.first().click({ position: { x: 30, y: 30 }, timeout: 5000 }); } catch {}
  } else {
    const el = page.locator('text=/verify you are human/i').first();
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
    let text = await ensureLogin(page);
    console.log('status:', text.slice(0, 300));

    const offline = /offline/i.test(text);
    const renewBtn = page.locator('button:has-text("Renew for 7 days")').first();
    const renewVisible = (await renewBtn.count()) > 0;

    if (!offline && !renewVisible) {
      console.log('bot is online and renew is not open yet - nothing to do');
      return;
    }
    if (!renewVisible) {
      console.log('renew button not found - nothing to click');
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
