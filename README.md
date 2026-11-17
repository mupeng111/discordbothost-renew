# discordbothost-renew

Two parts in one repo:

1. **Auto-renew workflow** (`.github/workflows/renew.yml` + `scripts/renew.js`) —
   a GitHub Actions job that repeats, in a headless browser, exactly what you
   would do by hand on the DiscordBotHost panel: log in through Discord OAuth
   (account + password), open the bot page, and once the bot is offline click
   **Renew for 7 days** and **Start** it again.
2. **Bot app** (`index.js`) — a multi-protocol app for the bot itself. It runs
   sing-box with vless / vmess / trojan over WebSocket (path-routed on the one
   panel port) plus anytls / hysteria2 / tuic on their own ports, builds all
   share links into the **NODE_LINK** variable, and serves NODE_LINK as a
   subscription.

## Renew workflow

The panel only shows the renew button after the bot goes offline
("Renew opens when it goes offline"), so the workflow runs every 12 hours:

- bot online, run not ending → exits quietly, clicks nothing;
- bot offline → passes the Turnstile check, clicks **Renew for 7 days**,
  confirms the new expiry, then clicks **Start** and waits for Online.

It can also be started manually from the Actions tab.

### Required secrets

Repo **Settings → Secrets and variables → Actions**:

| Name | Value |
| --- | --- |
| `DISCORD_EMAIL` | Discord account email |
| `DISCORD_PASSWORD` | Discord account password |
| `BOT_ID` (variable, optional) | Bot id on the panel, default `8edd6402` |

Known limits: if Discord asks for a new-login-location email approval or a
captcha on the CI login, the run fails and says so in the log — approve it
once in the mailbox and re-run. Screenshots of every run are kept as the
`renew-screenshots` artifact.

## Bot app

Deploy `index.js` + `package.json` to the bot (Node.js). On start it
downloads sing-box, generates a self-signed cert, writes its config and
starts the core; if the core exits it is restarted automatically.

| Env | Meaning |
| --- | --- |
| `UUID` | User id / password base. Default: generated once and persisted |
| `SERVER_PORT` / `PORT` | Panel port — the public entry for the WS protocols |
| `NODE_HOST` | Public host/IP written into the links (default: `SERVER_IP`) |
| `LINK_TLS` | `1` when the public entry is behind TLS |
| `HY2_PORT` / `TUIC_PORT` / `ANYTLS_PORT` | Extra public ports if the panel assigns any (default: entry port +1/+2/+3) |
| `NODE_NAME` | Name prefix used in link remarks |

Endpoints on the panel port:

- `/` — plain status page
- `/<UUID>` — base64 subscription of **NODE_LINK** (all protocols)
- `/link` — the raw links, one per line
