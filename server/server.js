/*
 * 成品视频工作台 - 后端服务器（单文件，Node.js 内置模块，无需 npm 依赖）
 *
 * 运行：node server.js
 *
 * 环境变量（部署时配置）：
 *   PORT            监听端口，默认 3000
 *   BASE_URL        对外访问地址，例如 https://video.example.com（用于拼接视频链接）
 *   DATA_DIR        视频存储目录，默认 ./data
 *   CORS_ORIGIN     允许跨域的来源，默认 *（前端域名）
 *   WX_CORP_ID      企业微信「企业ID」          —— 拿到管理员权限后填写
 *   WX_CORP_SECRET  企业微信自建应用「Secret」   —— 拿到管理员权限后填写
 *   WX_AGENT_ID     企业微信自建应用「AgentId」  —— 拿到管理员权限后填写
 *
 * 接口：
 *   POST /api/upload?ext=mp4   上传视频（body 为二进制），返回 { url }
 *   GET  /v/:file              访问视频（支持 Range 拖动播放）
 *   GET  /api/wx-config?url=   生成企业微信 JS-SDK 签名（需配置 WX_* ）
 *   GET  /api/health           健康检查
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  baseUrl: (process.env.BASE_URL || '').replace(/\/+$/, ''),
  hasBaseUrl: !!process.env.BASE_URL,
  dataDir: process.env.DATA_DIR || path.join(__dirname, 'data'),
  corsOrigin: process.env.CORS_ORIGIN || '*',
  corpId: process.env.WX_CORP_ID || '',
  corpSecret: process.env.WX_CORP_SECRET || '',
  agentId: process.env.WX_AGENT_ID || '',
  maxBytes: 500 * 1024 * 1024,
};

const videoDir = path.join(config.dataDir, 'v');
fs.mkdirSync(videoDir, { recursive: true });

/* 前端页面：由本服务直接托管，实现「页面 + 接口」同源，
   避免 https 页面调用 http 接口被浏览器按混合内容拦截 */
const frontendCandidates = [
  process.env.FRONTEND_PATH || '',
  path.join(__dirname, '..', 'index.html'),
  path.join(__dirname, 'index.html'),
  path.join(__dirname, 'public', 'index.html'),
].filter(Boolean);
const FRONTEND_FILE = frontendCandidates.find((f) => { try { return fs.statSync(f).isFile(); } catch (e) { return false; } }) || '';


function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', config.corsOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  setCors(res);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

/* 对外地址：优先 BASE_URL，否则按请求 Host 动态推导（避免返回 localhost） */
function publicBase(req) {
  if (config.baseUrl) return config.baseUrl;
  const host = (req.headers.host || '').trim();
  if (host) return (req.headers['x-forwarded-proto'] || 'http') + '://' + host;
  return 'http://localhost:' + config.port;
}

function extToType(ext) {
  const map = { mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime' };
  return map[ext] || 'application/octet-stream';
}

/* ---------- 上传：接收二进制视频流，写入磁盘 ---------- */
function handleUpload(req, res, query) {
  const ext = (query.get('ext') || 'mp4').replace(/[^a-z0-9]/gi, '').slice(0, 10) || 'mp4';
  const id = crypto.randomBytes(8).toString('hex');
  const fileName = id + '.' + ext;
  const filePath = path.join(videoDir, fileName);

  const ws = fs.createWriteStream(filePath);
  let size = 0;
  let aborted = false;

  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > config.maxBytes) {
      aborted = true;
      ws.destroy();
      fs.unlink(filePath, () => {});
      sendJson(res, 413, { ok: false, error: '视频过大' });
      return;
    }
  });
  req.pipe(ws);

  ws.on('finish', () => {
    if (aborted) return;
    sendJson(res, 200, { ok: true, url: publicBase(req) + '/v/' + fileName, id });
  });
  ws.on('error', (err) => {
    fs.unlink(filePath, () => {});
    if (!aborted) sendJson(res, 500, { ok: false, error: err.message });
  });
}

/* ---------- 视频访问：支持 Range 拖动播放 ---------- */
function handleVideo(req, res, pathname) {
  const file = path.basename(pathname);
  const filePath = path.join(videoDir, file);
  if (!fs.existsSync(filePath)) {
    setCors(res);
    res.writeHead(404);
    res.end('Not Found');
    return;
  }
  const stat = fs.statSync(filePath);
  const total = stat.size;
  const ext = path.extname(file).slice(1).toLowerCase();
  const type = extToType(ext);
  const range = req.headers.range;

  setCors(res);
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : total - 1;
    if (isNaN(start) || start < 0) start = 0;
    if (isNaN(end) || end >= total) end = total - 1;
    if (start > end) {
      res.writeHead(416, { 'Content-Range': 'bytes */' + total });
      res.end();
      return;
    }
    res.writeHead(206, {
      'Content-Type': type,
      'Content-Length': end - start + 1,
      'Content-Range': 'bytes ' + start + '-' + end + '/' + total,
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': total, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(filePath).pipe(res);
  }
}

/* ---------- 企业微信 JS-SDK 签名 ---------- */
let tokenCache = { token: '', expire: 0 };
let ticketCache = { ticket: '', expire: 0 };

function wxGet(pathname) {
  return new Promise((resolve, reject) => {
    https.get('https://qyapi.weixin.qq.com' + pathname, (r) => {
      let data = '';
      r.on('data', (c) => (data += c));
      r.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function getAccessToken() {
  if (tokenCache.token && Date.now() < tokenCache.expire) return tokenCache.token;
  const r = await wxGet('/cgi-bin/gettoken?corpid=' + encodeURIComponent(config.corpId) + '&corpsecret=' + encodeURIComponent(config.corpSecret));
  if (r.errcode) throw new Error('获取 access_token 失败：' + r.errmsg);
  tokenCache = { token: r.access_token, expire: Date.now() + (r.expires_in - 300) * 1000 };
  return tokenCache.token;
}

async function getJsapiTicket() {
  if (ticketCache.ticket && Date.now() < ticketCache.expire) return ticketCache.ticket;
  const token = await getAccessToken();
  const r = await wxGet('/cgi-bin/get_jsapi_ticket?access_token=' + token);
  if (r.errcode) throw new Error('获取 jsapi_ticket 失败：' + r.errmsg);
  ticketCache = { ticket: r.ticket, expire: Date.now() + (r.expires_in - 300) * 1000 };
  return ticketCache.ticket;
}

async function handleWxConfig(req, res, query) {
  if (!config.corpId || !config.corpSecret) {
    sendJson(res, 400, { ok: false, error: '后端未配置企业微信应用（缺 WX_CORP_ID / WX_CORP_SECRET）' });
    return;
  }
  const url = query.get('url') || publicBase(req) + '/';
  try {
    const ticket = await getJsapiTicket();
    const nonceStr = crypto.randomBytes(16).toString('hex');
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const str = 'jsapi_ticket=' + ticket + '&noncestr=' + nonceStr + '&timestamp=' + timestamp + '&url=' + url;
    const signature = crypto.createHash('sha1').update(str).digest('hex');
    sendJson(res, 200, {
      ok: true,
      corpId: config.corpId,
      agentId: config.agentId,
      timestamp,
      nonceStr,
      signature,
    });
  } catch (e) {
    sendJson(res, 500, { ok: false, error: e.message });
  }
}

/* ---------- 路由 ---------- */
const server = http.createServer((req, res) => {
  const parsed = new URL(req.url, 'http://localhost');
  const pathname = parsed.pathname;
  const query = parsed.searchParams;

  if (req.method === 'OPTIONS') {
    setCors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'POST' && pathname === '/api/upload') {
    handleUpload(req, res, query);
    return;
  }
  if (pathname.startsWith('/v/')) {
    handleVideo(req, res, pathname);
    return;
  }
  if (req.method === 'GET' && pathname === '/api/wx-config') {
    handleWxConfig(req, res, query);
    return;
  }
  if (req.method === 'GET' && pathname === '/api/health') {
    sendJson(res, 200, { ok: true, service: 'video-workbench-server' });
    return;
  }
  /* 首页：直接托管前端页面（同源，无混合内容/CORS 问题） */
  if ((req.method === 'GET' || req.method === 'HEAD') && (pathname === '/' || pathname === '/index.html')) {
    if (!FRONTEND_FILE) {
      sendJson(res, 500, { ok: false, error: '未找到前端页面文件（设置 FRONTEND_PATH）' });
      return;
    }
    const html = fs.readFileSync(FRONTEND_FILE);
    setCors(res);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': html.length,
      'Cache-Control': 'no-store',
    });
    if (req.method === 'HEAD') { res.end(); return; }
    res.end(html);
    return;
  }
  sendJson(res, 404, { ok: false, error: 'Not Found' });
});

server.listen(config.port, () => {
  console.log('video-workbench-server 已启动：http://localhost:' + config.port);
  console.log('视频存储目录：' + videoDir);
  console.log('对外地址：' + (config.baseUrl || '按请求 Host 动态推导'));
  console.log('企业微信应用已配置：' + (config.corpId && config.corpSecret ? '是' : '否（待填 WX_* ）'));
  console.log('前端页面：' + (FRONTEND_FILE || '未找到（仅提供 API）'));
});
