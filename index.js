// Multi-protocol app for DiscordBotHost (Node.js)
// - Runs sing-box locally with vless / vmess / trojan (WS, path-routed on the
//   single panel port) plus anytls / hysteria2 / tuic on their own ports.
// - Builds NODE_LINK with all share links and serves it as a subscription.
// Environment:
//   UUID        - user id / password base (default: generated & persisted)
//   SERVER_PORT - panel assigned port (or PORT), the public entry port
//   NODE_HOST   - public host/IP used in links (default: SERVER_IP env)
//   LINK_TLS    - "1" if the public entry is behind TLS (ws links get security=tls)
//   HY2_PORT / TUIC_PORT / ANYTLS_PORT - extra public ports if the panel gives any
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

const PORT = parseInt(process.env.SERVER_PORT || process.env.PORT || '20153', 10);
const HOST = process.env.NODE_HOST || process.env.SERVER_IP || '127.0.0.1';
const LINK_TLS = process.env.LINK_TLS === '1';
const NAME = process.env.NODE_NAME || 'discordbothost';

const WS_ROUTES = { '/vless': 10001, '/vmess': 10002, '/trojan': 10003 };
const HY2_PORT = parseInt(process.env.HY2_PORT || String(PORT + 1), 10);
const TUIC_PORT = parseInt(process.env.TUIC_PORT || String(PORT + 2), 10);
const ANYTLS_PORT = parseInt(process.env.ANYTLS_PORT || String(PORT + 3), 10);

function getUUID() {
  if (process.env.UUID) return process.env.UUID;
  const f = path.join(__dirname, '.uuid');
  try { return fs.readFileSync(f, 'utf8').trim(); } catch {}
  const u = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
  try { fs.writeFileSync(f, u); } catch {}
  return u;
}
const UUID = getUUID();

function buildLinks() {
  const wsTls = LINK_TLS ? 'security=tls&' : 'security=none&';
  const sni = LINK_TLS ? `&sni=${HOST}` : '';
  const links = [];
  links.push(`vless://${UUID}@${HOST}:${PORT}?encryption=none&${wsTls}type=ws&host=${HOST}&path=%2Fvless${sni}#${NAME}-vless`);
  const vmess = {
    v: '2', ps: `${NAME}-vmess`, add: HOST, port: String(PORT), id: UUID,
    aid: '0', net: 'ws', type: 'none', host: HOST, path: '/vmess',
    tls: LINK_TLS ? 'tls' : '', sni: LINK_TLS ? HOST : '',
  };
  links.push('vmess://' + Buffer.from(JSON.stringify(vmess)).toString('base64'));
  links.push(`trojan://${UUID}@${HOST}:${PORT}?${wsTls}type=ws&host=${HOST}&path=%2Ftrojan${sni}#${NAME}-trojan`);
  links.push(`anytls://${UUID}@${HOST}:${ANYTLS_PORT}?insecure=1#${NAME}-anytls`);
  links.push(`hysteria2://${UUID}@${HOST}:${HY2_PORT}?insecure=1#${NAME}-hysteria2`);
  links.push(`tuic://${UUID}:${UUID}@${HOST}:${TUIC_PORT}?congestion_control=bbr&udp_relay_mode=native&allow_insecure=1#${NAME}-tuic`);
  return links;
}
const NODE_LINK = buildLinks().join('\n');
process.env.NODE_LINK = NODE_LINK;

function ensureCert() {
  const dir = path.join(__dirname, 'cert');
  const key = path.join(dir, 'key.pem');
  const crt = path.join(dir, 'cert.pem');
  if (fs.existsSync(key) && fs.existsSync(crt)) return { key, crt };
  fs.mkdirSync(dir, { recursive: true });
  try {
    require('child_process').execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048',
      '-keyout', key, '-out', crt, '-days', '3650', '-nodes', '-subj', '/CN=localhost'],
      { stdio: 'ignore' });
    return { key, crt };
  } catch { return null; }
}

function singboxConfig(cert) {
  const inbounds = [
    { type: 'vless', tag: 'vless-in', listen: '127.0.0.1', listen_port: 10001,
      users: [{ uuid: UUID }],
      transport: { type: 'ws', path: '/vless' } },
    { type: 'vmess', tag: 'vmess-in', listen: '127.0.0.1', listen_port: 10002,
      users: [{ uuid: UUID, alterId: 0 }],
      transport: { type: 'ws', path: '/vmess' } },
    { type: 'trojan', tag: 'trojan-in', listen: '127.0.0.1', listen_port: 10003,
      users: [{ password: UUID }],
      transport: { type: 'ws', path: '/trojan' } },
  ];
  if (cert) {
    const tls = { enabled: true, server_name: 'localhost', insecure: true,
      certificate_path: cert.crt, key_path: cert.key };
    inbounds.push(
      { type: 'anytls', tag: 'anytls-in', listen: '::', listen_port: ANYTLS_PORT,
        users: [{ password: UUID }], tls },
      { type: 'hysteria2', tag: 'hy2-in', listen: '::', listen_port: HY2_PORT,
        users: [{ password: UUID }], tls },
      { type: 'tuic', tag: 'tuic-in', listen: '::', listen_port: TUIC_PORT,
        users: [{ uuid: UUID, password: UUID }], congestion_control: 'bbr', tls },
    );
  }
  return { log: { level: 'warn' }, inbounds,
    outbounds: [{ type: 'direct', tag: 'direct' }] };
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const handle = (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400)
        return require('https').get(res.headers.location, handle);
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
      const f = fs.createWriteStream(dest);
      res.pipe(f); f.on('finish', () => f.close(resolve));
    };
    require('https').get(url, handle).on('error', reject);
  });
}

async function ensureSingbox() {
  const bin = path.join(__dirname, 'bin', process.platform === 'win32' ? 'sing-box.exe' : 'sing-box');
  if (fs.existsSync(bin)) return bin;
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  let tag = 'v1.12.0';
  try {
    const api = await new Promise((resolve, reject) => {
      require('https').get('https://api.github.com/repos/SagerNet/sing-box/releases/latest',
        { headers: { 'User-Agent': 'node' } }, res => {
          let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
        }).on('error', reject);
    });
    const t = JSON.parse(api).tag_name; if (t) tag = t;
  } catch {}
  const ver = tag.replace(/^v/, '');
  const tgz = path.join(__dirname, `sing-box-${ver}-linux-${arch}.tar.gz`);
  await download(`https://github.com/SagerNet/sing-box/releases/download/${tag}/sing-box-${ver}-linux-${arch}.tar.gz`, tgz);
  await new Promise((resolve, reject) =>
    execFile('tar', ['-xzf', tgz, '-C', __dirname], e => e ? reject(e) : resolve()));
  fs.copyFileSync(path.join(__dirname, `sing-box-${ver}-linux-${arch}`, 'sing-box'), bin);
  fs.chmodSync(bin, 0o755);
  return bin;
}

let sb = null;
async function startCore() {
  try {
    const bin = await ensureSingbox();
    const cfg = path.join(__dirname, 'config.json');
    fs.writeFileSync(cfg, JSON.stringify(singboxConfig(ensureCert()), null, 2));
    const run = () => {
      sb = spawn(bin, ['run', '-c', cfg], { stdio: ['ignore', 'pipe', 'pipe'] });
      sb.stderr.on('data', d => process.stderr.write('[core] ' + d));
      sb.on('exit', () => setTimeout(run, 3000));
    };
    run();
    console.log('core started');
  } catch (e) { console.error('core failed:', e.message); }
}

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/' + UUID) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(Buffer.from(NODE_LINK).toString('base64'));
  }
  if (url === '/link') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(NODE_LINK);
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><title>app</title><p>service running</p>');
});

server.on('upgrade', (req, socket, head) => {
  const p = (req.url || '').split('?')[0];
  const target = WS_ROUTES[p];
  if (!target) return socket.destroy();
  const up = net.connect(target, '127.0.0.1', () => {
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
    for (let i = 0; i < req.rawHeaders.length; i += 2)
      lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    up.write(lines.join('\r\n') + '\r\n\r\n');
    if (head && head.length) up.write(head);
    up.pipe(socket); socket.pipe(up);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`app listening on ${PORT}`);
  console.log(`subscription path: /${UUID}`);
});
startCore();
