// DiscordBotHost auto-renew — same steps as doing it in the browser:
//   0. If NODE_LINK is set, start a local sing-box whose outbounds are the
//      protocol nodes from NODE_LINK (urltest picks the fastest alive one)
//      and run the whole browser through it - that is the network environment.
//   1. Open the bot page; if it shows the logged-out landing page instead,
//      log in with the panel's own account + password form (/auth/login).
//   2. Read the bot status / expiry from the bot page.
//   3. If it is online and the run is not about to end: nothing to do, exit 0.
//   4. If it is offline (renew only opens then): pass the Turnstile check,
//      click "Renew for 7 days", confirm the new expiry.
//   5. If the bot is stopped after renewing: click Start, wait until Online.
// Secrets (GitHub repo Settings -> Secrets and variables -> Actions):
//   DISCORD_EMAIL     panel account email
//   DISCORD_PASSWORD  panel account password
//   NODE_LINK         protocol node links used as the network environment
//   BOT_ID            bot id on the panel (default: 8edd6402)
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFile, spawn } = require('child_process');

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

async function turnstileToken(page) {
  return page.evaluate(() => {
    const t = document.querySelector('textarea[name="cf-turnstile-response"], input[name="cf-turnstile-response"]');
    return t ? t.value : '';
  }).catch(() => '');
}

async function clickTurnstile(page) {
  const frame = page.frames().find(f => f.url().includes('challenges.cloudflare.com'));
  if (frame) {
    try { await frame.locator('input[type="checkbox"], body').first()
      .click({ position: { x: 30, y: 30 }, timeout: 5000 }); } catch {}
  }
}

// ---------- NODE_LINK network environment (sing-box client) ----------
function download(url, dest, redirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'discordbothost-renew' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(download(res.headers.location, dest, redirects - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('download HTTP ' + res.statusCode)); }
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on('finish', () => out.close(resolve));
      out.on('error', reject);
    }).on('error', reject);
  });
}

async function ensureSingbox() {
  const dir = path.join(__dirname, 'bin');
  const bin = path.join(dir, process.platform === 'win32' ? 'sing-box.exe' : 'sing-box');
  if (fs.existsSync(bin)) return bin;
  fs.mkdirSync(dir, { recursive: true });
  const ver = '1.12.12';
  const os = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux';
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  const name = `sing-box-${ver}-${os}-${arch}`;
  const tmp = path.join(dir, name + '.tar.gz');
  await download(`https://github.com/SagerNet/sing-box/releases/download/v${ver}/${name}.tar.gz`, tmp);
  await new Promise((res, rej) => execFile('tar', ['-xzf', tmp, '-C', dir], e => e ? rej(e) : res()));
  fs.copyFileSync(path.join(dir, name, process.platform === 'win32' ? 'sing-box.exe' : 'sing-box'), bin);
  try { fs.chmodSync(bin, 0o755); } catch {}
  return bin;
}

function tlsFromQuery(q, forceOn) {
  const sec = (q.get('security') || '').toLowerCase();
  if (!forceOn && sec !== 'tls' && sec !== 'reality') return undefined;
  const tls = { enabled: true,
    server_name: q.get('sni') || undefined,
    insecure: q.get('insecure') === '1' || q.get('allowInsecure') === '1' || q.get('allow_insecure') === '1' };
  if (sec === 'reality') tls.reality = { enabled: true, public_key: q.get('pbk') || '', short_id: q.get('sid') || '' };
  if (q.get('fp')) tls.utls = { enabled: true, fingerprint: q.get('fp') };
  return tls;
}

function transportFromQuery(q) {
  const type = (q.get('type') || '').toLowerCase();
  if (type === 'ws') {
    const t = { type: 'ws', path: q.get('path') || '/' };
    if (q.get('host')) t.headers = { Host: q.get('host') };
    return t;
  }
  if (type === 'grpc') return { type: 'grpc', service_name: q.get('serviceName') || q.get('service_name') || '' };
  return undefined;
}

function parseLink(link, i) {
  const tag = 'n' + i;
  try {
    if (link.startsWith('vmess://')) {
      const j = JSON.parse(Buffer.from(link.slice(8).trim(), 'base64').toString());
      const ob = { type: 'vmess', tag, server: j.add, server_port: +j.port, uuid: j.id,
        alter_id: +(j.aid || 0), security: j.scy || 'auto' };
      if (j.tls) ob.tls = { enabled: true, server_name: j.sni || j.host || undefined };
      if (j.net === 'ws') { ob.transport = { type: 'ws', path: j.path || '/' }; if (j.host) ob.transport.headers = { Host: j.host }; }
      return ob;
    }
    const u = new URL(link);
    const q = u.searchParams;
    const user = decodeURIComponent(u.username || '');
    const pass = decodeURIComponent(u.password || '');
    if (link.startsWith('vless://')) {
      const ob = { type: 'vless', tag, server: u.hostname, server_port: +u.port, uuid: user };
      if (q.get('flow')) ob.flow = q.get('flow');
      const tls = tlsFromQuery(q, false); if (tls) ob.tls = tls;
      const tr = transportFromQuery(q); if (tr) ob.transport = tr;
      return ob;
    }
    if (link.startsWith('trojan://')) {
      const ob = { type: 'trojan', tag, server: u.hostname, server_port: +u.port, password: user };
      ob.tls = tlsFromQuery(q, true);
      const tr = transportFromQuery(q); if (tr) ob.transport = tr;
      return ob;
    }
    if (link.startsWith('hysteria2://') || link.startsWith('hy2://')) {
      const ob = { type: 'hysteria2', tag, server: u.hostname, server_port: +u.port, password: user,
        tls: { enabled: true, server_name: q.get('sni') || undefined, insecure: q.get('insecure') === '1' } };
      if (q.get('obfs') === 'salamander') ob.obfs = { type: 'salamander', password: q.get('obfs-password') || '' };
      return ob;
    }
    if (link.startsWith('tuic://')) {
      return { type: 'tuic', tag, server: u.hostname, server_port: +u.port, uuid: user, password: pass,
        congestion_control: q.get('congestion_control') || 'cubic',
        tls: { enabled: true, server_name: q.get('sni') || undefined,
          insecure: q.get('allow_insecure') === '1' || q.get('insecure') === '1', alpn: ['h3'] } };
    }
    if (link.startsWith('anytls://')) {
      return { type: 'anytls', tag, server: u.hostname, server_port: +u.port, password: user,
        tls: { enabled: true, server_name: q.get('sni') || undefined, insecure: q.get('insecure') === '1' } };
    }
  } catch (e) { console.log('NODE_LINK: skipped one unparsable link'); }
  return null;
}

async function startProxy() {
  let links = (process.env.NODE_LINK || '').split(/\r?\n/).map(s => s.trim()).filter(s => s.includes('://'));
  if (!links.length && process.env.NODE_LINK) {
    try { links = Buffer.from(process.env.NODE_LINK.trim(), 'base64').toString()
      .split(/\r?\n/).map(s => s.trim()).filter(s => s.includes('://')); } catch {}
  }
  const outbounds = [];
  links.forEach((l, i) => { const ob = parseLink(l, i); if (ob) outbounds.push(ob); });
  if (!outbounds.length) { console.log('NODE_LINK: no usable links - running without proxy'); return null; }
  console.log(`NODE_LINK: ${outbounds.length} node(s) parsed: ${outbounds.map(o => o.type).join(', ')}`);
  const bin = await ensureSingbox();
  const cfg = { log: { level: 'warn' },
    inbounds: [{ type: 'mixed', tag: 'in', listen: '127.0.0.1', listen_port: 10808 }],
    outbounds: [{ type: 'urltest', tag: 'auto', outbounds: outbounds.map(o => o.tag),
        url: 'https://www.gstatic.com/generate_204', interval: '30s' },
      ...outbounds, { type: 'direct', tag: 'direct' }],
    route: { final: 'auto' } };
  const cfgPath = path.join(__dirname, 'proxy-config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  const proc = spawn(bin, ['run', '-c', cfgPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stderr.on('data', d => process.stderr.write('[proxy] ' + d));
  await sleep(5000);
  if (proc.exitCode !== null) throw new Error('sing-box exited early with code ' + proc.exitCode);
  console.log('proxy up on 127.0.0.1:10808');
  return proc;
}

// Panel account + password login (the /auth/login form), not Discord OAuth.
// Secrets DISCORD_EMAIL / DISCORD_PASSWORD hold the panel account credentials.
async function ensureLogin(page) {
  let text = await openBotPage(page);
  if (!LOGGED_OUT.test(text) && BOT_MARK.test(text)) {
    console.log('already logged in');
    return text;
  }
  if (!EMAIL || !PASSWORD) throw new Error('DISCORD_EMAIL / DISCORD_PASSWORD secrets are not set');
  console.log('logged out - panel account login');
  await page.goto(`${PANEL}/auth/login?next=%2Fbots%2F${BOT_ID}`, { waitUntil: 'domcontentloaded' });
  await sleep(3000);
  const emailInput = page.locator('input[type="email"], input[name="email"]').first();
  const passInput = page.locator('input[type="password"], input[name="password"]').first();
  if (!(await emailInput.count()) || !(await passInput.count()))
    throw new Error('panel login form not found at /auth/login');
  await emailInput.fill(EMAIL);
  await passInput.fill(PASSWORD);
  await shot(page, 'login-form-filled');
  // The login form has its own Turnstile check - click it and wait for a token.
  for (let i = 0; i < 20 && !(await turnstileToken(page)); i++) {
    if (i === 0) await clickTurnstile(page);
    await sleep(3000);
  }
  if (!(await turnstileToken(page))) {
    await shot(page, 'login-turnstile-failed');
    throw new Error('Turnstile check on the panel login form did not pass in CI browser');
  }
  console.log('login turnstile passed');
  await page.locator('button:has-text("Log in"), button[type="submit"]').first().click();
  await sleep(6000);
  text = await openBotPage(page);
  if (LOGGED_OUT.test(text) || !BOT_MARK.test(text))
    throw new Error('panel login did not complete - bot page still not accessible: ' + text.slice(0, 200));
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
  let proxyProc = null;
  try { proxyProc = await startProxy(); }
  catch (e) { console.log('proxy start failed, continuing without proxy:', e.message); }
  const launchOpts = { headless: true };
  if (proxyProc) launchOpts.proxy = { server: 'http://127.0.0.1:10808' };
  const browser = await chromium.launch(launchOpts);
  const page = await browser.newPage();
  try {
    if (proxyProc) {
      try {
        await page.goto('https://api.ipify.org', { timeout: 20000 });
        console.log('egress ip:', (await page.locator('body').innerText()).trim());
      } catch (e) { console.log('egress ip check failed:', e.message); }
    }
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
    if (proxyProc) proxyProc.kill();
  }
})();
