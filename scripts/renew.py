#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# DiscordBotHost auto-renew (SeleniumBase UC + OS-level Turnstile clicks).
# Logic (same as doing it in the browser):
#   0. If NODE_LINK is set, build a local sing-box whose outbounds are the
#      protocol nodes from NODE_LINK (urltest picks the fastest alive one)
#      and route the browser through it - that is the network environment.
#      If the proxy attempt fails, retry direct as a control/fallback.
#   1. Open the bot page; if logged out, log in with the panel's own
#      account + password form (/auth/login), solving its Turnstile.
#   2. Read the bot status / expiry from the bot page (positive evidence).
#   3. Online + renew not open: nothing to do.
#   4. Offline: solve Turnstile, click "Renew for 7 days", verify new expiry.
#   5. If stopped after renewing: click Start, wait until Online.
# Secrets: DISCORD_EMAIL / DISCORD_PASSWORD (panel account), NODE_LINK,
#          BOT_ID (default 8edd6402)
# Optional: TG_BOT_TOKEN / TG_CHAT_ID for Telegram result notifications
#          (same notification logic as the reference project; no-op unset).
import os, re, sys, time, json, random, subprocess, tarfile, urllib.request

from seleniumbase import SB

EMAIL = os.environ.get("DISCORD_EMAIL") or ""
PASSWORD = os.environ.get("DISCORD_PASSWORD") or ""
TG_BOT_TOKEN = os.environ.get("TG_BOT_TOKEN") or ""
TG_CHAT_ID = os.environ.get("TG_CHAT_ID") or ""
BOT_ID = os.environ.get("BOT_ID") or "8edd6402"
PANEL = "https://my.discordbothost.com"
BOT_URL = f"{PANEL}/bots/{BOT_ID}"
PROXY_PORT = 10808
PROXY_SERVER = f"http://127.0.0.1:{PROXY_PORT}"

LOGGED_OUT = re.compile(r"log in to see your bots", re.I)
BOT_MARK = re.compile(r"goes offline|days? left of this", re.I)


def log(*a):
    print(*a, flush=True)


# ---------- Telegram notification (reference project's logic) ----------
def _masked_email():
    if "@" in EMAIL:
        name, domain = EMAIL.split("@", 1)
        if len(name) > 4:
            return f"{name[:2]}****{name[-2:]}@{domain}"
        return f"{name}@{domain}"
    return (EMAIL[:2] + "****") if EMAIL else ""


def notify(status, extra="", expiry=""):
    now = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(time.time() + 8 * 3600))
    lines = ["💗主人，DiscordBotHost 续期通知", "", status,
             f"👤 登录账户: {_masked_email()}"]
    if expiry:
        lines.append(f"📅 到期时间: {expiry}")
    if extra:
        lines.append(extra)
    lines.append(f"⏱️ 登录时间: {now}")
    log("notify:", status, "| expiry:", expiry or "(none)")
    if not TG_BOT_TOKEN or not TG_CHAT_ID:
        log("telegram not configured - notification skipped")
        return
    try:
        data = json.dumps({"chat_id": TG_CHAT_ID, "text": "\n".join(lines)}).encode()
        req = urllib.request.Request(
            f"https://api.telegram.org/bot{TG_BOT_TOKEN}/sendMessage",
            data=data, headers={"Content-Type": "application/json"})
        urllib.request.urlopen(req, timeout=10)
        log("telegram notification sent")
    except Exception as e:
        log(f"telegram notification failed: {e}")


# ---------- NODE_LINK network environment (sing-box client) ----------
def _dl(url, dest):
    req = urllib.request.Request(url, headers={"User-Agent": "discordbothost-renew"})
    with urllib.request.urlopen(req, timeout=120) as r, open(dest, "wb") as f:
        f.write(r.read())


def ensure_singbox():
    d = os.path.join(os.path.dirname(os.path.abspath(__file__)), "bin")
    binp = os.path.join(d, "sing-box")
    if os.path.exists(binp):
        return binp
    os.makedirs(d, exist_ok=True)
    ver = "1.12.12"
    arch = "arm64" if os.uname().machine in ("aarch64", "arm64") else "amd64"
    name = f"sing-box-{ver}-linux-{arch}"
    tgz = os.path.join(d, name + ".tar.gz")
    _dl(f"https://github.com/SagerNet/sing-box/releases/download/v{ver}/{name}.tar.gz", tgz)
    with tarfile.open(tgz) as t:
        t.extractall(d)
    src = os.path.join(d, name, "sing-box")
    os.replace(src, binp)
    os.chmod(binp, 0o755)
    return binp


def _q(query, key, default=""):
    return query.get(key, [default])[0]


def _tls(q, force_on):
    sec = _q(q, "security").lower()
    if not force_on and sec not in ("tls", "reality"):
        return None
    tls = {"enabled": True, "server_name": _q(q, "sni") or None,
           "insecure": _q(q, "insecure") == "1" or _q(q, "allowInsecure") == "1"
                       or _q(q, "allow_insecure") == "1"}
    if sec == "reality":
        tls["reality"] = {"enabled": True, "public_key": _q(q, "pbk"), "short_id": _q(q, "sid")}
    if _q(q, "fp"):
        tls["utls"] = {"enabled": True, "fingerprint": _q(q, "fp")}
    return {k: v for k, v in tls.items() if v is not None}


def _transport(q):
    t = _q(q, "type").lower()
    if t == "ws":
        tr = {"type": "ws", "path": _q(q, "path") or "/"}
        if _q(q, "host"):
            tr["headers"] = {"Host": _q(q, "host")}
        return tr
    if t == "grpc":
        return {"type": "grpc", "service_name": _q(q, "serviceName") or _q(q, "service_name")}
    return None


def parse_link(link, i):
    from urllib.parse import urlparse, parse_qs, unquote
    import base64
    tag = f"n{i}"
    try:
        if link.startswith("vmess://"):
            j = json.loads(base64.b64decode(link[8:]).decode())
            ob = {"type": "vmess", "tag": tag, "server": j["add"],
                  "server_port": int(j["port"]), "uuid": j["id"],
                  "alter_id": int(j.get("aid") or 0), "security": j.get("scy") or "auto"}
            if j.get("tls"):
                ob["tls"] = {"enabled": True, "server_name": j.get("sni") or j.get("host") or None}
            if j.get("net") == "ws":
                ob["transport"] = {"type": "ws", "path": j.get("path") or "/"}
                if j.get("host"):
                    ob["transport"]["headers"] = {"Host": j["host"]}
            return ob
        u = urlparse(link)
        q = parse_qs(u.query)
        user = unquote(u.username or "")
        pw = unquote(u.password or "")
        if link.startswith("vless://"):
            ob = {"type": "vless", "tag": tag, "server": u.hostname,
                  "server_port": u.port, "uuid": user}
            if _q(q, "flow"):
                ob["flow"] = _q(q, "flow")
            tls = _tls(q, False)
            if tls:
                ob["tls"] = tls
            tr = _transport(q)
            if tr:
                ob["transport"] = tr
            return ob
        if link.startswith("trojan://"):
            ob = {"type": "trojan", "tag": tag, "server": u.hostname,
                  "server_port": u.port, "password": user}
            ob["tls"] = _tls(q, True)
            tr = _transport(q)
            if tr:
                ob["transport"] = tr
            return ob
        if link.startswith(("hysteria2://", "hy2://")):
            ob = {"type": "hysteria2", "tag": tag, "server": u.hostname,
                  "server_port": u.port, "password": user,
                  "tls": {"enabled": True, "server_name": _q(q, "sni") or None,
                          "insecure": _q(q, "insecure") == "1"}}
            if _q(q, "obfs") == "salamander":
                ob["obfs"] = {"type": "salamander", "password": _q(q, "obfs-password")}
            return ob
        if link.startswith("tuic://"):
            return {"type": "tuic", "tag": tag, "server": u.hostname,
                    "server_port": u.port, "uuid": user, "password": pw,
                    "congestion_control": _q(q, "congestion_control") or "cubic",
                    "tls": {"enabled": True, "server_name": _q(q, "sni") or None,
                            "insecure": _q(q, "allow_insecure") == "1" or _q(q, "insecure") == "1",
                            "alpn": ["h3"]}}
        if link.startswith("anytls://"):
            return {"type": "anytls", "tag": tag, "server": u.hostname,
                    "server_port": u.port, "password": user,
                    "tls": {"enabled": True, "server_name": _q(q, "sni") or None,
                            "insecure": _q(q, "insecure") == "1"}}
        if link.startswith("socks5://"):
            ob = {"type": "socks", "tag": tag, "server": u.hostname,
                  "server_port": u.port, "version": "5"}
            if user:
                ob["username"] = user
                ob["password"] = pw
            return ob
    except Exception:
        log("NODE_LINK: skipped one unparsable link")
    return None


def start_proxy():
    import base64
    raw = os.environ.get("NODE_LINK") or ""
    links = [s.strip() for s in raw.splitlines() if "://" in s]
    if not links and raw.strip():
        try:
            links = [s.strip() for s in base64.b64decode(raw.strip()).decode().splitlines()
                     if "://" in s]
        except Exception:
            links = []
    outbounds = []
    for i, l in enumerate(links):
        ob = parse_link(l, i)
        if ob:
            outbounds.append(ob)
    if not outbounds:
        log("NODE_LINK: no usable links - running without proxy")
        return None
    log(f"NODE_LINK: {len(outbounds)} node(s) parsed: {', '.join(o['type'] for o in outbounds)}")
    binp = ensure_singbox()
    cfg = {"log": {"level": "warn"},
           "inbounds": [{"type": "mixed", "tag": "in", "listen": "127.0.0.1",
                         "listen_port": PROXY_PORT}],
           "outbounds": [{"type": "urltest", "tag": "auto",
                          "outbounds": [o["tag"] for o in outbounds],
                          "url": "https://www.gstatic.com/generate_204",
                          "interval": "30s"},
                         *outbounds, {"type": "direct", "tag": "direct"}],
           "route": {"final": "auto"}}
    cfg_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "proxy-config.json")
    with open(cfg_path, "w") as f:
        json.dump(cfg, f)
    proc = subprocess.Popen([binp, "run", "-c", cfg_path],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(5)
    if proc.poll() is not None:
        raise RuntimeError(f"sing-box exited early with code {proc.returncode}")
    log(f"proxy up on 127.0.0.1:{PROXY_PORT}")
    return proc


# ---------- Turnstile (OS-level click technique) ----------
def js(sb, script, default=None):
    try:
        r = sb.execute_script(script)
        return default if r is None else r
    except Exception:
        try:
            r = sb.cdp.evaluate("(function(){ " + script + " })()")
            return default if r is None else r
        except Exception:
            return default


TOKEN_JS = """
try { if (window.turnstile && window.turnstile.getResponse) {
        var t = window.turnstile.getResponse(); if (t) return t; } } catch (e) {}
var el = document.querySelector('input[name="cf-turnstile-response"]');
return el ? (el.value || '') : '';
"""

EXISTS_JS = """
return document.querySelector(
  'input[name="cf-turnstile-response"], iframe[src*="challenges.cloudflare.com"], .cf-turnstile'
) !== null;
"""

COORDS_JS = """
function findWidget(root) {
    var els = root.querySelectorAll(
        'iframe[src*="challenges.cloudflare.com"], .cf-turnstile, [id*="cf-chl"]');
    for (var i = 0; i < els.length; i++) {
        var r = els[i].getBoundingClientRect();
        if (r.width > 50 && r.height > 20) return els[i];
    }
    var all = root.querySelectorAll('*');
    for (var j = 0; j < all.length; j++) {
        if (all[j].shadowRoot) {
            var f = findWidget(all[j].shadowRoot);
            if (f) return f;
        }
    }
    return null;
}
function boxFromTokenInput() {
    var el = document.querySelector('input[name="cf-turnstile-response"]');
    var cur = el ? el.parentElement : null;
    for (var k = 0; k < 6 && cur; k++) {
        var r = cur.getBoundingClientRect();
        if (r.width > 100 && r.width < 600 && r.height > 30 && r.height < 140) return cur;
        cur = cur.parentElement;
    }
    return null;
}
var hit = findWidget(document) || boxFromTokenInput();
if (!hit) return null;
var hr = hit.getBoundingClientRect();
return {cx: Math.round(hr.x + 30), cy: Math.round(hr.y + hr.height / 2)};
"""


def turnstile_token(sb):
    t = js(sb, TOKEN_JS, "")
    return t if isinstance(t, str) else ""


def wait_turnstile_present(sb, timeout=15):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if js(sb, EXISTS_JS, False):
            return True
        time.sleep(1)
    return False


def _activate_window():
    for cls in ["chrome", "chromium", "Chromium", "Chrome", "google-chrome"]:
        try:
            r = subprocess.run(["xdotool", "search", "--onlyvisible", "--class", cls],
                               capture_output=True, text=True, timeout=3)
            wids = [w for w in r.stdout.strip().split("\n") if w.strip()]
            if wids:
                subprocess.run(["xdotool", "windowactivate", "--sync", wids[0]],
                               timeout=3, stderr=subprocess.DEVNULL)
                time.sleep(0.2)
                return
        except Exception:
            pass


def _xdotool_click(x, y):
    _activate_window()
    try:
        subprocess.run(["xdotool", "mousemove", "--sync", str(x), str(y)],
                       timeout=3, stderr=subprocess.DEVNULL)
        time.sleep(0.15)
        subprocess.run(["xdotool", "click", "1"], timeout=2, stderr=subprocess.DEVNULL)
    except Exception:
        os.system(f"xdotool mousemove {x} {y} click 1 2>/dev/null")


def _os_click_turnstile(sb):
    coords = None
    deadline = time.time() + 10
    while time.time() < deadline:
        coords = js(sb, COORDS_JS, None)
        if coords:
            break
        time.sleep(1)
    if not coords:
        log("turnstile coords not found")
        return False
    wi = js(sb, "return '' + (window.screenX || 0) + '|' + (window.screenY || 0) + '|' +"
                " window.outerHeight + '|' + window.innerHeight;", "")
    parts = str(wi).split("|")
    try:
        sx, sy = int(parts[0] or 0), int(parts[1] or 0)
        bar = int(parts[2] or 800) - int(parts[3] or 768)
    except Exception:
        sx, sy, bar = 0, 0, 0
    ax, ay = int(coords["cx"]) + sx, int(coords["cy"]) + sy + bar
    log(f"OS click turnstile at ({ax}, {ay})")
    _xdotool_click(ax, ay)
    time.sleep(3)
    return True


def click_turnstile(sb):
    if _os_click_turnstile(sb):
        return True
    coords = js(sb, COORDS_JS, None)
    if coords:
        try:
            sb.cdp.gui_click_x_y(int(coords["cx"]), int(coords["cy"]))
            log("cdp gui click done")
            return True
        except Exception as e:
            log(f"cdp gui click failed: {e}")
    try:
        sb.cdp.click_captcha()
        log("cdp click_captcha done")
        return True
    except Exception as e:
        log(f"click_captcha failed: {e}")
    return False


def solve_turnstile(sb, timeout=90, tag="turnstile", first_wait=8):
    if turnstile_token(sb):
        return True
    deadline = time.time() + timeout
    next_click = time.time() + first_wait
    clicks = 0
    while time.time() < deadline:
        if turnstile_token(sb):
            log(f"{tag} passed (token acquired)")
            return True
        if time.time() >= next_click:
            clicks += 1
            log(f"click {tag} attempt {clicks}")
            click_turnstile(sb)
            next_click = time.time() + 10 + random.uniform(0, 3)
        time.sleep(2)
    # The token often lands a few seconds after the last click - grace poll.
    grace_end = time.time() + 6
    while time.time() < grace_end:
        if turnstile_token(sb):
            log(f"{tag} passed (token acquired)")
            return True
        time.sleep(1.5)
    log(f"{tag} FAILED")
    return False


# ---------- Panel flow ----------
def shot(sb, name):
    try:
        os.makedirs("artifacts", exist_ok=True)
        sb.save_screenshot(f"artifacts/{name}.png")
    except Exception:
        pass


def page_text(sb):
    t = js(sb, "return document.body ? (document.body.innerText || '') : '';", "")
    if isinstance(t, str) and t.strip():
        return re.sub(r"\s+", " ", t)
    try:
        return re.sub(r"\s+", " ", sb.get_page_text())
    except Exception:
        return ""


def open_bot_page(sb):
    sb.open(BOT_URL)
    sb.wait_for_ready_state_complete()
    sb.sleep(3)
    return page_text(sb)


def ensure_login(sb):
    text = open_bot_page(sb)
    if not LOGGED_OUT.search(text) and BOT_MARK.search(text):
        log("already logged in")
        return text
    if not EMAIL or not PASSWORD:
        raise RuntimeError("DISCORD_EMAIL / DISCORD_PASSWORD secrets are not set")
    log("logged out - panel account login")
    sb.open(f"{PANEL}/auth/login?next=%2Fbots%2F{BOT_ID}")
    sb.wait_for_ready_state_complete()
    sb.sleep(3)
    sb.input('input[type="email"]', EMAIL)
    sb.sleep(1)
    sb.input('input[type="password"]', PASSWORD)
    sb.sleep(3)
    shot(sb, "login-form-filled")
    if wait_turnstile_present(sb):
        if not solve_turnstile(sb, timeout=120, tag="login turnstile"):
            try:
                sb.cdp.click_captcha()
                sb.sleep(4)
            except Exception:
                pass
        if not turnstile_token(sb):
            shot(sb, "login-turnstile-failed")
            raise RuntimeError("Turnstile check on the panel login form did not pass")
        log("login turnstile passed")
    else:
        log("no turnstile detected on login form")
    # Make sure the form still holds the credentials (widget interaction can
    # coincide with a re-render that clears the inputs).
    lens = js(sb, "var e=document.querySelector('input[type=\"email\"]'),"
                  "p=document.querySelector('input[type=\"password\"]');"
                  "return (e?e.value.length:0) + '|' + (p?p.value.length:0);", "")
    log("form field lengths:", lens)
    parts = str(lens).split("|")
    if len(parts) == 2 and (parts[0] == "0" or parts[1] == "0"):
        log("form was cleared - refilling")
        sb.input('input[type="email"]', EMAIL)
        sb.input('input[type="password"]', PASSWORD)
        sb.sleep(1)
    try:
        sb.click('button:contains("Log in")')
    except Exception:
        sb.click('button[type="submit"]')
    log("login submitted")
    sb.sleep(6)
    sb.wait_for_ready_state_complete()
    shot(sb, "after-login")
    log("after login url:", sb.get_current_url())
    text = open_bot_page(sb)
    if LOGGED_OUT.search(text) or not BOT_MARK.search(text):
        raise RuntimeError("panel login did not complete - url=" +
                           sb.get_current_url() + " text: " + text[:200])
    log("logged in")
    return text


def _visible(sb, sel):
    try:
        return bool(sb.is_element_visible(sel))
    except Exception:
        return False


def _wait_online(sb):
    for _ in range(20):
        sb.sleep(3)
        text = page_text(sb)
        if re.search(r"goes offline", text, re.I):
            log("bot is online")
            return True
    return False


def expiry_snippet(text):
    m = re.search(r"goes offline on\s*(\d{4}/\d{1,2}/\d{1,2}\s+\d{1,2}:\d{2}(:\d{2})?)",
                  text, re.I)
    if m:
        return "goes offline on " + m.group(1)
    m = re.search(r"(\d+)\s*days? left", text, re.I)
    if m:
        return m.group(0)
    m = re.search(r"goes offline[^.]{0,140}", text, re.I)
    return m.group(0).strip() if m else ""


def run_flow(sb):
    text = ensure_login(sb)
    before = expiry_snippet(text)
    log("status:", before or text[:300])
    log("remaining:", before or "(unknown)")
    renew_sel = '//button[normalize-space()="Renew for 7 days"]'
    start_sel = '//button[normalize-space()="Start"]'
    renew_visible = _visible(sb, renew_sel)
    start_visible = _visible(sb, start_sel)
    if not renew_visible and not start_visible:
        log("bot is online and renew is not open yet - nothing to do")
        notify("⏳ 未到续期时间", expiry=before)
        return
    if not renew_visible and start_visible:
        # Stopped but not expired: just start it again.
        sb.click(start_sel)
        log("start clicked")
        _wait_online(sb)
        shot(sb, "done")
        notify("✅ 已重新启动", expiry=expiry_snippet(page_text(sb)) or before)
        log("renew flow finished")
        return
    # Renew is open: read the expiry BEFORE, renew, then read it again and
    # compare - the reference project's success test.
    if wait_turnstile_present(sb):
        if not solve_turnstile(sb, timeout=120, tag="renew turnstile"):
            shot(sb, "turnstile-failed")
            raise RuntimeError("Turnstile check did not pass")
        log("renew turnstile passed")
    sb.click(renew_sel)
    log("renew clicked")
    sb.sleep(6)
    text = open_bot_page(sb)
    after = expiry_snippet(text)
    log("after renew:", after or text[:200])
    log("remaining:", after or "(unknown)")
    if _visible(sb, start_sel):
        sb.click(start_sel)
        log("start clicked")
        _wait_online(sb)
    shot(sb, "done")
    if after and after != before:
        notify("✅ 续期成功", extra="到期时间已更新", expiry=after)
    else:
        notify("⚠️ 续期结果未知", extra="到期时间未变化，请手动检查",
               expiry=after or before)
    log("renew flow finished")


def attempt(use_proxy):
    kwargs = {"uc": True, "headless": False, "locale_code": "en-US"}
    if use_proxy:
        kwargs["proxy"] = PROXY_SERVER
    with SB(**kwargs) as sb:
        try:
            sb.open("https://api.ipify.org")
            sb.sleep(2)
            log("egress ip:", page_text(sb)[:60])
        except Exception as e:
            log(f"egress ip check failed: {e}")
        run_flow(sb)


def main():
    if not EMAIL or not PASSWORD:
        log("DISCORD_EMAIL / DISCORD_PASSWORD secrets are not set")
        sys.exit(1)
    proxy_proc = None
    try:
        proxy_proc = start_proxy()
    except Exception as e:
        log(f"proxy start failed, continuing without proxy: {e}")
    modes = [True, False] if proxy_proc else [False]
    last_err = None
    for use_proxy in modes:
        try:
            attempt(use_proxy)
            last_err = None
            break
        except Exception as e:
            last_err = e
            log(f"attempt (proxy={use_proxy}) FAILED: {type(e).__name__}: {e}")
    if proxy_proc:
        proxy_proc.kill()
    if last_err:
        notify("❌ 续期失败", extra=f"错误信息: {type(last_err).__name__}: {last_err}")
        sys.exit(1)


if __name__ == "__main__":
    main()
