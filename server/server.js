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
 *   POST /api/upload?ext=mp4&name=  上传视频（body 为二进制），返回 { url, file }
 *   POST /api/compose              云端合成（JSON）：主视频+穿插素材+BGM+字幕 → ffmpeg → mp4
 *   GET  /v/:file        浏览器打开 → 保存页（预览+保存按钮）；播放器子请求 → 视频字节
 *   GET  /raw/:file      视频字节（供 <video> 使用，支持 Range）
 *   GET  /dl/:file       强制下载（Content-Disposition: attachment）
 *   GET  /api/wx-config?url=   生成企业微信 JS-SDK 签名（需配置 WX_* ）
 *   GET  /api/health     健康检查
 *   GET  /               托管前端页面（同源，避免混合内容）
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const { spawn } = require('child_process');

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
function sanitizeName(n) {
  const s = String(n || '').replace(/[\\/:*?"<>|\r\n]+/g, '_').trim().slice(0, 80);
  return s;
}

function handleUpload(req, res, query) {
  const ext = (query.get('ext') || 'mp4').replace(/[^a-z0-9]/gi, '').slice(0, 10) || 'mp4';
  const id = crypto.randomBytes(8).toString('hex');
  const fileName = id + '.' + ext;
  const filePath = path.join(videoDir, fileName);
  const original = sanitizeName(query.get('name'));

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
    if (original) {
      try {
        fs.writeFileSync(filePath + '.name', original, 'utf8');
      } catch (e) { /* 忽略元数据写入失败 */ }
    }
    sendJson(res, 200, { ok: true, url: publicBase(req) + '/v/' + fileName, id, file: fileName });
  });
  ws.on('error', (err) => {
    fs.unlink(filePath, () => {});
    if (!aborted) sendJson(res, 500, { ok: false, error: err.message });
  });
}

/* ---------- 下载文件名：优先上传时记录的原始文件名 ---------- */
function downloadName(file) {
  try {
    const n = fs.readFileSync(path.join(videoDir, file + '.name'), 'utf8').trim();
    if (n) return n;
  } catch (e) { /* 无元数据 */ }
  return '成片_' + path.basename(file, path.extname(file)).slice(0, 8) + path.extname(file);
}

/* RFC 5987：非 ASCII 文件名（中文）需要 filename* 编码 */
function contentDisposition(file) {
  const name = downloadName(file);
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return "attachment; filename=\"" + ascii + "\"; filename*=UTF-8''" + encodeURIComponent(name);
}


/* ---------- 视频访问：支持 Range 拖动播放 ----------
   mode='raw' : 返回视频字节（播放器子请求）
   mode='dl'  : 返回字节 + Content-Disposition: attachment（强制下载）
   mode='auto': 浏览器导航请求（Accept 含 text/html 且无 Range）返回「保存页」HTML，其余返回字节 */
function handleVideo(req, res, pathname, mode) {
  const file = path.basename(pathname);
  const filePath = path.join(videoDir, file);
  if (!fs.existsSync(filePath)) {
    setCors(res);
    res.writeHead(404);
    res.end('Not Found');
    return;
  }
  if (mode === 'auto') {
    const accept = String(req.headers.accept || '');
    if (/text\/html/.test(accept) && !req.headers.range && req.method === 'GET') {
      sendVideoPage(res, file);
      return;
    }
    mode = 'raw';
  }
  const stat = fs.statSync(filePath);
  const total = stat.size;
  const ext = path.extname(file).slice(1).toLowerCase();
  const type = extToType(ext);
  const range = req.headers.range;
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes' };
  if (mode === 'dl') headers['Content-Disposition'] = contentDisposition(file);

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
    headers['Content-Length'] = end - start + 1;
    headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + total;
    res.writeHead(206, headers);
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    headers['Content-Length'] = total;
    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
  }
}

/* ---------- 保存页：浏览器打开 /v/xxx.mp4 时展示「预览 + 保存视频」界面 ---------- */
function sendVideoPage(res, file) {
  const name = downloadName(file).replace(/[<>&"]/g, '');
  const raw = '/raw/' + file;
  const dl = '/dl/' + file;
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${name}</title>
<style>
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
body{margin:0;background:#111;color:#fff;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;text-align:center}
video{width:100%;max-height:62vh;background:#000;display:block}
.hint{font-size:14px;color:#ffb4a8;line-height:1.7;padding:14px 18px 0}
.wrap{padding:16px 18px 40px;max-width:520px;margin:0 auto}
.name{font-size:15px;font-weight:700;margin:6px 0 14px;word-break:break-all}
a.btn{display:block;width:100%;padding:14px 0;border:0;border-radius:10px;background:#e5322d;color:#fff;font-size:17px;font-weight:700;text-decoration:none;margin-bottom:12px}
a.btn.alt{background:#2b2f36}
.tip{display:none;background:#2a2418;border:1px solid #6b5322;color:#ffd479;border-radius:10px;padding:12px 14px;font-size:14px;line-height:1.8;text-align:left;margin-top:6px}
.tip.on{display:block}
.tip b{color:#fff}
.ok{color:#8fd48f}
</style>
</head>
<body>
<video src="${raw}" controls playsinline webkit-playsinline preload="metadata"></video>
<div class="wrap">
  <div class="name">${name}</div>
  <a class="btn" id="dl" href="${dl}">保存视频</a>
  <a class="btn alt" id="copy" href="javascript:void(0)">复制本页链接</a>
  <div class="hint" id="hint" style="display:none;padding:12px 0 0"></div>
  <div class="tip" id="tip"></div>
</div>
<script>
(function(){
  var ua=navigator.userAgent||'';
  var isWx=/micromessenger|wxwork/i.test(ua);
  var tip=document.getElementById('tip');
  var hint=document.getElementById('hint');
  function showTip(html){tip.innerHTML=html;tip.className='tip on';}
  if(isWx){
    hint.style.display='block';
    hint.innerHTML='你在微信/企业微信内打开，浏览器下载可能被拦截。';
  }
  document.getElementById('dl').onclick=function(e){
    if(!isWx)return; /* 正常浏览器直接走 attachment 下载 */
    e.preventDefault();
    showTip('微信内可能无法直接保存，请按下面步骤：<br>1. 点右上角 <b>···</b> 菜单<br>2. 选择 <b>在浏览器中打开</b><br>3. 回到本页再点 <b>保存视频</b><br><br>仍然失败？点右上角菜单里的「复制链接」，在系统浏览器粘贴打开后保存。');
  };
  document.getElementById('copy').onclick=function(){
    var t=location.href;
    if(navigator.clipboard&&navigator.clipboard.writeText){
      navigator.clipboard.writeText(t).then(function(){showTip('<span class="ok">链接已复制</span>');},function(){window.prompt('长按复制链接：',t);});
    }else{window.prompt('长按复制链接：',t);}
  };
})();
</script>
</body>
</html>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}


/* ---------- 云端合成：主视频 + 穿插素材 + BGM + 字幕，用服务器 ffmpeg 完成 ---------- */

/* 下载远程文件（COS 素材等）到本地临时文件，支持 http/https + 重定向 */
function downloadTo(url, dest) {
  return new Promise((resolve, reject) => {
    const mod = /^https:/.test(url) ? https : http;
    const req = mod.get(url, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        req.destroy();
        downloadTo(new URL(r.headers.location, url).href, dest).then(resolve, reject);
        return;
      }
      if (r.statusCode !== 200) {
        req.destroy();
        reject(new Error('下载素材失败 HTTP ' + r.statusCode));
        return;
      }
      const ws = fs.createWriteStream(dest);
      r.pipe(ws);
      ws.on('finish', () => ws.close(() => resolve()));
      ws.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(new Error('下载素材超时')); });
  });
}

/* 运行 ffmpeg，返回 Promise */
function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); if (err.length > 8000) err = err.slice(-8000); });
    p.on('error', reject);
    p.on('close', (code) => { code === 0 ? resolve() : reject(new Error(err || ('ffmpeg exit ' + code))); });
  });
}

/* 生成 .ass 字幕文件（底部居中，白字/关键词金色，粗黑描边） */
function assTime(t) {
  t = Math.max(0, Number(t) || 0);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60), cs = Math.round((t - Math.floor(t)) * 100);
  return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') + '.' + String(cs).padStart(2, '0');
}
const SUBTITLE_KEYWORDS = ['价格', '元', '折', '优惠', '活动', '限时', '现货', '包邮', '特价', '最低', '抢购', '秒杀', '直降', '立减', '促销', '折扣', '全场', '买', '送', '免费'];
function buildAss(subs) {
  let events = '';
  for (const s of subs) {
    const text = String(s.text || '').replace(/[{}]/g, '').replace(/,/g, '，').replace(/\\/g, '');
    if (!text) continue;
    let gold = false;
    for (const k of SUBTITLE_KEYWORDS) { if (text.indexOf(k) >= 0) { gold = true; break; } }
    const style = gold ? 'Gold' : 'Default';
    events += 'Dialogue: 0,' + assTime(s.start) + ',' + assTime(s.end) + ',' + style + ',,0,0,0,,' + text + '\n';
  }
  return `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Noto Sans CJK SC,86,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,6,0,2,0,0,153,1
Style: Gold,Noto Sans CJK SC,86,&H0000D7FF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,6,0,2,0,0,153,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
` + events;
}

/* 读取请求 body（限制大小） */
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > maxBytes) { reject(new Error('请求过大')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleCompose(req, res) {
  let input;
  try { input = JSON.parse(await readBody(req, 4 * 1024 * 1024)); }
  catch (e) { sendJson(res, 400, { ok: false, error: '请求解析失败' }); return; }

  const mainFile = String(input.main || '').replace(/[^a-z0-9.]/gi, '');
  const mainPath = path.join(videoDir, mainFile);
  if (!mainFile || !fs.existsSync(mainPath)) { sendJson(res, 400, { ok: false, error: '主视频不存在，请重拍或重试' }); return; }

  const tmpDir = path.join(config.dataDir, 'tmp', crypto.randomBytes(8).toString('hex'));
  fs.mkdirSync(tmpDir, { recursive: true });

  const ins = (Array.isArray(input.ins) ? input.ins : []).slice(0, 2);
  const bgmUrl = String(input.bgm || '');
  const subs = Array.isArray(input.subs) ? input.subs : [];
  const mirrored = !!input.mirrored;
  const name = String(input.name || '');

  const args = ['-y', '-i', mainPath];
  const insFiles = [];
  for (let i = 0; i < ins.length; i++) {
    const u = ins[i] && ins[i].url;
    if (!u) continue;
    try {
      const dest = path.join(tmpDir, 'ins' + i + '.mp4');
      await downloadTo(u, dest);
      insFiles.push({ path: dest, start: parseFloat(ins[i].start) || 0, dur: parseFloat(ins[i].dur) || 2 });
      args.push('-i', dest);
    } catch (e) { /* 单个素材失败则跳过，不影响整体 */ }
  }
  let bgmPath = null;
  if (bgmUrl) {
    try {
      bgmPath = path.join(tmpDir, 'bgm.mp3');
      await downloadTo(bgmUrl, bgmPath);
      args.push('-i', bgmPath);
    } catch (e) { bgmPath = null; }
  }

  /* 视频滤镜：主视频 9:16 裁剪，镜像翻转，穿插素材整屏替换，字幕烧录 */
  const fc = [];
  let last = 'm0';
  fc.push('[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1' + (mirrored ? ',hflip' : '') + '[m0]');
  for (let i = 0; i < insFiles.length; i++) {
    const inp = (i + 1) + ':v';
    const st = insFiles[i].start, en = st + insFiles[i].dur;
    fc.push('[' + inp + ']scale=1080:1920,setsar=1[i' + i + ']');
    fc.push('[' + last + '][i' + i + ']overlay=0:0:enable=\'between(t,' + st.toFixed(3) + ',' + en.toFixed(3) + ')\':eof_action=pass[m' + (i + 1) + ']');
    last = 'm' + (i + 1);
  }
  let vLabel = last;
  if (subs.length) {
    const assPath = path.join(tmpDir, 'subs.ass');
    fs.writeFileSync(assPath, buildAss(subs), 'utf8');
    fc.push('[' + last + ']subtitles=' + assPath + '[vout]');
    vLabel = 'vout';
  }

  /* 音频：主视频音量增益 1.8；有 BGM 时混入（0.22） */
  fc.push('[0:a]volume=1.8[a0]');
  if (bgmPath) {
    const aIdx = 1 + insFiles.length;
    fc.push('[' + aIdx + ':a]volume=0.22[a1]');
    fc.push('[a0][a1]amix=inputs=2:duration=first:dropout_transition=0[aout]');
  } else {
    fc.push('[a0]anull[aout]');
  }

  args.push('-filter_complex', fc.join(';'));
  args.push('-map', '[' + vLabel + ']', '-map', '[aout]');
  args.push('-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-r', '30', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart');

  const outId = crypto.randomBytes(8).toString('hex');
  const outFile = outId + '.mp4';
  const outPath = path.join(videoDir, outFile);
  args.push(outPath);

  try {
    await runFfmpeg(args);
    if (name) { try { fs.writeFileSync(outPath + '.name', name.slice(0, 80), 'utf8'); } catch (e) { /* 忽略 */ } }
    sendJson(res, 200, { ok: true, url: publicBase(req) + '/v/' + outFile, id: outId });
  } catch (e) {
    try { fs.unlinkSync(outPath); } catch (_) { /* 忽略 */ }
    sendJson(res, 500, { ok: false, error: '合成失败：' + (e.message || '').split('\n').pop() });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }
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
  if (req.method === 'POST' && pathname === '/api/compose') {
    handleCompose(req, res);
    return;
  }
  if (pathname.startsWith('/v/')) {
    handleVideo(req, res, pathname, 'auto');
    return;
  }
  if (pathname.startsWith('/raw/')) {
    handleVideo(req, res, pathname, 'raw');
    return;
  }
  if (pathname.startsWith('/dl/')) {
    handleVideo(req, res, pathname, 'dl');
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
  /* ffmpeg.wasm 静态文件（同源加载，避免 jsDelivr 在国内极慢/被墙） */
  if ((req.method === 'GET' || req.method === 'HEAD') && pathname.startsWith('/ffmpeg/')) {
    const filePath = path.join(__dirname, 'ffmpeg', pathname.slice('/ffmpeg/'.length));
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) throw new Error('not file');
      const ext = path.extname(filePath).toLowerCase();
      const type = ext === '.wasm' ? 'application/wasm' : ext === '.js' ? 'application/javascript' : 'application/octet-stream';
      const data = fs.readFileSync(filePath);
      setCors(res);
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': data.length,
        'Cache-Control': 'public, max-age=31536000',
      });
      if (req.method === 'HEAD') { res.end(); return; }
      res.end(data);
      return;
    } catch (e) {
      sendJson(res, 404, { ok: false, error: 'Not Found' });
      return;
    }
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
