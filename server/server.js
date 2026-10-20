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
const os = require('os');

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
  statsKey: process.env.STATS_KEY || 'sanhe666',
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
  if (host) {
    /* 优先反向代理头；否则按连接是否加密判断，避免 https 请求返回 http 链接（混合内容拦截） */
    const enc = req.socket && req.socket.encrypted;
    const proto = req.headers['x-forwarded-proto'] || (enc ? 'https' : 'http');
    return proto + '://' + host;
  }
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
  <a class="btn" id="save" href="javascript:void(0)">准备中 0%</a>
  <a class="btn alt" id="dl" href="${dl}">下载到文件</a>
  <a class="btn alt" id="copy" href="javascript:void(0)">复制本页链接</a>
  <div class="hint" id="hint">正在把成片准备到手机，准备好后点「保存到相册」，在系统菜单里选「储存视频」。</div>
  <div class="tip" id="tip"></div>
</div>
<script>
(function(){
  var raw='${raw}', name='${name}';
  var btn=document.getElementById('save');
  var hint=document.getElementById('hint');
  var tip=document.getElementById('tip');
  function showTip(html){tip.innerHTML=html;tip.className='tip on';}
  function setBtn(txt,disabled){btn.textContent=txt;if(disabled)btn.setAttribute('disabled','');else btn.removeAttribute('disabled');}
  var file=null, err=null;
  function start(){
    file=null;err=null;setBtn('准备中 0%',true);hint.textContent='正在把成片准备到手机…';
    var xhr=new XMLHttpRequest();
    xhr.open('GET',raw,true);xhr.responseType='blob';xhr.timeout=300000;
    xhr.onprogress=function(e){if(e.lengthComputable)setBtn('准备中 '+Math.round(e.loaded/e.total*100)+'%',true);};
    xhr.onload=function(){
      if(xhr.status!==200){err='HTTP '+xhr.status;setBtn('重新准备',false);hint.textContent='准备失败（'+err+'），请点「重新准备」';return;}
      var f=null;
      try{f=new File([xhr.response],name||('成片_'+Date.now()+'.mp4'),{type:xhr.response.type||'video/mp4'});}catch(e){f=xhr.response;}
      file=f;setBtn('保存到相册',false);
      hint.textContent='成片已准备好：点「保存到相册」→ 在系统菜单里选「储存视频」';
    };
    xhr.onerror=function(){err='网络错误';setBtn('重新准备',false);hint.textContent='网络错误，请点「重新准备」';};
    xhr.ontimeout=function(){err='下载超时';setBtn('重新准备',false);hint.textContent='下载超时，请点「重新准备」';};
    xhr.send();
  }
  btn.onclick=function(){
    if(!file){if(err)start();return;}
    if(!navigator.share){showTip('当前浏览器不支持一键保存，请点「下载到文件」，或长按上方视频选择「储存视频」。');return;}
    var p;
    try{p=(navigator.canShare&&navigator.canShare({files:[file]}))?navigator.share({files:[file],title:name||'短视频成片'}):navigator.share({title:name||'短视频成片',url:location.href});}
    catch(e){showTip('没弹出菜单？<b>长按上方视频</b>选择「储存视频」，或点「下载到文件」。');return;}
    (p&&p.then?p:Promise.resolve()).catch(function(e){
      if(e&&e.name==='AbortError')return;
      showTip('没弹出菜单？<b>长按上方视频</b>选择「储存视频」，或点「下载到文件」。');
    });
  };
  document.getElementById('copy').onclick=function(){
    var t=location.href;
    if(navigator.clipboard&&navigator.clipboard.writeText){
      navigator.clipboard.writeText(t).then(function(){showTip('<span class="ok">链接已复制</span>');},function(){window.prompt('长按复制链接：',t);});
    }else{window.prompt('长按复制链接：',t);}
  };
  start();
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

/* 运行 ffmpeg，返回 Promise（带超时保护，防止个别输入让 ffmpeg 卡死拖垮服务器） */
function runFfmpeg(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { p.kill('SIGKILL'); } catch (e) { /* 忽略 */ }
      reject(new Error('ffmpeg 执行超时，已终止'));
    }, timeoutMs || 240000);
    p.stderr.on('data', (d) => { err += d.toString(); if (err.length > 8000) err = err.slice(-8000); });
    p.on('error', (e) => { if (done) return; done = true; clearTimeout(timer); reject(e); });
    p.on('close', (code) => { if (done) return; done = true; clearTimeout(timer); code === 0 ? resolve() : reject(new Error(err || ('ffmpeg exit ' + code))); });
  });
}

/* 生成 .ass 字幕文件（底部居中，白字/关键词金色，粗黑描边） */
function assTime(t) {
  t = Math.max(0, Number(t) || 0);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60), cs = Math.round((t - Math.floor(t)) * 100);
  return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') + '.' + String(cs).padStart(2, '0');
}
const SUBTITLE_KEYWORDS = ['价格', '元', '折', '优惠', '活动', '限时', '现货', '包邮', '特价', '最低', '抢购', '秒杀', '直降', '立减', '促销', '折扣', '全场', '买', '送', '免费'];
function buildAss(subs, w, h) {
  const W = w || 1080, H = h || 1920;
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
PlayResX: ${W}
PlayResY: ${H}
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Noto Sans CJK SC,120,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,6,0,2,0,0,153,1
Style: Gold,Noto Sans CJK SC,120,&H0000D7FF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,6,0,2,0,0,153,1

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
  /* 输出尺寸：默认宽度固定 1080；前端上报手机屏幕物理分辨率时按屏幕宽高输出，保证铺满整屏 */
  let OUT_W = parseInt(input.outW, 10);
  if (!Number.isFinite(OUT_W) || OUT_W < 720 || OUT_W > 1440) OUT_W = 1080;
  OUT_W = OUT_W - (OUT_W % 2);
  let OUT_H = parseInt(input.outH, 10);
  if (!Number.isFinite(OUT_H) || OUT_H < 1200 || OUT_H > 3200) OUT_H = Math.round(OUT_W * 16 / 9);
  OUT_H = OUT_H - (OUT_H % 2);
  const mirrored = !!input.mirrored;
  const name = String(input.name || '');

  /* 探测主视频是否含音轨（无麦克风录制时会没有音轨，需补静音，否则合成失败） */
  const hasAudio = await new Promise((resolve) => {
    try {
      const p = spawn('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_type', '-of', 'default=nw=1:nk=1', mainPath]);
      let out = '';
      p.stdout.on('data', (d) => { out += d; });
      p.on('close', () => resolve(/audio/.test(out)));
      p.on('error', () => resolve(true));
    } catch (e) { resolve(true); }
  });

  const args = ['-y', '-fflags', '+genpts+discardcorrupt', '-i', mainPath];
  const insFiles = [];
  for (let i = 0; i < ins.length; i++) {
    const u = ins[i] && ins[i].url;
    if (!u) continue;
    const dest = path.join(tmpDir, 'ins' + i + '.mp4');
    let ok = false;
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      try { await downloadTo(u, dest); ok = true; }
      catch (e) { if (attempt < 2) await new Promise((r) => setTimeout(r, 900)); }
    }
    if (ok) {
      insFiles.push({ path: dest, start: parseFloat(ins[i].start) || 0, dur: parseFloat(ins[i].dur) || 3.5 });
      args.push('-i', dest);
      console.log('[compose] 穿插素材#%d 已就绪 start=%s dur=%s', i, ins[i].start, ins[i].dur);
    } else {
      console.log('[compose] 穿插素材#%d 下载失败，已跳过 url=%s', i, u);
    }
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
  fc.push('[0:v]scale=' + OUT_W + ':' + OUT_H + ':force_original_aspect_ratio=increase,crop=' + OUT_W + ':' + OUT_H + ',setsar=1' + (mirrored ? ',hflip' : '') + '[m0]');
  for (let i = 0; i < insFiles.length; i++) {
    const inp = (i + 1) + ':v';
    const st = insFiles[i].start, en = st + insFiles[i].dur;
    fc.push('[' + inp + ']scale=' + OUT_W + ':' + OUT_H + ':force_original_aspect_ratio=increase,crop=' + OUT_W + ':' + OUT_H + ',setsar=1,setpts=PTS-STARTPTS+' + st.toFixed(3) + '/TB[i' + i + ']');
    fc.push('[' + last + '][i' + i + ']overlay=0:0:enable=\'between(t,' + st.toFixed(3) + ',' + en.toFixed(3) + ')\':eof_action=pass[m' + (i + 1) + ']');
    last = 'm' + (i + 1);
  }
  let vLabel = last;
  if (subs.length) {
    const assPath = path.join(tmpDir, 'subs.ass');
    fs.writeFileSync(assPath, buildAss(subs, OUT_W, OUT_H), 'utf8');
    fc.push('[' + last + ']subtitles=' + assPath + '[vout]');
    vLabel = 'vout';
  }

  /* 主音频源：有音轨用主视频，无音轨则补一路静音（无麦克风录制时） */
  let mainAudio = '0:a';
  if (!hasAudio) {
    args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');
    mainAudio = (1 + insFiles.length + (bgmPath ? 1 : 0)) + ':a';
    console.log('[compose] 主视频无音轨，已补静音');
  }
  /* 音频：高通滤掉低频噪声 + FFT 降噪 + 温和增益（原来 1.8 会把底噪一起放大） */
  fc.push('[' + mainAudio + ']highpass=f=95,afftdn=nr=8:nf=-35,dynaudnorm=p=0.9,volume=1.05[a0]');
  if (bgmPath) {
    const aIdx = 1 + insFiles.length;
    fc.push('[' + aIdx + ':a]volume=0.22[a1]');
    fc.push('[a0][a1]amix=inputs=2:duration=first:dropout_transition=0[aout]');
  } else {
    fc.push('[a0]anull[aout]');
  }

  args.push('-filter_complex', fc.join(';'));
  args.push('-map', '[' + vLabel + ']', '-map', '[aout]');
  args.push('-c:v', 'libx264', '-crf', '20', '-maxrate', '3M', '-bufsize', '6M', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-r', '30', '-g', '30', '-bf', '0', '-profile:v', 'main', '-level', '5.0', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart');
  if (!hasAudio) args.push('-shortest'); /* 补静音时 anullsrc 是无限流，需限定到视频长度 */

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


/* ---------- 语音识别（字幕）----------
   优先用腾讯云 ASR（中文准、有免费额度、支持热词）；密钥从 config.local.json 或环境变量读取。
   腾讯云不可用时回退自托管 whisper.cpp。 */
let _localCfg = {};
try { _localCfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.local.json'), 'utf8')); } catch (e) { /* 无本地配置 */ }
const TENCENT_SECRET_ID = process.env.TENCENT_SECRET_ID || _localCfg.tencentSecretId || '';
const TENCENT_SECRET_KEY = process.env.TENCENT_SECRET_KEY || _localCfg.tencentSecretKey || '';
const TENCENT_ASR_SERVICE = 'asr';
const TENCENT_ASR_REGION = process.env.TENCENT_ASR_REGION || 'ap-guangzhou';
const TENCENT_ASR_HOST = 'asr.tencentcloudapi.com';

const WHISPER_CLI = process.env.WHISPER_CLI || path.join(os.homedir(), 'whisper.cpp', 'build', 'bin', 'whisper-cli');
const WHISPER_MODEL = process.env.WHISPER_MODEL || path.join(os.homedir(), 'whisper.cpp', 'models', 'ggml-small-q5_1.bin');

function _sha256hex(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function _hmac(key, s) { return crypto.createHmac('sha256', key).update(s).digest(); }

function tencentRequest(action, payload) {
  return new Promise((resolve, reject) => {
    const timestamp = Math.floor(Date.now() / 1000);
    const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
    const body = JSON.stringify(payload);
    const ct = 'application/json; charset=utf-8';
    const canonicalHeaders = 'content-type:' + ct + '\nhost:' + TENCENT_ASR_HOST + '\n';
    const signedHeaders = 'content-type;host';
    const canonicalRequest = 'POST\n/\n\n' + canonicalHeaders + '\n' + signedHeaders + '\n' + _sha256hex(body);
    const scope = date + '/' + TENCENT_ASR_SERVICE + '/tc3_request';
    const sts = 'TC3-HMAC-SHA256\n' + timestamp + '\n' + scope + '\n' + _sha256hex(canonicalRequest);
    const kDate = _hmac('TC3' + TENCENT_SECRET_KEY, date);
    const kService = _hmac(kDate, TENCENT_ASR_SERVICE);
    const kSigning = _hmac(kService, 'tc3_request');
    const sig = crypto.createHmac('sha256', kSigning).update(sts).digest('hex');
    const auth = 'TC3-HMAC-SHA256 Credential=' + TENCENT_SECRET_ID + '/' + scope + ', SignedHeaders=' + signedHeaders + ', Signature=' + sig;
    const req = https.request({ host: TENCENT_ASR_HOST, path: '/', method: 'POST', headers: {
      'Content-Type': ct, 'Host': TENCENT_ASR_HOST, 'Authorization': auth,
      'X-TC-Action': action, 'X-TC-Version': '2019-06-14', 'X-TC-Timestamp': String(timestamp), 'X-TC-Region': TENCENT_ASR_REGION,
    }}, (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error(d || ('HTTP ' + r.statusCode))); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 腾讯云录音文件识别：上传 base64 音频，异步轮询取结果 */
async function tencentAsr(audioBuffer) {
  const data = audioBuffer.toString('base64');
  const r1 = await tencentRequest('CreateRecTask', { EngineModelType: '16k_zh', ChannelNum: 1, ResTextFormat: 3, SourceType: 1, Data: data });
  if (r1.Response && r1.Response.Error) throw new Error('腾讯ASR: ' + r1.Response.Error.Message);
  const taskId = r1.Response && r1.Response.Data && r1.Response.Data.TaskId;
  if (!taskId) throw new Error('腾讯ASR: 未返回任务ID');
  for (let i = 0; i < 60; i++) {
    await _sleep(1000);
    const r2 = await tencentRequest('DescribeTaskStatus', { TaskId: taskId });
    const st = r2.Response && r2.Response.Data;
    if (st && st.Status === 2) {
      let text = String(st.Result || '').replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
      return text;
    }
    if (st && st.Status === 3) throw new Error('腾讯ASR: ' + (st.ErrorMsg || '识别失败'));
  }
  throw new Error('腾讯ASR: 识别超时');
}

function handleAsr(req, res) {
  const tmp = path.join(config.dataDir, 'tmp', crypto.randomBytes(8).toString('hex'));
  fs.mkdirSync(tmp, { recursive: true });
  const rawPath = path.join(tmp, 'in.bin');
  const wavPath = path.join(tmp, 'in.wav');
  const outPrefix = path.join(tmp, 'out');
  let size = 0, aborted = false;
  const ws = fs.createWriteStream(rawPath);
  const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* 忽略 */ } };
  req.on('data', (c) => {
    size += c.length;
    if (size > 80 * 1024 * 1024) {
      aborted = true;
      ws.destroy();
      fs.unlink(rawPath, () => {});
      sendJson(res, 413, { ok: false, error: '音频过大' });
    }
  });
  req.pipe(ws);
  ws.on('error', (err) => { fs.unlink(rawPath, () => {}); sendJson(res, 500, { ok: false, error: err.message }); });
  ws.on('finish', () => {
    if (aborted) return;
    const canTencent = !!(TENCENT_SECRET_ID && TENCENT_SECRET_KEY);
    const canWhisper = fs.existsSync(WHISPER_CLI) && fs.existsSync(WHISPER_MODEL);
    if (!canTencent && !canWhisper) {
      cleanup();
      sendJson(res, 500, { ok: false, error: '语音识别服务未部署' });
      return;
    }
    /* 1) 用 ffmpeg 归一化为 16k 单声道 WAV（兼容 wav / webm / mp4 输入）
          MediaRecorder 的 webm 常缺 pts/时长信息，加 genpts+discardcorrupt 增强兼容 */
    runFfmpeg(['-y', '-fflags', '+genpts+discardcorrupt', '-i', rawPath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wavPath])
      .then(() => {
        let wavSize = 0; try { wavSize = fs.statSync(wavPath).size; } catch (e) { /* 忽略 */ }
        console.log('[asr] ffmpeg done, in=' + size + 'B wav=' + wavSize + 'B tencent=' + canTencent);
        const wavBuf = fs.readFileSync(wavPath);
        /* 优先腾讯云（Data 需 base64≤5MB，约对应 3.5MB wav），否则回退 whisper */
        if (canTencent && wavSize > 0 && wavSize <= 3 * 1024 * 1024) {
          return tencentAsr(wavBuf).catch((e) => {
            console.log('[asr] tencent fail, fallback whisper: ' + e.message);
            if (!canWhisper) throw e;
            return whisperAsr(wavPath, outPrefix);
          });
        }
        if (canWhisper) return whisperAsr(wavPath, outPrefix);
        throw new Error('音频过大且无本地识别能力');
      })
      .then((text) => {
        console.log('[asr] in=' + size + 'B -> text(' + text.length + '): ' + (text ? text.slice(0, 40) : '<EMPTY>'));
        cleanup();
        sendJson(res, 200, { ok: true, text: text });
      })
      .catch((e) => {
        console.log('[asr] FAIL in=' + size + 'B err=' + (e && e.message));
        cleanup();
        sendJson(res, 200, { ok: true, text: '' });
      });
  });
}

/* 自托管 whisper 转写（腾讯云不可用时的兜底） */
function whisperAsr(wavPath, outPrefix) {
  return new Promise((resolve, reject) => {
    const child = spawn(WHISPER_CLI, ['-m', WHISPER_MODEL, '-f', wavPath, '-l', 'zh', '-np', '-otxt', '-of', outPrefix], { stdio: ['ignore', 'ignore', 'ignore'] });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* 忽略 */ } reject(new Error('whisper 识别超时')); }, 300000);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error('whisper 识别失败 code ' + code)); return; }
      let text = '';
      try { text = fs.readFileSync(outPrefix + '.txt', 'utf8').replace(/\s+/g, ' ').trim(); } catch (e) { /* 忽略 */ }
      resolve(text);
    });
  });
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

/* ---------- 运行日志采集（多用户运维链路） ---------- */
const logsDir = path.join(config.dataDir, 'logs');
fs.mkdirSync(logsDir, { recursive: true });
let logSeq = 0;
let logBuffer = [];               // 内存环形缓冲，供看板快速读取
const LOG_MAX = 4000;

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim();
  return req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : '';
}

function appendLog(entry) {
  logSeq += 1;
  entry.seq = logSeq;
  entry.ts = Date.now();
  entry.ip = entry.ip || '';
  logBuffer.push(entry);
  if (logBuffer.length > LOG_MAX) logBuffer.shift();
  /* 持久化到当日文件（追加） */
  try {
    const d = new Date(entry.ts);
    const fname = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + '.jsonl';
    fs.appendFileSync(path.join(logsDir, fname), JSON.stringify(entry) + '\n', 'utf8');
  } catch (e) { /* 忽略磁盘写入失败 */ }
}

function sanitizeLog(o) {
  const r = {
    u: String(o.u || 'anon').slice(0, 60),
    s: String(o.s || '').slice(0, 40),
    d: String(o.d || '').slice(0, 220),
    t: String(o.t || 'event').slice(0, 30),
    l: String(o.l || 'info').slice(0, 10),
    m: String(o.m || '').slice(0, 500),
    e: o.e || null,
  };
  return r;
}

function handleLog(req, res) {
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 1024 * 1024) { req.destroy(); return; } });
  req.on('end', () => {
    const ip = clientIp(req);
    let arr = null;
    try {
      const parsed = JSON.parse(body || '[]');
      arr = Array.isArray(parsed) ? parsed : [parsed];
    } catch (e) { arr = []; }
    let n = 0;
    for (const item of arr) {
      if (!item || typeof item !== 'object') continue;
      try { const e = sanitizeLog(item); e.ip = ip; appendLog(e); n += 1; } catch (e) { /* 忽略 */ }
    }
    sendJson(res, 200, { ok: true, n: n });
  });
}

function todayKey(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function handleGetLogs(req, res) {
  const q = new URL(req.url, 'http://localhost').searchParams;
  const since = parseInt(q.get('since') || '0', 10) || 0;
  const user = (q.get('user') || '').trim();
  const type = (q.get('type') || '').trim();
  const level = (q.get('level') || '').trim();
  const limit = Math.min(500, parseInt(q.get('limit') || '200', 10) || 200);
  let logs = logBuffer.filter((x) => x.seq > since);
  if (user) logs = logs.filter((x) => x.u === user);
  if (type) logs = logs.filter((x) => x.t === type);
  if (level) logs = logs.filter((x) => x.l === level);
  logs = logs.slice(-limit);
  /* 统计 */
  const today = todayKey(Date.now());
  const todayLogs = logBuffer.filter((x) => todayKey(x.ts) === today);
  const users = new Set(todayLogs.map((x) => x.u));
  const errs = todayLogs.filter((x) => x.l === 'error').length;
  const warn = todayLogs.filter((x) => x.l === 'warn').length;
  sendJson(res, 200, {
    ok: true,
    nowSeq: logSeq,
    logs: logs,
    stats: { totalToday: todayLogs.length, usersToday: users.size, errors: errs, warns: warn },
    users: Array.from(new Set(logBuffer.map((x) => x.u))).slice(-200),
    serverTime: Date.now(),
  });
}

/* ---------- 使用统计看板（口令访问） ---------- */
let _statsCache = { t: 0, data: null };
function readAllLogEntries() {
  const out = [];
  try {
    const files = fs.readdirSync(logsDir).filter((f) => /\.jsonl$/.test(f)).sort();
    for (const f of files) {
      try {
        const txt = fs.readFileSync(path.join(logsDir, f), 'utf8');
        for (const line of txt.split('\n')) {
          if (!line.trim()) continue;
          try { out.push(JSON.parse(line)); } catch (e) { /* 跳过坏行 */ }
        }
      } catch (e) { /* 跳过坏文件 */ }
    }
  } catch (e) { /* 目录不存在 */ }
  return out;
}
function dayKeyOf(ts) { const d = new Date(ts || 0); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function clickKind(e) {
  if (e.t === 'subtitle' && /开始生成字幕/.test(e.m)) return 'subtitle';
  if (e.t === 'compose' && /开始云端合成/.test(e.m)) return 'compose';
  if (e.t === 'save' && /点保存到相册|保存\/下载文件|开始预下载/.test(e.m)) return 'save';
  if (e.t === 'save' && /生成链接/.test(e.m)) return 'link';
  return null;
}
function computeStats() {
  const now = Date.now();
  if (_statsCache.data && now - _statsCache.t < 60000) return _statsCache.data;
  const entries = readAllLogEntries();
  const total = { clicks: 0, subtitle: 0, compose: 0, save: 0, link: 0, flows: 0, composed: 0, errors: 0, plays: 0, users: {} };
  const byDay = {};
  const sess = {};
  for (const e of entries) {
    const day = dayKeyOf(e.ts);
    if (!byDay[day]) byDay[day] = { day, clicks: 0, flows: 0, composed: 0, errors: 0, plays: 0 };
    if (e.t === 'usage' && /页面打开/.test(e.m)) { total.plays++; byDay[day].plays++; }
    if (e.l === 'error') { total.errors++; byDay[day].errors++; }
    const c = clickKind(e);
    if (c) { total.clicks++; byDay[day].clicks++; total[c]++; }
    if (e.t === 'compose' && /合成成功/.test(e.m)) { total.composed++; byDay[day].composed++; }
    if (e.u) total.users[e.u] = 1;
    const s = e.s || '';
    if (s) {
      if (!sess[s]) sess[s] = { record: 0, sub: 0, comp: 0, save: 0, day };
      if (e.t === 'record') sess[s].record = 1;
      if (e.t === 'subtitle') sess[s].sub = 1;
      if (e.t === 'compose' && /合成成功/.test(e.m)) sess[s].comp = 1;
      if (e.t === 'save' && /点保存到相册|生成链接|系统分享完成|预下载完成/.test(e.m)) sess[s].save = 1;
    }
  }
  for (const k in sess) { const x = sess[k]; if (x.record && x.sub && x.comp && x.save) { total.flows++; if (byDay[x.day]) byDay[x.day].flows++; } }
  const days = Object.keys(byDay).sort().slice(-7).reverse().map((d) => byDay[d]);
  const data = {
    ok: true, generatedAt: now,
    total: { clicks: total.clicks, subtitle: total.subtitle, compose: total.compose, save: total.save, link: total.link, flows: total.flows, composed: total.composed, errors: total.errors, plays: total.plays, users: Object.keys(total.users).length },
    days,
  };
  _statsCache = { t: now, data };
  return data;
}
function statsPageHtml() {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>使用统计</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f4f5f7;color:#222;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
header{background:#1f2430;color:#fff;padding:14px 20px;display:flex;justify-content:space-between;align-items:center}
header h1{font-size:17px;margin:0}
.cards{display:flex;gap:12px;padding:16px 20px 0;flex-wrap:wrap}
.card{background:#fff;border-radius:12px;padding:16px 18px;min-width:140px;flex:1;box-shadow:0 1px 3px rgba(0,0,0,.07)}
.card .n{font-size:30px;font-weight:800}
.card .lab{font-size:13px;color:#888;margin-top:4px}
.n.ok{color:#1a9e5c}.n.blue{color:#2e5bff}.n.orange{color:#e88b00}.n.err{color:#e5322d}
.sec{padding:8px 20px 30px}
h2{font-size:14px;color:#667;margin:18px 0 8px}
table{width:100%;border-collapse:collapse;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.06)}
th,td{padding:9px 12px;font-size:13px;border-bottom:1px solid #f0f0f0;text-align:center}
th{background:#fafbfc;color:#667;font-weight:600}
td:first-child,th:first-child{text-align:left}
#gate{max-width:360px;margin:80px auto;background:#fff;padding:24px;border-radius:12px;box-shadow:0 2px 10px rgba(0,0,0,.08);text-align:center}
#gate input{width:100%;padding:12px;font-size:16px;border:1px solid #ddd;border-radius:10px;margin:12px 0}
#gate button{width:100%;padding:12px;font-size:16px;font-weight:700;border:0;border-radius:10px;background:#1f2430;color:#fff}
.err-msg{color:#e5322d;font-size:13px;min-height:18px}
</style></head><body>
<div id="gate">
  <h2 style="margin-top:0">🔒 使用统计</h2>
  <div style="color:#888;font-size:13px">请输入访问口令</div>
  <input id="key" type="password" placeholder="口令" autocomplete="off">
  <button id="go">查看</button>
  <div class="err-msg" id="err"></div>
</div>
<div id="main" style="display:none">
  <header><h1>门店短视频 · 使用统计</h1><span id="clock" style="font-size:12px;color:#9aa3b2"></span></header>
  <div class="cards">
    <div class="card"><div class="n blue" id="c_clicks">0</div><div class="lab">总点击（关键操作）</div></div>
    <div class="card"><div class="n ok" id="c_flows">0</div><div class="lab">全流程完成</div></div>
    <div class="card"><div class="n orange" id="c_composed">0</div><div class="lab">已合成视频</div></div>
    <div class="card"><div class="n err" id="c_errors">0</div><div class="lab">报错</div></div>
  </div>
  <div class="cards">
    <div class="card"><div class="n" id="c_plays">0</div><div class="lab">打开次数</div></div>
    <div class="card"><div class="n" id="c_users">0</div><div class="lab">用户数</div></div>
    <div class="card"><div class="n" id="c_sub">0</div><div class="lab">生成字幕</div></div>
    <div class="card"><div class="n" id="c_comp">0</div><div class="lab">合成操作</div></div>
    <div class="card"><div class="n" id="c_save">0</div><div class="lab">保存操作</div></div>
  </div>
  <div class="sec">
    <h2>近 7 天</h2>
    <table><thead><tr><th>日期</th><th>点击</th><th>全流程完成</th><th>合成视频</th><th>报错</th></tr></thead><tbody id="days"></tbody></table>
    <div style="text-align:center;margin-top:16px"><span id="host" style="color:#aaa;font-size:12px"></span></div>
  </div>
</div>
<script>
var key=localStorage.getItem('statsKey')||'';
function esc(s){return String(s||'').replace(/[&<>]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c]})}
function load(){
  fetch('/api/stats?key='+encodeURIComponent(key)).then(function(r){
    if(r.status===401){localStorage.removeItem('statsKey');document.getElementById('gate').style.display='block';document.getElementById('main').style.display='none';document.getElementById('err').textContent='口令错误';return null;}
    return r.json();
  }).then(function(d){
    if(!d||!d.ok)return;
    localStorage.setItem('statsKey',key);
    document.getElementById('gate').style.display='none';document.getElementById('main').style.display='block';
    var t=d.total;
    document.getElementById('c_clicks').textContent=t.clicks;
    document.getElementById('c_flows').textContent=t.flows;
    document.getElementById('c_composed').textContent=t.composed;
    document.getElementById('c_errors').textContent=t.errors;
    document.getElementById('c_plays').textContent=t.plays;
    document.getElementById('c_users').textContent=t.users;
    document.getElementById('c_sub').textContent=t.subtitle;
    document.getElementById('c_comp').textContent=t.compose;
    document.getElementById('c_save').textContent=t.save;
    document.getElementById('clock').textContent='更新于 '+new Date(d.generatedAt).toLocaleTimeString('zh-CN',{hour12:false});
    var rows='';d.days.forEach(function(x){rows+='<tr><td>'+esc(x.day)+'</td><td>'+x.clicks+'</td><td>'+x.flows+'</td><td>'+x.composed+'</td><td'+(x.errors?' style="color:#e5322d;font-weight:700"':'')+'>'+x.errors+'</td></tr>';});
    document.getElementById('days').innerHTML=rows||'<tr><td colspan="5" style="color:#aaa">暂无数据</td></tr>';
    document.getElementById('host').textContent=location.host;
  }).catch(function(){document.getElementById('err').textContent='网络错误';});
}
document.getElementById('go').onclick=function(){key=document.getElementById('key').value.trim();load();};
document.getElementById('key').addEventListener('keydown',function(e){if(e.key==='Enter'){key=this.value.trim();load();}});
if(key)load();else document.getElementById('key').focus();
setInterval(function(){if(document.getElementById('main').style.display!=='none')load();},30000);
</script>
</body></html>`;
}

function adminPageHtml() {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>工具运行监控台</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f4f5f7;color:#222;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
header{background:#1f2430;color:#fff;padding:14px 20px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px}
header h1{font-size:18px;margin:0}
.meta{font-size:12px;color:#9aa3b2}
.cards{display:flex;gap:12px;padding:16px 20px 0;flex-wrap:wrap}
.card{background:#fff;border-radius:10px;padding:14px 18px;min-width:130px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
.card .n{font-size:26px;font-weight:800}
.card .n.err{color:#e5322d}.card .n.warn{color:#e88b00}.card .n.ok{color:#1a9e5c}
.card .lab{font-size:12px;color:#888;margin-top:2px}
.bar{display:flex;gap:10px;padding:12px 20px;align-items:center;flex-wrap:wrap}
.bar select,.bar button{padding:7px 12px;border:1px solid #ddd;border-radius:8px;font-size:13px;background:#fff}
.bar button.on{background:#1f2430;color:#fff;border-color:#1f2430}
#list{padding:0 20px 30px}
table{width:100%;border-collapse:collapse;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.06)}
th,td{text-align:left;padding:9px 12px;font-size:12.5px;border-bottom:1px solid #f0f0f0;vertical-align:top}
th{background:#fafbfc;color:#667;font-weight:600;position:sticky;top:0}
tr.err td{background:#fff5f5}
.tag{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600}
.tag.info{background:#e8f0ff;color:#2e5bff}.tag.warn{background:#fff3e0;color:#e88b00}.tag.error{background:#ffe5e5;color:#e5322d}
.tag.event{background:#eef2f6;color:#556}.tag.usage{background:#e6f7ef;color:#1a9e5c}
.mono{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:#888;word-break:break-all}
.u{font-weight:700}
</style></head><body>
<header><h1>门店短视频 · 运行监控台</h1><span class="meta" id="clock">—</span></header>
<div class="cards">
 <div class="card"><div class="n ok" id="st_total">0</div><div class="lab">今日事件</div></div>
 <div class="card"><div class="n" id="st_users">0</div><div class="lab">今日活跃用户</div></div>
 <div class="card"><div class="n warn" id="st_warn">0</div><div class="lab">今日告警</div></div>
 <div class="card"><div class="n err" id="st_err">0</div><div class="lab">今日错误</div></div>
</div>
<div class="bar">
 <select id="f_user"><option value="">全部用户</option></select>
 <select id="f_type"><option value="">全部类型</option></select>
 <select id="f_level"><option value="">全部级别</option><option value="info">info</option><option value="warn">warn</option><option value="error">error</option></select>
 <button id="btn_pause">⏸ 暂停刷新</button>
 <button onclick="location.reload()">刷新</button>
 <span class="meta" id="status">连接中…</span>
</div>
<div id="list"><table><thead><tr><th>时间</th><th>用户</th><th>类型</th><th>级别</th><th>内容</th><th>设备/会话</th></tr></thead><tbody id="tbody"></tbody></table></div>
<script>
var lastSeq=0, paused=false, types={};
function ts(t){var d=new Date(t);function p(n){return (n<10?'0':'')+n}return p(d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds());}
function esc(s){return String(s||'').replace(/[&<>]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c]})}
function render(stats,users,logs){
 if(stats){document.getElementById('st_total').textContent=stats.totalToday;document.getElementById('st_users').textContent=stats.usersToday;document.getElementById('st_warn').textContent=stats.warns;document.getElementById('st_err').textContent=stats.errors;}
 var su=document.getElementById('f_user'); var cur=su.value;
 var opts='<option value="">全部用户</option>'; users.forEach(function(u){opts+='<option'+(u===cur?' selected':'')+'>'+esc(u)+'</option>'}); su.innerHTML=opts;
 var tb=document.getElementById('tbody'); var rows='';
 logs.forEach(function(l){
   var typ=l.t||'event'; if(!types[typ]){types[typ]=1; var so=document.getElementById('f_type'); var o=document.createElement('option'); o.value=typ; o.textContent=typ; so.appendChild(o);}
   rows+='<tr class="'+(l.l==='error'?'err':'')+'"><td class="mono">'+ts(l.ts)+'</td><td class="u">'+esc(l.u)+'</td><td><span class="tag '+esc(l.t||'event')+'">'+esc(l.t||'event')+'</span></td><td><span class="tag '+(l.l==='error'?'error':l.l==='warn'?'warn':(l.t==='usage'?'usage':'info'))+'">'+esc(l.l||'info')+'</span></td><td>'+esc(l.m)+'</td><td class="mono">'+esc(l.d||'')+'<br><span style="color:#bbb">'+esc(l.s||'')+'</span></td></tr>';
 });
 tb.innerHTML=rows;
}
function fetchLogs(since){
 var qs='since='+since+'&limit=300';
 var u=document.getElementById('f_user').value; if(u)qs+='&user='+encodeURIComponent(u);
 var t=document.getElementById('f_type').value; if(t)qs+='&type='+encodeURIComponent(t);
 var lv=document.getElementById('f_level').value; if(lv)qs+='&level='+encodeURIComponent(lv);
 fetch('/api/logs?'+qs).then(function(r){return r.json()}).then(function(d){
   if(!d.ok){return;}
   if(since===0||!paused){ if(d.logs.length)lastSeq=d.nowSeq; }
   else{ if(d.logs.length)lastSeq=Math.max(lastSeq,d.logs[0].seq-1); }
   render(d.stats,d.users,d.logs);
   document.getElementById('status').textContent='已更新 '+ts(d.serverTime)+'（共 '+d.stats.totalToday+' 事件）';
 }).catch(function(){document.getElementById('status').textContent='连接失败，重试中…'});
}
function poll(){ if(paused){setTimeout(poll,1500);return;} fetchLogs(lastSeq); setTimeout(poll,4000); }
document.getElementById('f_user').onchange=function(){lastSeq=0;fetchLogs(0)};
document.getElementById('f_type').onchange=function(){lastSeq=0;fetchLogs(0)};
document.getElementById('f_level').onchange=function(){lastSeq=0;fetchLogs(0)};
document.getElementById('btn_pause').onclick=function(){paused=!paused;this.textContent=paused?'▶ 继续刷新':'⏸ 暂停刷新';this.classList.toggle('on',paused)};
setInterval(function(){document.getElementById('clock').textContent=ts(Date.now())},1000);
fetchLogs(0); poll();
</script></body></html>`;
}

/* ---------- 路由 ---------- */
function handleRequest(req, res) {
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
  if (req.method === 'POST' && pathname === '/api/asr') {
    handleAsr(req, res);
    return;
  }
  if (req.method === 'POST' && pathname === '/api/log') {
    handleLog(req, res);
    return;
  }
  if (req.method === 'GET' && pathname === '/api/logs') {
    handleGetLogs(req, res);
    return;
  }
  if (req.method === 'GET' && pathname === '/api/stats') {
    if (String(query.get('key') || '') !== config.statsKey) { sendJson(res, 401, { ok: false, error: '口令错误' }); return; }
    sendJson(res, 200, computeStats());
    return;
  }
  if (req.method === 'GET' && pathname === '/stats') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(statsPageHtml());
    return;
  }
  if (req.method === 'GET' && pathname === '/admin') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(adminPageHtml());
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
}

const server = http.createServer(handleRequest);
server.listen(config.port, () => {
  console.log('video-workbench-server 已启动：http://localhost:' + config.port);
  console.log('视频存储目录：' + videoDir);
  console.log('对外地址：' + (config.baseUrl || '按请求 Host 动态推导'));
  console.log('企业微信应用已配置：' + (config.corpId && config.corpSecret ? '是' : '否（待填 WX_* ）'));
  console.log('前端页面：' + (FRONTEND_FILE || '未找到（仅提供 API）'));
});

/* ---------- HTTPS（证书存在时自动启用 443） ---------- */
const CERT_DIR = process.env.CERT_DIR || path.join(__dirname, 'cert');
const CERT_FILE = path.join(CERT_DIR, 'certificate.crt');
const KEY_FILE = path.join(CERT_DIR, 'private.key');
const CA_FILE = path.join(CERT_DIR, 'ca_bundle.crt');
const HTTPS_PORT = parseInt(process.env.HTTPS_PORT || '443', 10);
if (fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE)) {
  const tlsOpts = { key: fs.readFileSync(KEY_FILE), cert: fs.readFileSync(CERT_FILE) };
  if (fs.existsSync(CA_FILE)) tlsOpts.ca = fs.readFileSync(CA_FILE);
  const httpsServer = https.createServer(tlsOpts, handleRequest);
  httpsServer.listen(HTTPS_PORT, () => {
    console.log('HTTPS 已启动：端口 ' + HTTPS_PORT);
  });
} else {
  console.log('未找到证书文件（cert/certificate.crt + private.key），仅 HTTP');
}
