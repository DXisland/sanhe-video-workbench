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
  /* 音频：高通滤掉低频噪声 + FFT 降噪 + 动态归一化；人声为主，BGM 压低。
     注意 amix 必须 normalize=0，否则会把两路音量各除以 2，人声会被明显压小。 */
  fc.push('[' + mainAudio + ']highpass=f=95,afftdn=nr=8:nf=-35,dynaudnorm=p=0.9,volume=1.25[a0]');
  if (bgmPath) {
    const aIdx = 1 + insFiles.length;
    fc.push('[' + aIdx + ':a]volume=0.08[a1]');
    fc.push('[a0][a1]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95[aout]');
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
function devKind(ua) {
  ua = String(ua || '');
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  if (/Macintosh|Windows|Linux/i.test(ua)) return 'desktop';
  return 'other';
}
function blankDay(day) {
  return { day, plays: 0, users: [], records: 0, subtitle: 0, compose: 0, composed: 0, saved: 0, saveTries: 0, clicks: 0, errors: 0, dev: { ios: 0, android: 0, desktop: 0, other: 0 }, f: { open: 0, record: 0, compose: 0, save: 0 } };
}
function computeStats() {
  const now = Date.now();
  if (_statsCache.data && now - _statsCache.t < 60000) return _statsCache.data;
  const entries = readAllLogEntries();
  const total = { clicks: 0, plays: 0, users: 0, records: 0, subtitle: 0, compose: 0, composed: 0, saved: 0, saveTries: 0, link: 0, errors: 0, flows: 0 };
  const daysMap = {};
  const usersAll = new Set();
  const sessions = {};
  const durations = [];
  const errorTop = {};
  const devices = { ios: 0, android: 0, desktop: 0, other: 0 };

  for (const e of entries) {
    const ts = Number(e.ts);
    if (!ts) continue;
    const day = dayKeyOf(ts);
    if (!daysMap[day]) daysMap[day] = blankDay(day);
    const D = daysMap[day];
    const t = e.t || '';
    const m = e.m || '';
    if (e.u) {
      usersAll.add(e.u);
      if (D.users.indexOf(e.u) < 0) D.users.push(e.u);
    }
    if (t === 'usage' && /页面打开/.test(m)) {
      total.plays++; D.plays++;
      const k = devKind(e.d); D.dev[k]++; devices[k]++;
    }
    if (t === 'record' && /开始录制/.test(m)) { total.records++; D.records++; }
    if (t === 'subtitle' && /开始生成字幕/.test(m)) { total.subtitle++; D.subtitle++; }
    if (t === 'compose' && /开始云端合成/.test(m)) { total.compose++; D.compose++; }
    if (t === 'compose' && /合成成功/.test(m)) { total.composed++; D.composed++; }
    if (t === 'save' && /生成链接/.test(m)) total.link++;
    if (e.l === 'error') {
      total.errors++; D.errors++;
      const k = String(m).slice(0, 90);
      errorTop[k] = (errorTop[k] || 0) + 1;
    }
    const c = clickKind(e);
    if (c) { total.clicks++; D.clicks++; }

    const s = e.s || '';
    if (!s) continue;
    if (!sessions[s]) sessions[s] = { day, open: false, record: false, sub: false, compose: false, saved: false, tried: false, first: ts, composeTs: 0 };
    const S = sessions[s];
    if (ts < S.first) { S.first = ts; S.day = day; }
    if (t === 'usage' && /页面打开/.test(m)) S.open = true;
    if (t === 'record') S.record = true;
    if (t === 'subtitle') S.sub = true;
    if (t === 'compose' && /合成成功/.test(m)) { S.compose = true; if (!S.composeTs) S.composeTs = ts; }
    if (t === 'save' && /系统分享完成|预下载完成|保存\/下载文件/.test(m)) S.saved = true;
    if (t === 'save' && /点保存到相册|开始预下载|保存\/下载文件|系统分享|iframe内打开保存页/.test(m)) S.tried = true;
  }

  const funnel = { open: 0, record: 0, compose: 0, save: 0 };
  for (const s in sessions) {
    const S = sessions[s];
    const D = daysMap[S.day];
    if (!D) continue;
    if (S.open) { D.f.open++; funnel.open++; }
    if (S.record) { D.f.record++; funnel.record++; }
    if (S.compose) { D.f.compose++; funnel.compose++; }
    if (S.saved) { D.saved++; D.f.save++; funnel.save++; total.saved++; }
    if (S.tried) { D.saveTries++; total.saveTries++; }
    if (S.open && S.record && S.compose && S.saved) total.flows++;
    if (S.open && S.composeTs) {
      const mins = (S.composeTs - S.first) / 60000;
      if (mins >= 0 && mins < 120) durations.push([S.day, Math.round(mins * 10) / 10]);
    }
  }
  total.users = usersAll.size;

  const days = Object.keys(daysMap).sort().map((d) => {
    const D = daysMap[d];
    return Object.assign({}, D, { users: D.users.length, uids: D.users });
  });
  const errors = Object.keys(errorTop).map((m) => ({ m, n: errorTop[m] })).sort((a, b) => b.n - a.n).slice(0, 5);
  const todayDay = dayKeyOf(now);
  const tD = daysMap[todayDay];
  const data = {
    ok: true, generatedAt: now, todayDay, total, days, durations, funnel, devices,
    errorTop: errors,
    today: tD ? { plays: tD.plays, users: tD.users.length, composed: tD.composed, saved: tD.saved } : { plays: 0, users: 0, composed: 0, saved: 0 },
  };
  _statsCache = { t: now, data };
  return data;
}
function statsPageHtml() {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>AI 门店短视频创作平台 · 运营成果看板</title>
<style>
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
:root{--bg:#f5f7fb;--card:#fff;--ink:#0f172a;--sub:#64748b;--line:#e8edf5;--brand:#3b5bfd;--violet:#7c3aed;--green:#0ea472;--amber:#f59e0b;--red:#ef4444;--r:18px}
html,body{margin:0}
body{background:radial-gradient(1200px 620px at 10% -12%,#e9efff 0%,rgba(233,239,255,0) 60%),radial-gradient(900px 520px at 100% 0%,#e7f8f1 0%,rgba(231,248,241,0) 55%),var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei","Segoe UI",sans-serif;min-height:100vh}
.app{max-width:1440px;margin:0 auto;padding:26px 30px 40px}
.top{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:26px}
.brand{display:flex;align-items:center;gap:14px;min-width:0}
.logo{width:46px;height:46px;border-radius:14px;background:linear-gradient(135deg,#3b5bfd,#7c3aed);display:grid;place-items:center;box-shadow:0 8px 20px rgba(59,91,253,.28);flex:none}
.logo svg{width:22px;height:22px}
.brand h1{font-size:20px;margin:0;letter-spacing:.2px;line-height:1.25}
.brand p{margin:3px 0 0;font-size:12.5px;color:var(--sub);letter-spacing:.4px}
.top-right{display:flex;align-items:center;gap:9px;flex-wrap:wrap;justify-content:flex-end}
.live{display:inline-flex;align-items:center;gap:7px;background:#fff;border:1px solid var(--line);border-radius:999px;padding:7px 12px;font-size:12px;color:#334155;box-shadow:0 1px 2px rgba(15,23,42,.04);white-space:nowrap}
.live i{width:7px;height:7px;border-radius:50%;background:var(--green);box-shadow:0 0 0 4px rgba(14,164,114,.12);animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
.icon-btn{width:36px;height:36px;border-radius:11px;border:1px solid var(--line);background:#fff;color:#475569;display:grid;place-items:center;cursor:pointer;transition:.18s;padding:0}
.icon-btn:hover{color:var(--brand);border-color:#c9d5ff;background:#f7f9ff}
.icon-btn svg{width:17px;height:17px}
.icon-btn.spin svg{animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.muted{font-size:12px;color:#94a3b8;white-space:nowrap}
.hero-head{display:flex;justify-content:space-between;align-items:flex-end;gap:12px;margin-bottom:14px;flex-wrap:wrap}
.hero-head h2{font-size:16px;margin:0}
.hero-head p{margin:4px 0 0;font-size:12.5px;color:var(--sub)}
.tabs{display:flex;background:#eef2f9;border-radius:12px;padding:4px;gap:2px}
.tabs button{border:0;background:transparent;padding:8px 14px;border-radius:9px;font-size:12.5px;color:#64748b;cursor:pointer;font-weight:600;transition:.18s;white-space:nowrap;font-family:inherit}
.tabs button.on{background:#fff;color:var(--brand);box-shadow:0 2px 8px rgba(15,23,42,.08)}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}
.kpi{position:relative;background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:18px 18px 14px;overflow:hidden;box-shadow:0 1px 2px rgba(15,23,42,.03);transition:transform .2s,box-shadow .2s}
.kpi:hover{transform:translateY(-2px);box-shadow:0 10px 26px rgba(15,23,42,.07)}
.k-top{display:flex;align-items:center;gap:9px}
.k-icon{width:32px;height:32px;border-radius:10px;display:grid;place-items:center;flex:none}
.k-icon svg{width:16px;height:16px}
.blue{background:#eef2ff;color:#3b5bfd}.violet{background:#f3e8ff;color:#7c3aed}.green{background:#e7f8f1;color:#0ea472}.amber{background:#fff4e0;color:#d97706}
.k-label{font-size:12.5px;color:var(--sub);font-weight:600}
.k-num{font-size:36px;font-weight:800;letter-spacing:-1px;margin:10px 0 2px;line-height:1;font-variant-numeric:tabular-nums}
.k-sub{font-size:12px;color:#94a3b8;min-height:16px}
.k-sub b{color:#475569}
.spark{position:absolute;right:14px;bottom:12px;width:88px;height:30px;opacity:.9;pointer-events:none}
.minis{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-top:14px}
.mini{display:flex;align-items:center;gap:10px;background:rgba(255,255,255,.72);border:1px solid var(--line);border-radius:14px;padding:11px 14px;min-width:0}
.mini b{font-size:17px;font-variant-numeric:tabular-nums;white-space:nowrap}
.mini span{font-size:12px;color:var(--sub);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mini .dot{width:6px;height:6px;border-radius:50%;background:var(--brand);opacity:.6;flex:none}
.mini .dot.g{background:var(--green)}.mini .dot.a{background:var(--amber)}.mini .dot.v{background:var(--violet)}
.grid{display:grid;grid-template-columns:1.65fr 1fr;gap:14px;margin-top:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:18px 20px;box-shadow:0 1px 2px rgba(15,23,42,.03);min-width:0}
.card-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:8px}
.card-head h3{margin:0;font-size:15px}
.card-head p{margin:4px 0 0;font-size:12px;color:var(--sub)}
.chips{display:flex;gap:6px;background:#f1f5f9;padding:3px;border-radius:10px;flex:none}
.chips button{border:0;background:transparent;padding:6px 10px;border-radius:8px;font-size:12px;color:#64748b;cursor:pointer;font-weight:600;font-family:inherit}
.chips button.on{background:#fff;color:var(--brand);box-shadow:0 1px 4px rgba(15,23,42,.08)}
.chart{position:relative;width:100%;height:300px}
.chart svg{display:block;width:100%;height:100%;overflow:visible;animation:fade .35s ease}
@keyframes fade{from{opacity:.2}to{opacity:1}}
.chart .gridline{stroke:#eef2f8;stroke-width:1}
.chart .axis{fill:#94a3b8;font-size:11px}
.chart .line{fill:none;stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round}
.chart .dot{fill:#fff;stroke-width:2.5}
.chart .hit{fill:transparent;cursor:pointer}
.chart .vline{stroke:#cbd5e1;stroke-width:1;stroke-dasharray:3 4}
.chart-tip{position:absolute;pointer-events:none;background:#0f172a;color:#fff;border-radius:10px;padding:9px 11px;font-size:12px;line-height:1.55;transform:translate(-50%,-100%);opacity:0;transition:opacity .12s;white-space:nowrap;z-index:5;box-shadow:0 8px 20px rgba(15,23,42,.22)}
.chart-tip b{font-size:13.5px}
.chart-tip:after{content:'';position:absolute;left:50%;bottom:-5px;width:10px;height:10px;background:#0f172a;transform:translateX(-50%) rotate(45deg);border-radius:2px}
.chart-foot{display:flex;justify-content:space-between;gap:10px;align-items:center;margin-top:6px;font-size:12px;color:var(--sub);flex-wrap:wrap}
.legend{display:flex;gap:12px;flex-wrap:wrap}
.legend span{display:inline-flex;align-items:center;gap:5px}
.legend i{display:inline-block;width:8px;height:8px;border-radius:2px}
.funnel{display:flex;flex-direction:column;padding-top:6px}
.fstage{padding:6px 0}
.fmeta{display:flex;align-items:baseline;justify-content:space-between;font-size:12.5px;margin-bottom:6px}
.fmeta span{color:#475569;font-weight:600}
.fmeta b{font-size:16px;font-variant-numeric:tabular-nums}
.fmeta em{font-style:normal;font-size:11.5px;color:#94a3b8;margin-left:6px}
.ftrack{height:14px;background:#f1f5f9;border-radius:7px;overflow:hidden}
.fbar{height:100%;border-radius:7px;background:linear-gradient(90deg,#3b5bfd,#6d8bff);width:0;transition:width .7s cubic-bezier(.22,1,.36,1)}
.fstage:nth-of-type(2) .fbar{background:linear-gradient(90deg,#5b6ffd,#8a7bff)}
.fstage:nth-of-type(3) .fbar{background:linear-gradient(90deg,#6d6bfb,#a78bfa)}
.fstage:nth-of-type(4) .fbar{background:linear-gradient(90deg,#0ea472,#34d399)}
.fconv{display:flex;align-items:center;gap:5px;color:#94a3b8;font-size:11.5px;padding:2px 0 2px 2px}
.fconv svg{width:12px;height:12px;opacity:.55;flex:none}
.fsum{margin-top:10px;padding-top:12px;border-top:1px dashed var(--line);display:flex;justify-content:space-between;gap:10px;font-size:12px;color:var(--sub);flex-wrap:wrap}
.fsum b{color:var(--ink);font-size:15px}
.grid2{display:grid;grid-template-columns:1.65fr 1fr;gap:14px;margin-top:14px}
.grid2 .card{display:flex;flex-direction:column}
.grid2 .card>.donut-wrap{flex:1;justify-content:center}
.table-wrap{overflow:auto;margin:0 -4px;border-radius:12px}
table{width:100%;border-collapse:collapse;font-size:12.5px;min-width:580px}
th,td{padding:10px 12px;border-bottom:1px solid #f1f4f9;text-align:right;white-space:nowrap}
th{position:sticky;top:0;background:#fbfcfe;color:#64748b;font-weight:600;font-size:11.5px;z-index:1}
th:first-child,td:first-child{text-align:left}
tbody tr{cursor:pointer;transition:background .15s}
tbody tr:hover{background:#f8faff}
tbody tr.active{background:#eef3ff}
td .rate{font-weight:700;color:var(--green)}
td .rate.mid{color:#d97706}
td .rate.low{color:#94a3b8}
td .zero{color:#cbd5e1}
.wk{color:#a0aec0;font-size:11px;margin-left:5px}
.ghost-btn{border:1px solid var(--line);background:#fff;border-radius:9px;padding:7px 11px;font-size:12px;color:#475569;cursor:pointer;font-weight:600;display:inline-flex;align-items:center;gap:6px;font-family:inherit;flex:none}
.ghost-btn:hover{border-color:#c9d5ff;color:var(--brand)}
.ghost-btn svg{width:14px;height:14px}
.donut-wrap{display:flex;flex-direction:column;align-items:center;padding-top:4px}
.donut{position:relative;width:190px;height:190px}
.donut svg{transform:rotate(-90deg);width:100%;height:100%}
.donut circle{fill:none;stroke-width:16;transition:stroke-width .18s,opacity .18s;cursor:pointer}
.donut circle:hover{stroke-width:20}
.donut-center{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;pointer-events:none}
.donut-center b{font-size:28px;letter-spacing:-1px;font-variant-numeric:tabular-nums;line-height:1}
.donut-center span{font-size:11.5px;color:var(--sub);margin-top:4px}
.legend-list{width:100%;margin-top:10px;display:flex;flex-direction:column;gap:8px}
.legend-row{display:flex;align-items:center;gap:8px;font-size:12.5px}
.legend-row i{width:9px;height:9px;border-radius:3px;flex:none}
.legend-row span{color:var(--sub)}
.legend-row b{margin-left:auto;font-variant-numeric:tabular-nums}
.legend-row em{font-style:normal;color:#94a3b8;font-size:11.5px;width:42px;text-align:right}
.quality{margin-top:14px;background:rgba(255,255,255,.62);border:1px solid var(--line);border-radius:14px;padding:12px 16px;font-size:12px;color:var(--sub)}
.quality summary{cursor:pointer;font-weight:600;color:#64748b;outline:none;display:flex;align-items:center;gap:8px}
.quality summary::-webkit-details-marker{display:none}
.qbadge{background:#f1f5f9;color:#64748b;border-radius:999px;padding:2px 8px;font-size:11px;font-weight:700}
.qbody{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:12px}
.qbox{background:#fff;border:1px solid var(--line);border-radius:10px;padding:10px 12px;min-width:0}
.qbox b{display:block;font-size:18px;color:var(--ink);margin-bottom:3px;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.qbox span{font-size:11.5px;color:#94a3b8}
footer{margin-top:22px;display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;font-size:11.5px;color:#a0aec0}
.gate{min-height:100vh;display:grid;place-items:center;padding:24px}
.gate-card{width:100%;max-width:380px;background:#fff;border:1px solid var(--line);border-radius:22px;padding:30px;box-shadow:0 24px 60px rgba(15,23,42,.12);text-align:center}
.gate .logo{margin:0 auto 16px}
.gate h1{font-size:18px;margin:0 0 4px}
.gate p{font-size:12.5px;color:var(--sub);margin:0 0 20px}
.gate input{width:100%;padding:13px 14px;font-size:15px;border:1px solid #dbe3ef;border-radius:12px;outline:none;transition:.18s;background:#fbfcfe;font-family:inherit}
.gate input:focus{border-color:#b9c8ff;box-shadow:0 0 0 4px rgba(59,91,253,.09);background:#fff}
.gate button{width:100%;margin-top:12px;padding:13px;border:0;border-radius:12px;background:linear-gradient(135deg,#3b5bfd,#6d5bfd);color:#fff;font-size:15px;font-weight:700;cursor:pointer;box-shadow:0 8px 18px rgba(59,91,253,.28);transition:.18s;font-family:inherit}
.gate button:hover{transform:translateY(-1px);box-shadow:0 12px 24px rgba(59,91,253,.32)}
.gate button:disabled{opacity:.6;cursor:default;transform:none}
.gate .err{min-height:18px;color:var(--red);font-size:12px;margin-top:10px}
.shake{animation:shake .35s}
@keyframes shake{25%{transform:translateX(-6px)}75%{transform:translateX(6px)}}
.toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%) translateY(20px);background:#0f172a;color:#fff;padding:10px 16px;border-radius:999px;font-size:12.5px;opacity:0;pointer-events:none;transition:.25s;z-index:20;box-shadow:0 10px 30px rgba(15,23,42,.25)}
.toast.on{opacity:1;transform:translateX(-50%) translateY(0)}
.hidden{display:none!important}
@media(max-width:1080px){.kpis{grid-template-columns:repeat(2,1fr)}.minis{grid-template-columns:repeat(2,1fr)}.grid,.grid2{grid-template-columns:1fr}.chart{height:260px}}
@media(max-width:640px){.app{padding:18px 14px 30px}.brand{flex:1;min-width:0}.brand h1{font-size:16px;white-space:nowrap}.brand p{font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.en{display:none}.live,#print{display:none}.logo{width:40px;height:40px;border-radius:12px}.top{align-items:center}.top-right{gap:6px;flex:none}.muted{display:none}.kpi{padding:14px}.k-num{font-size:30px}.k-sub{font-size:11px}.spark{width:60px;opacity:.6}.card{padding:16px}.chart{height:230px}.donut{width:170px;height:170px}.qbody{grid-template-columns:1fr}.tabs button{padding:7px 10px}.hero-head h2{font-size:15px}.chart-foot{font-size:11px}.table-wrap{overflow:visible}table{min-width:0;font-size:12px}th,td{padding:9px 5px}th:nth-child(3),td:nth-child(3),th:nth-child(4),td:nth-child(4){display:none}.mini{padding:10px 11px;gap:7px}.mini span{font-size:11.5px}}
@media(min-width:1600px){.app{max-width:1620px;padding:34px 44px 48px}.brand h1{font-size:22px}.k-num{font-size:42px}.chart{height:340px}.kpi{padding:22px 22px 16px}}
@media print{body{background:#fff}.app{max-width:none;padding:0}.icon-btn,.tabs,.chips,.ghost-btn,.quality,footer{display:none!important}.card,.kpi{box-shadow:none;break-inside:avoid}.grid,.grid2{grid-template-columns:1fr 1fr}.chart{height:260px}}
</style></head><body>

<div id="gate" class="gate">
  <div class="gate-card" id="gateCard">
    <div class="logo"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 5.5v13l11-6.5z" fill="#fff" stroke="none"/></svg></div>
    <h1>AI 门店短视频创作平台</h1>
    <p>运营成果看板 · 请输入访问口令</p>
    <form id="gateForm">
      <input id="key" type="password" placeholder="访问口令" autocomplete="current-password">
      <button type="button" id="go">进入看板</button>
    </form>
    <div class="err" id="err"></div>
  </div>
</div>

<div id="main" class="app hidden">
  <header class="top">
    <div class="brand">
      <div class="logo"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 5.5v13l11-6.5z" fill="#fff" stroke="none"/></svg></div>
      <div><h1>AI 门店短视频创作平台</h1><p>运营成果看板 <span class="en">· OPERATIONS OVERVIEW</span></p></div>
    </div>
    <div class="top-right">
      <span class="live"><i></i>数据实时</span>
      <span class="muted" id="updated">—</span>
      <button class="icon-btn" id="refresh" title="刷新数据" aria-label="刷新数据"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg></button>
      <button class="icon-btn" id="print" title="打印/导出 PDF" aria-label="打印"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9V3h12v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M6 17h12v4H6z"/></svg></button>
      <button class="icon-btn" id="full" title="全屏展示" aria-label="全屏"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/></svg></button>
    </div>
  </header>

  <section>
    <div class="hero-head">
      <div><h2>数据总览</h2><p id="rangeText">加载中…</p></div>
      <div class="tabs" id="rangeTabs">
        <button data-r="7">近 7 天</button>
        <button data-r="14">近 14 天</button>
        <button data-r="all" class="on">全部</button>
      </div>
    </div>
    <div class="kpis">
      <div class="kpi">
        <div class="k-top"><span class="k-icon blue"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg></span><span class="k-label">访问次数</span></div>
        <div class="k-num" id="k_plays">0</div>
        <div class="k-sub" id="k_plays_sub"></div>
        <div class="spark" id="sp_plays"></div>
      </div>
      <div class="kpi">
        <div class="k-top"><span class="k-icon violet"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg></span><span class="k-label">使用用户</span></div>
        <div class="k-num" id="k_users">0</div>
        <div class="k-sub" id="k_users_sub"></div>
        <div class="spark" id="sp_users"></div>
      </div>
      <div class="kpi">
        <div class="k-top"><span class="k-icon green"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="4" width="19" height="16" rx="3"/><path d="M7 4v16M17 4v16M2.5 9h4.5M2.5 15h4.5M17 9h4.5M17 15h4.5"/></svg></span><span class="k-label">生成成片</span></div>
        <div class="k-num" id="k_composed">0</div>
        <div class="k-sub" id="k_composed_sub"></div>
        <div class="spark" id="sp_composed"></div>
      </div>
      <div class="kpi">
        <div class="k-top"><span class="k-icon amber"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 21h16"/></svg></span><span class="k-label">保存成片</span></div>
        <div class="k-num" id="k_saved">0</div>
        <div class="k-sub" id="k_saved_sub"></div>
        <div class="spark" id="sp_saved"></div>
      </div>
    </div>
    <div class="minis">
      <div class="mini"><i class="dot"></i><b id="m_records">0</b><span>开始录制</span></div>
      <div class="mini"><i class="dot v"></i><b id="m_subtitle">0</b><span>字幕生成</span></div>
      <div class="mini"><i class="dot g"></i><b id="m_duration">—</b><span>平均出片</span></div>
      <div class="mini"><i class="dot a"></i><b id="m_days">0</b><span>活跃天数</span></div>
    </div>
  </section>

  <section class="grid">
    <div class="card">
      <div class="card-head">
        <div><h3>使用趋势</h3><p id="trendSub">—</p></div>
        <div class="chips" id="metricChips">
          <button data-m="plays" class="on">访问</button>
          <button data-m="composed">成片</button>
          <button data-m="saved">保存</button>
        </div>
      </div>
      <div class="chart" id="chart"></div>
      <div class="chart-foot">
        <span id="peak">—</span>
        <span class="legend" id="chartLegend"></span>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><div><h3>创作转化</h3><p>关键环节转化 · 打开页面到保存成片</p></div></div>
      <div class="funnel" id="funnel"></div>
    </div>
  </section>

  <section class="grid2">
    <div class="card">
      <div class="card-head">
        <div><h3>每日明细</h3><p>点击某一行，可在趋势图中定位当天</p></div>
        <button class="ghost-btn" id="csv"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 21h16"/></svg>导出 CSV</button>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>日期</th><th>访问</th><th>用户</th><th>录制</th><th>成片</th><th>保存</th><th>保存率</th></tr></thead>
          <tbody id="days"></tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><div><h3>访问设备</h3><p id="devSub">按访问次数统计</p></div></div>
      <div class="donut-wrap">
        <div class="donut" id="donut"></div>
        <div class="legend-list" id="donutLegend"></div>
      </div>
    </div>
  </section>

  <details class="quality" id="quality">
    <summary>运行质量摘要 <span class="qbadge" id="qBadge">—</span></summary>
    <div class="qbody">
      <div class="qbox"><b id="qRate">—</b><span>云端合成成功率</span></div>
      <div class="qbox"><b id="qErr">—</b><span>异常记录（多为设备能力提示）</span></div>
      <div class="qbox"><b id="qTop">—</b><span id="qTopLabel">主要提示</span></div>
    </div>
  </details>

  <footer>
    <span>数据为匿名埋点统计，不含个人信息 · 每 30 秒自动刷新</span>
    <span id="host"></span>
  </footer>
</div>

<div class="toast" id="toast"></div>

<script>
(function(){
  var key='';
  try{key=localStorage.getItem('statsKey')||'';}catch(e){}
  var S={data:null,range:'all',metric:'plays',selected:-1,series:[],timer:0,first:true,busy:false};
  var COLORS={plays:'#3b5bfd',composed:'#0ea472',saved:'#f59e0b'};
  var LABELS={plays:'访问',composed:'成片',saved:'保存'};
  var DEV={ios:{label:'iOS',color:'#3b5bfd'},android:{label:'Android',color:'#0ea472'},desktop:{label:'桌面浏览器',color:'#f59e0b'},other:{label:'其他',color:'#94a3b8'}};
  function $(id){return document.getElementById(id);}
  function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
  function fmt(n){return Number(n||0).toLocaleString('zh-CN');}
  function pct(a,b){return b>0?Math.round(a/b*1000)/10:0;}
  function pad(n){return n<10?'0'+n:''+n;}
  function dayAdd(day,n){
    var p=String(day).split('-');
    var d=new Date(+p[0],+p[1]-1,+p[2]);d.setDate(d.getDate()+n);
    return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());
  }
  function weekday(day){
    var p=String(day).split('-');
    var d=new Date(+p[0],+p[1]-1,+p[2]);
    return '周'+'日一二三四五六'.charAt(d.getDay());
  }
  function shortDay(day){return String(day).slice(5);}
  function toast(msg){
    var t=$('toast');t.textContent=msg;t.className='toast on';
    clearTimeout(t._t);t._t=setTimeout(function(){t.className='toast';},1800);
  }
  function animateNum(el,to){
    var from=parseInt(String(el.textContent).replace(/[^0-9]/g,''),10)||0;
    if(from===to){el.textContent=fmt(to);return;}
    var t0=performance.now();
    function step(t){
      var k=Math.min(1,(t-t0)/650),e=1-Math.pow(1-k,3);
      el.textContent=fmt(Math.round(from+(to-from)*e));
      if(k<1)requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }
  function blank(day){
    return {day:day,plays:0,users:0,records:0,subtitle:0,compose:0,composed:0,saved:0,saveTries:0,clicks:0,errors:0,dev:{ios:0,android:0,desktop:0,other:0},f:{open:0,record:0,compose:0,save:0},uids:[]};
  }
  function buildSeries(){
    var d=S.data;if(!d)return;
    var by={};(d.days||[]).forEach(function(x){by[x.day]=x;});
    var end=d.todayDay||(d.days.length?d.days[d.days.length-1].day:dayAdd(new Date().toISOString().slice(0,10),0));
    var start;
    if(S.range==='all'){
      start=d.days.length?d.days[0].day:end;
    }else{
      start=dayAdd(end,-(parseInt(S.range,10)-1));
    }
    var arr=[],cur=start,guard=0;
    while(cur<=end&&guard<400){arr.push(by[cur]||blank(cur));cur=dayAdd(cur,1);guard++;}
    S.series=arr;
    if(S.selected>=arr.length)S.selected=-1;
  }
  function agg(){
    var a={plays:0,users:0,records:0,subtitle:0,compose:0,composed:0,saved:0,errors:0,dev:{ios:0,android:0,desktop:0,other:0},f:{open:0,record:0,compose:0,save:0},uids:{},days:0};
    S.series.forEach(function(x){
      a.plays+=x.plays;a.records+=x.records;a.subtitle+=x.subtitle;a.compose+=x.compose;a.composed+=x.composed;a.saved+=x.saved;a.errors+=x.errors;
      a.dev.ios+=x.dev.ios;a.dev.android+=x.dev.android;a.dev.desktop+=x.dev.desktop;a.dev.other+=x.dev.other;
      a.f.open+=x.f.open;a.f.record+=x.f.record;a.f.compose+=x.f.compose;a.f.save+=x.f.save;
      (x.uids||[]).forEach(function(u){a.uids[u]=1;});
      if(x.plays>0||x.records>0||x.composed>0)a.days++;
    });
    a.users=Object.keys(a.uids).length;
    return a;
  }
  function median(arr){
    if(!arr.length)return 0;
    var a=arr.slice().sort(function(x,y){return x-y;});
    var m=Math.floor(a.length/2);
    return a.length%2?a[m]:(a[m-1]+a[m])/2;
  }
  function durations(){
    var d=S.data;if(!d||!d.durations)return [];
    var start=S.series.length?S.series[0].day:'';
    return d.durations.filter(function(x){return x[0]>=start;}).map(function(x){return x[1];});
  }
  function spark(id,values,color){
    var el=$(id);if(!el)return;
    var w=88,h=30,n=values.length;
    if(!n){el.innerHTML='';return;}
    var max=Math.max.apply(null,values.concat([1]));
    var pts=[];
    for(var i=0;i<n;i++){
      var x=n===1?w/2:(i/(n-1))*w;
      var y=h-3-(values[i]/max)*(h-8);
      pts.push([x,y]);
    }
    var line='M'+pts[0][0].toFixed(1)+','+pts[0][1].toFixed(1);
    for(var j=1;j<pts.length;j++){
      var mx=((pts[j-1][0]+pts[j][0])/2).toFixed(1);
      line+='C'+mx+','+pts[j-1][1].toFixed(1)+' '+mx+','+pts[j][1].toFixed(1)+' '+pts[j][0].toFixed(1)+','+pts[j][1].toFixed(1);
    }
    var area=line+'L'+pts[pts.length-1][0].toFixed(1)+','+h+'L'+pts[0][0].toFixed(1)+','+h+'Z';
    el.innerHTML='<svg viewBox="0 0 '+w+' '+h+'" width="100%" height="100%" preserveAspectRatio="none">'+
      '<path d="'+area+'" fill="'+color+'" opacity=".1"/>'+
      '<path d="'+line+'" fill="none" stroke="'+color+'" stroke-width="2" stroke-linecap="round" opacity=".75"/>'+
      '</svg>';
  }
  function renderKpis(a,animate){
    function num(id,v){if(animate)animateNum($(id),v);else $(id).textContent=fmt(v);}
    num('k_plays',a.plays);num('k_users',a.users);num('k_composed',a.composed);num('k_saved',a.saved);
    $('k_plays_sub').innerHTML='日均 <b>'+(a.plays/Math.max(1,S.series.length)).toFixed(1)+'</b> 次访问';
    $('k_users_sub').innerHTML='人均 <b>'+(a.plays/Math.max(1,a.users)).toFixed(1)+'</b> 次访问';
    $('k_composed_sub').innerHTML='合成成功率 <b>'+pct(a.composed,a.compose)+'%</b>';
    $('k_saved_sub').innerHTML='成片保存率 <b>'+pct(a.saved,a.composed)+'%</b>';
    $('m_records').textContent=fmt(a.records);
    $('m_subtitle').textContent=fmt(a.subtitle);
    var durs=durations();
    $('m_duration').textContent=durs.length?(Math.round(median(durs)*10)/10).toFixed(1)+' 分钟':'—';
    $('m_days').textContent=fmt(a.days);
    spark('sp_plays',S.series.map(function(x){return x.plays;}),COLORS.plays);
    spark('sp_users',S.series.map(function(x){return x.users||0;}),'#7c3aed');
    spark('sp_composed',S.series.map(function(x){return x.composed;}),COLORS.composed);
    spark('sp_saved',S.series.map(function(x){return x.saved;}),COLORS.saved);
    var label=S.range==='all'?'全部时间':('近 '+S.range+' 天');
    $('rangeText').textContent=label+' · '+shortDay(S.series[0].day)+' 至 '+shortDay(S.series[S.series.length-1].day);
  }
  function renderChart(){
    var el=$('chart');if(!el)return;
    var n=S.series.length;
    if(!n){el.innerHTML='';return;}
    var metric=S.metric;
    var vals=S.series.map(function(x){return x[metric]||0;});
    var W=el.clientWidth||760,H=el.clientHeight||300;
    var pad={l:38,r:14,t:16,b:26};
    var iw=Math.max(10,W-pad.l-pad.r),ih=Math.max(10,H-pad.t-pad.b);
    var raw=Math.max.apply(null,vals.concat([1]));
    var step=Math.max(1,Math.ceil(raw/4));
    var ymax=step*4;
    function X(i){return pad.l+(n===1?iw/2:(i/(n-1))*iw);}
    function Y(v){return pad.t+ih-(v/ymax)*ih;}
    var color=COLORS[metric];
    var gid='g-'+metric;
    var svg='<svg viewBox="0 0 '+W+' '+H+'" width="'+W+'" height="'+H+'" role="img" aria-label="使用趋势">';
    svg+='<defs><linearGradient id="'+gid+'" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="'+color+'" stop-opacity=".22"/><stop offset="100%" stop-color="'+color+'" stop-opacity=".01"/></linearGradient></defs>';
    for(var g=0;g<=4;g++){
      var gy=pad.t+ih-(g/4)*ih;
      svg+='<line class="gridline" x1="'+pad.l+'" y1="'+gy.toFixed(1)+'" x2="'+(W-pad.r)+'" y2="'+gy.toFixed(1)+'"/>';
      svg+='<text class="axis" x="'+(pad.l-9)+'" y="'+(gy+4).toFixed(1)+'" text-anchor="end">'+fmt(g*step)+'</text>';
    }
    var pts=vals.map(function(v,i){return [X(i),Y(v)];});
    var line='M'+pts[0][0].toFixed(1)+','+pts[0][1].toFixed(1);
    for(var i=1;i<pts.length;i++){
      var mx=((pts[i-1][0]+pts[i][0])/2).toFixed(1);
      line+='C'+mx+','+pts[i-1][1].toFixed(1)+' '+mx+','+pts[i][1].toFixed(1)+' '+pts[i][0].toFixed(1)+','+pts[i][1].toFixed(1);
    }
    var base=pad.t+ih;
    var area=line+'L'+pts[pts.length-1][0].toFixed(1)+','+base+'L'+pts[0][0].toFixed(1)+','+base+'Z';
    svg+='<path d="'+area+'" fill="url(#'+gid+')"/>';
    svg+='<path class="line" d="'+line+'" stroke="'+color+'"/>';
    var every=Math.max(1,Math.ceil(n/7));
    for(var k=0;k<n;k++){
      if(k===0||k===n-1||k%every===0){
        svg+='<text class="axis" x="'+X(k).toFixed(1)+'" y="'+(H-7)+'" text-anchor="middle">'+shortDay(S.series[k].day)+'</text>';
      }
    }
    for(var p=0;p<n;p++){
      svg+='<circle class="dot" cx="'+pts[p][0].toFixed(1)+'" cy="'+pts[p][1].toFixed(1)+'" r="2.6" stroke="'+color+'"/>';
    }
    if(S.selected>=0&&S.selected<n){
      var sx=X(S.selected),sy=pts[S.selected][1];
      svg+='<line class="vline" x1="'+sx.toFixed(1)+'" y1="'+pad.t+'" x2="'+sx.toFixed(1)+'" y2="'+base+'"/>';
      svg+='<circle cx="'+sx.toFixed(1)+'" cy="'+sy.toFixed(1)+'" r="5.5" fill="#fff" stroke="'+color+'" stroke-width="3"/>';
    }
    var hitW=n===1?iw:iw/(n-1);
    for(var q=0;q<n;q++){
      var hx=n===1?pad.l:X(q)-hitW/2;
      svg+='<rect class="hit" data-i="'+q+'" x="'+Math.max(pad.l,hx).toFixed(1)+'" y="'+pad.t+'" width="'+Math.min(hitW,iw).toFixed(1)+'" height="'+ih+'"/>';
    }
    svg+='</svg><div class="chart-tip" id="chartTip"></div>';
    el.innerHTML=svg;
    var tip=$('chartTip');
    el.querySelectorAll('.hit').forEach(function(r){
      var idx=parseInt(r.getAttribute('data-i'),10);
      r.addEventListener('mouseenter',function(){showTip(idx,false);});
      r.addEventListener('click',function(){S.selected=idx;renderChart();syncRows();showTip(idx,true);});
      r.addEventListener('touchstart',function(){S.selected=idx;renderChart();syncRows();showTip(idx,true);},{passive:true});
    });
    el.addEventListener('mouseleave',function(){if(S.selected<0&&tip)tip.style.opacity=0;});
    function showTip(idx,pin){
      if(!tip)return;
      var x=X(idx),y=pts[idx][1],d=S.series[idx];
      tip.innerHTML='<b>'+shortDay(d.day)+' '+weekday(d.day)+'</b><br>访问 '+fmt(d.plays)+' 次 · 用户 '+fmt(d.users)+' 人<br>成片 '+fmt(d.composed)+' 条 · 保存 '+fmt(d.saved)+' 条';
      var left=Math.max(80,Math.min(W-80,x));
      tip.style.left=left+'px';
      tip.style.top=Math.max(30,y-12)+'px';
      tip.style.opacity=1;
    }
    if(S.selected>=0&&S.selected<n)showTip(S.selected,true);
    $('trendSub').textContent=(S.range==='all'?'全部时间':('近 '+S.range+' 天'))+' · 共 '+fmt(vals.reduce(function(x,y){return x+y;},0))+' 次'+LABELS[metric];
    var mi=0;for(var z=1;z<n;z++){if(vals[z]>vals[mi])mi=z;}
    $('peak').innerHTML=vals[mi]>0?('峰值 '+shortDay(S.series[mi].day)+' · <b style="color:#475569">'+fmt(vals[mi])+'</b> 次'+LABELS[metric]):'暂无数据';
    $('chartLegend').innerHTML='<span><i style="background:'+color+'"></i>'+LABELS[metric]+'趋势</span><span style="color:#94a3b8">点击数据点查看当天</span>';
  }
  function renderFunnel(a){
    var f=a.f;
    var stages=[
      {k:'open',name:'打开页面',v:f.open,cls:''},
      {k:'record',name:'开始录制',v:f.record,cls:''},
      {k:'compose',name:'生成成片',v:a.composed,cls:''},
      {k:'save',name:'保存成片',v:f.save,cls:''}
    ];
    var max=Math.max(1,stages[0].v),html='';
    for(var i=0;i<stages.length;i++){
      var s=stages[i];
      var w=Math.max(4,Math.round(s.v/max*100));
      html+='<div class="fstage"><div class="fmeta"><span>'+s.name+'</span><span><b>'+fmt(s.v)+'</b><em>'+pct(s.v,max)+'%</em></span></div><div class="ftrack"><div class="fbar" data-w="'+w+'" style="width:0"></div></div></div>';
      if(i<stages.length-1){
        html+='<div class="fconv"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="m6 13 6 6 6-6"/></svg>转化 '+pct(stages[i+1].v,Math.max(1,s.v))+'%</div>';
      }
    }
    html+='<div class="fsum"><span>整体转化 <b>'+pct(f.save,Math.max(1,f.open))+'%</b></span><span>保存/成片 <b>'+pct(f.save,Math.max(1,a.composed))+'%</b></span></div>';
    $('funnel').innerHTML=html;
    requestAnimationFrame(function(){
      $('funnel').querySelectorAll('.fbar').forEach(function(b){b.style.width=b.getAttribute('data-w')+'%';});
    });
  }
  function renderTable(){
    var rows=S.series.slice().reverse(),html='';
    if(!rows.length)html='<tr><td colspan="7" style="text-align:center;color:#a0aec0;padding:24px">暂无数据</td></tr>';
    rows.forEach(function(x){
      var idx=S.series.indexOf(x);
      var rate=x.composed?pct(x.saved,x.composed)+'%':'—';
      var rateCls=!x.composed?'zero':(pct(x.saved,x.composed)>=60?'rate':(pct(x.saved,x.composed)>=30?'rate mid':'rate low'));
      html+='<tr data-i="'+idx+'"'+(idx===S.selected?' class="active"':'')+'><td>'+shortDay(x.day)+'<span class="wk">'+weekday(x.day)+'</span></td><td>'+fmt(x.plays)+'</td><td>'+fmt(x.users)+'</td><td>'+fmt(x.records)+'</td><td>'+fmt(x.composed)+'</td><td>'+fmt(x.saved)+'</td><td><span class="'+rateCls+'">'+rate+'</span></td></tr>';
    });
    $('days').innerHTML=html;
    $('days').querySelectorAll('tr[data-i]').forEach(function(tr){
      tr.addEventListener('click',function(){
        var i=parseInt(tr.getAttribute('data-i'),10);
        S.selected=(S.selected===i?-1:i);
        renderChart();syncRows();
      });
    });
  }
  function syncRows(){
    var rows=$('days').querySelectorAll('tr[data-i]');
    rows.forEach(function(tr){tr.classList.toggle('active',parseInt(tr.getAttribute('data-i'),10)===S.selected);});
  }
  function renderDonut(a){
    var total=a.dev.ios+a.dev.android+a.dev.desktop+a.dev.other;
    var order=['ios','android','desktop','other'];
    var r=54,c=2*Math.PI*r,off=0;
    var svg='<svg viewBox="0 0 140 140"><circle cx="70" cy="70" r="'+r+'" stroke="#eef2f8" stroke-width="16"/>';
    order.forEach(function(k){
      var v=a.dev[k];if(!v)return;
      var len=v/total*c;
      svg+='<circle cx="70" cy="70" r="'+r+'" stroke="'+DEV[k].color+'" stroke-dasharray="'+len.toFixed(1)+' '+(c-len).toFixed(1)+'" stroke-dashoffset="'+(-off).toFixed(1)+'" data-k="'+k+'"><title>'+DEV[k].label+' '+v+' 次</title></circle>';
      off+=len;
    });
    svg+='</svg>';
    $('donut').innerHTML=svg+'<div class="donut-center"><b id="dTotal">'+fmt(total)+'</b><span id="dLabel">次访问</span></div>';
    var legend='';
    order.forEach(function(k){
      var v=a.dev[k];
      legend+='<div class="legend-row"><i style="background:'+DEV[k].color+'"></i><span>'+DEV[k].label+'</span><b>'+fmt(v)+'</b><em>'+pct(v,total)+'%</em></div>';
    });
    $('donutLegend').innerHTML=legend||'<div style="color:#a0aec0;font-size:12px;padding:8px 0">暂无数据</div>';
    $('donut').querySelectorAll('circle[data-k]').forEach(function(cir){
      cir.addEventListener('mouseenter',function(){
        var k=cir.getAttribute('data-k');
        $('dTotal').textContent=pct(a.dev[k],total)+'%';
        $('dLabel').textContent=DEV[k].label;
      });
      cir.addEventListener('mouseleave',function(){
        $('dTotal').textContent=fmt(total);
        $('dLabel').textContent='次访问';
      });
    });
    $('devSub').textContent=total?('共 '+fmt(total)+' 次访问 · 移动端 '+pct(a.dev.ios+a.dev.android,total)+'%'):'暂无访问数据';
  }
  function renderQuality(a){
    var d=S.data;
    $('qBadge').textContent='详情';
    $('qRate').textContent=pct(a.composed,a.compose)+'%';
    $('qErr').textContent=fmt(a.errors)+' 条';
    var top=d.errorTop&&d.errorTop.length?d.errorTop[0]:null;
    $('qTop').textContent=top?top.m:'无';
    $('qTop').title=top?top.m:'';
    $('qTopLabel').textContent=top?('主要提示 · '+top.n+' 次'):'主要提示';
  }
  function renderAll(animate){
    if(!S.data)return;
    var a=agg();
    renderKpis(a,animate);
    renderChart();
    renderFunnel(a);
    renderTable();
    renderDonut(a);
    renderQuality(a);
    var t=new Date(S.data.generatedAt);
    $('updated').textContent='更新于 '+pad(t.getHours())+':'+pad(t.getMinutes())+':'+pad(t.getSeconds());
    $('host').textContent=location.host;
  }
  function showGate(msg){
    $('gate').classList.remove('hidden');
    $('main').classList.add('hidden');
    $('err').textContent=msg||'';
    if(msg){var c=$('gateCard');c.classList.remove('shake');void c.offsetWidth;c.classList.add('shake');}
    setTimeout(function(){$('key').focus();},60);
  }
  function load(silent){
    if(!key)return;
    if(!silent){$('go').disabled=true;$('go').textContent='验证中…';}
    var ctl=null;
    try{ctl=new AbortController();}catch(e){}
    var timer=setTimeout(function(){try{if(ctl)ctl.abort();}catch(e){}},12000);
    var opts={cache:'no-store'};
    if(ctl)opts.signal=ctl.signal;
    fetch('/api/stats?key='+encodeURIComponent(key),opts).then(function(r){
      if(r.status===401){showGate('口令错误，请重新输入');return null;}
      if(!r.ok)throw new Error('HTTP '+r.status);
      return r.json();
    }).then(function(d){
      if(!d||!d.ok)return;
      try{localStorage.setItem('statsKey',key);}catch(e){}
      $('gate').classList.add('hidden');
      $('main').classList.remove('hidden');
      S.data=d;buildSeries();renderAll(!silent&&S.first);S.first=false;
      if(!S.timer)S.timer=setInterval(function(){if(!document.hidden)load(true);},30000);
      if(!silent)toast('看板已更新');
    }).catch(function(){
      if($('main').classList.contains('hidden'))showGate('网络错误，请稍后重试');
      else if(!silent)toast('刷新失败，请稍后重试');
    }).then(function(){
      clearTimeout(timer);
      $('go').disabled=false;$('go').textContent='进入看板';
    });
  }
  function submitGate(){
    var v=$('key').value.trim();
    if(!v){$('err').textContent='请输入访问口令';return;}
    key=v;load(false);
  }
  $('go').addEventListener('click',submitGate);
  $('gateForm').addEventListener('submit',function(e){e.preventDefault();submitGate();});
  $('rangeTabs').addEventListener('click',function(e){
    var b=e.target.closest('button[data-r]');if(!b)return;
    if(S.range===b.getAttribute('data-r'))return;
    S.range=b.getAttribute('data-r');S.selected=-1;
    this.querySelectorAll('button').forEach(function(x){x.classList.toggle('on',x===b);});
    buildSeries();renderAll(true);
  });
  $('metricChips').addEventListener('click',function(e){
    var b=e.target.closest('button[data-m]');if(!b)return;
    if(S.metric===b.getAttribute('data-m'))return;
    S.metric=b.getAttribute('data-m');
    this.querySelectorAll('button').forEach(function(x){x.classList.toggle('on',x===b);});
    renderChart();
  });
  $('refresh').addEventListener('click',function(){
    var b=this;b.classList.add('spin');load(true);setTimeout(function(){b.classList.remove('spin');},900);
  });
  $('print').addEventListener('click',function(){window.print();});
  $('full').addEventListener('click',function(){
    var d=document,el=d.documentElement;
    if(!d.fullscreenElement&&!d.webkitFullscreenElement){
      var fn=el.requestFullscreen||el.webkitRequestFullscreen;
      if(fn){try{fn.call(el);}catch(e){toast('当前浏览器不支持全屏');}}
      else toast('当前浏览器不支持全屏');
    }else{
      var ex=d.exitFullscreen||d.webkitExitFullscreen;
      if(ex)ex.call(d);
    }
  });
  $('csv').addEventListener('click',function(){
    if(!S.data)return;
    var rows=[['日期','访问','用户','开始录制','生成成片','保存成片','保存率']];
    S.series.forEach(function(x){rows.push([x.day,x.plays,x.users,x.records,x.composed,x.saved,x.composed?pct(x.saved,x.composed)+'%':'—']);});
    var csv='\\ufeff'+rows.map(function(r){return r.map(function(c){return '"'+String(c).replace(/"/g,'""')+'"';}).join(',');}).join('\\n');
    var blob=new Blob([csv],{type:'text/csv;charset=utf-8'});
    var a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='门店短视频-运营数据-'+S.data.todayDay+'.csv';
    document.body.appendChild(a);a.click();setTimeout(function(){URL.revokeObjectURL(a.href);a.remove();},300);
    toast('CSV 已导出');
  });
  var rt=0;
  window.addEventListener('resize',function(){
    clearTimeout(rt);rt=setTimeout(function(){if(S.data)renderChart();},160);
  });
  document.addEventListener('visibilitychange',function(){if(!document.hidden)load(true);});
  if(key)load(true);else setTimeout(function(){$('key').focus();},80);
})();
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
