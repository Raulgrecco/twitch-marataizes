// =====================================================================
// TV Sul Capixaba — Painel de Playout — MVP (versão completa)
// =====================================================================
// Projeto novo, escrito do zero. Node.js puro — apenas módulos nativos
// (http, fs, path, crypto, url). Sem Express, sem React/Vue, sem
// dependências externas.
//
// AINDA NÃO IMPLEMENTADO (propositalmente, para etapas futuras):
//   - FFmpeg (motor real de transmissão)      -> Etapa 9
//   - RTMP                                     -> Etapa 10
//   - SRT                                      -> Etapa 11
//   - Auto-update via GitHub                   -> Etapa 12
//
// Todo dado de transmissão (CPU, RAM, saída, "tocando agora") é
// SIMULADO. Os pontos exatos onde o motor real (FFmpeg/RTMP/SRT) vai
// entrar estão marcados com comentários "// [FUTURO]".
// =====================================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { spawn, execFileSync } = require('child_process');
const { URL } = require('url');

// ---------------------------------------------------------------------
// Caminhos e constantes
// ---------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024; // 2GB — limite de segurança do MVP

[DATA_DIR, UPLOADS_DIR].forEach(function (dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ---------------------------------------------------------------------
// Persistência simples em arquivo JSON (substitui banco de dados nesta
// versão — troca por um banco real pode ser feita depois sem afetar
// as rotas da API, pois todo acesso passa pelo objeto `db`)
// ---------------------------------------------------------------------
const DEFAULT_DB = {
  videos: [],
  schedule: [],
  events: [],
  history: [],
  logs: [],
  config: {
    videosFolder: './uploads',
    output: {
      resolution: '1920x1080',
      bitrate: '4000k',
      format: 'A definir (RTMP chega na Etapa 10, SRT na Etapa 11)'
    },
    general: {
      channelName: 'TV Sul Capixaba',
      timezone: 'America/Sao_Paulo'
    }
  }
};

function loadDB() {
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Object.assign({}, JSON.parse(JSON.stringify(DEFAULT_DB)), parsed);
  } catch (e) {
    return JSON.parse(JSON.stringify(DEFAULT_DB));
  }
}

let db = loadDB();

let saveTimer = null;
function saveDB() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(function () {
    const tmpFile = DB_FILE + '.tmp';
    fs.writeFile(tmpFile, JSON.stringify(db, null, 2), function (err) {
      if (err) {
        console.error('Erro ao salvar dados:', err.message);
        return;
      }
      fs.rename(tmpFile, DB_FILE, function (renameErr) {
        if (renameErr) console.error('Erro ao substituir arquivo de dados:', renameErr.message);
      });
    });
  }, 150);
}

function uid() {
  return crypto.randomBytes(8).toString('hex');
}

// ---------------------------------------------------------------------
// Logs (em memória, com transmissão em tempo real via SSE)
// ---------------------------------------------------------------------
const logClients = new Set();

function addLog(level, message) {
  const entry = { id: uid(), timestamp: new Date().toISOString(), level: level, message: message };
  db.logs.push(entry);
  if (db.logs.length > 500) db.logs.shift();
  saveDB();
  const payload = 'data: ' + JSON.stringify(entry) + '\n\n';
  logClients.forEach(function (res) {
    try { res.write(payload); }
    catch (e) { logClients.delete(res); }
  });
  return entry;
}

// ---------------------------------------------------------------------
// Motor de playout — SIMULADO nesta versão.
// A interface (start/stop/restart/getStatus) foi desenhada para que,
// quando o motor real de FFmpeg entrar (Etapa 9), apenas o CORPO destes
// métodos precise mudar — nenhuma rota de API ou tela precisa mudar.
// ---------------------------------------------------------------------
function rand(min, max) { return Math.random() * (max - min) + min; }
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function toMinutes(hhmm) {
  const parts = (hhmm || '00:00').split(':');
  return (parseInt(parts[0], 10) || 0) * 60 + (parseInt(parts[1], 10) || 0);
}
function formatUptime(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  function pad(n) { return String(n).padStart(2, '0'); }
  return pad(h) + ':' + pad(m) + ':' + pad(s);
}

// ---------------------------------------------------------------------
// Detecção de ambiente / FFmpeg (Etapa 9)
// Roda uma vez na inicialização do processo. Nada aqui usa caminho fixo:
// o executável do FFmpeg é sempre descoberto via PATH do sistema ("which").
// ---------------------------------------------------------------------
const envInfo = {
  ffmpegPath: null,
  ffmpegVersion: null,
  ffmpegHasH264: false,
  ffmpegHasAac: false
};

function formatBytesServer(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return v.toFixed(1) + ' ' + units[i];
}

function detectFFmpegPath() {
  try {
    const out = execFileSync('which', ['ffmpeg'], { encoding: 'utf8' }).trim();
    return out || null;
  } catch (e) {
    return null;
  }
}

function getFFmpegInfo(ffmpegPath) {
  const info = { version: null, hasH264: false, hasAac: false };
  try {
    const versionOut = execFileSync(ffmpegPath, ['-version'], { encoding: 'utf8' });
    info.version = versionOut.split('\n')[0].trim();
  } catch (e) { /* versão fica null */ }
  try {
    const encodersOut = execFileSync(ffmpegPath, ['-hide_banner', '-encoders'], { encoding: 'utf8' });
    info.hasH264 = /libx264/.test(encodersOut);
    info.hasAac = /\baac\b/.test(encodersOut);
  } catch (e) { /* codecs ficam falso */ }
  return info;
}

function runEnvironmentDetection() {
  addLog('info', 'Iniciando detecção de ambiente...');
  addLog('info', 'Sistema operacional: ' + os.platform() + ' ' + os.release());
  addLog('info', 'Memória livre: ' + formatBytesServer(os.freemem()) + ' de ' + formatBytesServer(os.totalmem()) + ' totais');

  try {
    if (typeof fs.statfsSync === 'function') {
      const stats = fs.statfsSync(UPLOADS_DIR);
      const freeBytes = stats.bavail * stats.bsize;
      const totalBytes = stats.blocks * stats.bsize;
      addLog('info', 'Espaço em disco (pasta de vídeos): ' + formatBytesServer(freeBytes) + ' livres de ' + formatBytesServer(totalBytes));
    } else {
      addLog('warn', 'Não foi possível verificar espaço em disco: fs.statfsSync não disponível nesta versão do Node.');
    }
  } catch (e) {
    addLog('warn', 'Não foi possível verificar espaço em disco: ' + e.message);
  }

  const ffmpegPath = detectFFmpegPath();
  if (!ffmpegPath) {
    envInfo.ffmpegPath = null;
    addLog('error', 'FFmpeg não encontrado no sistema (which ffmpeg não retornou nenhum caminho). A transmissão não poderá ser iniciada até o FFmpeg ser instalado.');
    return;
  }

  const info = getFFmpegInfo(ffmpegPath);
  envInfo.ffmpegPath = ffmpegPath;
  envInfo.ffmpegVersion = info.version;
  envInfo.ffmpegHasH264 = info.hasH264;
  envInfo.ffmpegHasAac = info.hasAac;

  addLog('info', 'FFmpeg encontrado em ' + ffmpegPath + ' (detectado automaticamente via PATH do sistema)');
  addLog('info', 'Versão do FFmpeg: ' + (info.version || 'não foi possível determinar'));
  addLog(info.hasH264 ? 'info' : 'warn', 'Codec H.264 (libx264): ' + (info.hasH264 ? 'disponível' : 'NÃO disponível'));
  addLog(info.hasAac ? 'info' : 'warn', 'Codec AAC: ' + (info.hasAac ? 'disponível' : 'NÃO disponível'));
}

const engine = {
  running: false,
  startedAt: null,
  cpu: 0,
  ram: 0,
  outputLabel: '—',
  currentVideoId: null,
  restartTimer: null,
  restartToken: 0,

  ffmpegProcess: null,

  start: function () {
    // Qualquer chamada explícita a start() invalida um reinício pendente,
    // evitando que um restart() antigo ligue a transmissão de novo depois
    // que o usuário já agiu manualmente (condição de corrida corrigida).
    this.restartToken++;
    if (this.running) return;

    if (!envInfo.ffmpegPath) {
      addLog('error', 'Não foi possível iniciar: FFmpeg não foi encontrado no sistema (ver detecção de ambiente nos Logs).');
      return;
    }

    const self = this;
    const resolution = (db.config.output.resolution || '1280x720').replace(/\s+/g, '');
    const bitrate = db.config.output.bitrate || '2000k';
    const args = [
      '-hide_banner',
      '-loglevel', 'warning',
      '-f', 'lavfi',
      '-i', 'testsrc=size=' + resolution + ':rate=30',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-b:v', bitrate,
      '-f', 'null',
      '-'
    ];

    let child;
    try {
      child = spawn(envInfo.ffmpegPath, args);
    } catch (err) {
      addLog('error', 'Falha ao iniciar o processo do FFmpeg: ' + err.message);
      return;
    }

    this.ffmpegProcess = child;
    this.running = true;
    this.startedAt = Date.now();
    this.outputLabel = resolution + ' @ ' + bitrate;
    addLog('info', 'Transmissão iniciada — processo FFmpeg criado (PID ' + child.pid + ')');

    child.on('error', function (err) {
      addLog('error', 'Erro no processo do FFmpeg: ' + err.message);
      self.running = false;
      self.startedAt = null;
      self.outputLabel = '—';
      self.ffmpegProcess = null;
    });

    child.on('exit', function (code, signal) {
      const wasStoppedManually = !self.running;
      self.ffmpegProcess = null;
      if (!wasStoppedManually) {
        self.running = false;
        self.startedAt = null;
        self.outputLabel = '—';
        addLog('error', 'Processo do FFmpeg encerrou inesperadamente (código ' + code + (signal ? ', sinal ' + signal : '') + ')');
      }
    });

    if (child.stderr) {
      child.stderr.on('data', function (chunk) {
        // FFmpeg escreve seu log de progresso/erros no stderr; guardamos só
        // a última linha de cada bloco para não inundar os Logs do painel.
        const text = chunk.toString('utf8').trim();
        if (text) addLog('info', '[ffmpeg] ' + text.split('\n').pop());
      });
    }
  },

  stop: function () {
    // Idem: invalida qualquer restart() pendente.
    this.restartToken++;
    if (!this.running) return;
    this.running = false;
    this.startedAt = null;
    this.outputLabel = '—';
    if (this.ffmpegProcess) {
      try { this.ffmpegProcess.kill('SIGTERM'); } catch (e) { /* processo já pode ter encerrado */ }
    }
    addLog('info', 'Transmissão parada');
  },

  restart: function () {
    const self = this;
    addLog('info', 'Reiniciando transmissão...');
    this.stop(); // já incrementa restartToken acima
    const token = ++this.restartToken;
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(function () {
      try {
        // Só religa se nenhum start()/stop() manual aconteceu nesse meio-tempo.
        if (self.restartToken === token) self.start();
      } catch (err) {
        console.error('Erro ao concluir reinício da transmissão:', err.message);
      }
    }, 700);
  },

  // Calcula qual vídeo "deveria" estar tocando agora, com base na
  // Programação (blocos diários). Isso é só simulação de agenda —
  // a troca real de fonte de vídeo/cena acontece no motor (Etapa 9).
  computeScheduledVideoId: function () {
    const active = db.schedule.filter(function (s) { return s.repeatDaily; });
    if (active.length === 0) return null;
    const now = new Date();
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const sorted = active.slice().sort(function (a, b) { return toMinutes(a.startTime) - toMinutes(b.startTime); });
    let chosen = sorted[sorted.length - 1];
    for (let i = 0; i < sorted.length; i++) {
      if (toMinutes(sorted[i].startTime) <= nowMinutes) chosen = sorted[i];
    }
    return chosen ? chosen.videoId : null;
  },

  // Verifica eventos agendados e "dispara" os que já passaram do horário.
  checkEvents: function () {
    const now = Date.now();
    let changed = false;
    for (let i = 0; i < db.events.length; i++) {
      const ev = db.events[i];
      if (ev.status === 'agendado' && new Date(ev.datetime).getTime() <= now) {
        ev.status = 'concluido';
        const video = db.videos.find(function (v) { return v.id === ev.videoId; });
        db.history.unshift({
          id: uid(),
          eventId: ev.id,
          videoId: ev.videoId,
          datetime: ev.datetime,
          triggeredAt: new Date().toISOString()
        });
        if (db.history.length > 500) db.history.length = 500;
        // [FUTURO] Etapa 9/10/11: aqui a troca de cena real seria disparada no motor.
        addLog('info', 'Evento disparado: ' + (video ? video.originalName : 'vídeo removido'));
        this.currentVideoId = ev.videoId;
        changed = true;
      }
    }
    if (changed) saveDB();
  },

  tick: function () {
    if (this.running) {
      this.cpu = clamp(this.cpu + rand(-4, 4), 8, 45);
      this.ram = clamp(this.ram + rand(-3, 3), 15, 60);
      const scheduled = this.computeScheduledVideoId();
      if (scheduled) this.currentVideoId = scheduled;
    } else {
      this.cpu = clamp(this.cpu - 6, 0, 100);
      this.ram = clamp(this.ram - 4, 0, 100);
    }
    this.checkEvents();
  },

  getStatus: function () {
    const video = this.currentVideoId ? db.videos.find(function (v) { return v.id === engine.currentVideoId; }) : null;
    let upSeconds = 0;
    if (this.running && this.startedAt) upSeconds = Math.floor((Date.now() - this.startedAt) / 1000);
    return {
      running: this.running,
      nowPlaying: video ? video.originalName : '—',
      cpu: this.running ? Math.round(this.cpu) + '%' : '—',
      ram: this.running ? Math.round(this.ram) + '%' : '—',
      output: this.running ? this.outputLabel : '—',
      upSeconds: upSeconds,
      upFormatted: formatUptime(upSeconds)
    };
  }
};

setInterval(function () {
  try {
    engine.tick();
  } catch (err) {
    console.error('Erro no tick do motor de playout:', err.message);
  }
}, 1000);

// ---------------------------------------------------------------------
// Helpers HTTP
// ---------------------------------------------------------------------
function sendJSON(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024; // 2MB — suficiente para os payloads desta API

function readJSONBody(req) {
  return new Promise(function (resolve, reject) {
    const chunks = [];
    let total = 0;
    req.on('data', function (c) {
      total += c.length;
      if (total > MAX_JSON_BODY_BYTES) {
        req.destroy();
        reject(new Error('Corpo da requisição excede o limite permitido'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', function () {
      if (chunks.length === 0) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('JSON inválido no corpo da requisição')); }
    });
    req.on('error', reject);
  });
}

function readRawBody(req, limitBytes) {
  return new Promise(function (resolve, reject) {
    const chunks = [];
    let total = 0;
    req.on('data', function (c) {
      total += c.length;
      if (limitBytes && total > limitBytes) {
        req.destroy();
        reject(new Error('Arquivo excede o limite permitido'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', function () { resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

// Parser de multipart/form-data escrito apenas com módulos nativos.
// Para o MVP, o corpo é lido inteiro em memória antes de ser dividido.
// (otimizar para streaming direto em disco é uma melhoria futura, não
// necessária para o funcionamento correto desta versão.)
function splitBuffer(buf, sep) {
  const parts = [];
  let start = 0;
  let idx;
  while ((idx = buf.indexOf(sep, start)) !== -1) {
    parts.push(buf.slice(start, idx));
    start = idx + sep.length;
  }
  parts.push(buf.slice(start));
  return parts;
}

function parseMultipart(contentType, buffer) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) throw new Error('Boundary não encontrado no Content-Type');
  const boundary = m[1] || m[2];
  const boundaryBuf = Buffer.from('--' + boundary);
  const rawParts = splitBuffer(buffer, boundaryBuf);
  const fields = {};
  const files = [];

  for (let i = 1; i < rawParts.length - 1; i++) {
    let part = rawParts[i];
    if (part.slice(0, 2).toString() === '\r\n') part = part.slice(2);
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    const headerText = part.slice(0, headerEnd).toString('utf8');
    let body = part.slice(headerEnd + 4);
    if (body.slice(-2).toString() === '\r\n') body = body.slice(0, -2);

    const nameMatch = /name="([^"]+)"/i.exec(headerText);
    const filenameMatch = /filename="([^"]*)"/i.exec(headerText);
    const typeMatch = /Content-Type:\s*([^\r\n]+)/i.exec(headerText);
    const fieldName = nameMatch ? nameMatch[1] : null;
    if (!fieldName) continue;

    if (filenameMatch && filenameMatch[1]) {
      files.push({
        field: fieldName,
        filename: filenameMatch[1],
        mimeType: typeMatch ? typeMatch[1].trim() : 'application/octet-stream',
        data: body
      });
    } else {
      fields[fieldName] = body.toString('utf8');
    }
  }
  return { fields: fields, files: files };
}

// ---------------------------------------------------------------------
// Handlers — Status / Controle (Dashboard)
// ---------------------------------------------------------------------
function handleStatus(req, res) {
  sendJSON(res, 200, engine.getStatus());
}

function handleControl(req, res) {
  readJSONBody(req).then(function (body) {
    const action = body.action;
    if (action === 'iniciar') engine.start();
    else if (action === 'parar') engine.stop();
    else if (action === 'reiniciar') engine.restart();
    else return sendJSON(res, 400, { error: 'Ação inválida' });
    sendJSON(res, 200, engine.getStatus());
  }).catch(function (err) { sendJSON(res, 400, { error: err.message }); });
}

// ---------------------------------------------------------------------
// Handlers — Vídeos (usados tanto por Arquivos quanto por Biblioteca)
// ---------------------------------------------------------------------
function handleVideosList(req, res, parsedUrl) {
  const search = (parsedUrl.searchParams.get('search') || '').toLowerCase();
  const sort = parsedUrl.searchParams.get('sort') || 'date';
  let list = db.videos.slice();
  if (search) list = list.filter(function (v) { return v.originalName.toLowerCase().indexOf(search) !== -1; });
  if (sort === 'name') list.sort(function (a, b) { return a.originalName.localeCompare(b.originalName); });
  else if (sort === 'size') list.sort(function (a, b) { return b.size - a.size; });
  else list.sort(function (a, b) { return new Date(b.uploadedAt) - new Date(a.uploadedAt); });
  sendJSON(res, 200, list);
}

function handleVideoInfo(req, res, id) {
  const video = db.videos.find(function (v) { return v.id === id; });
  if (!video) return sendJSON(res, 404, { error: 'Vídeo não encontrado' });
  sendJSON(res, 200, video);
}

function handleVideoUpload(req, res) {
  const contentType = req.headers['content-type'] || '';
  if (contentType.indexOf('multipart/form-data') !== 0) {
    return sendJSON(res, 400, { error: 'Content-Type deve ser multipart/form-data' });
  }
  readRawBody(req, MAX_UPLOAD_BYTES).then(function (raw) {
    let parsed;
    try { parsed = parseMultipart(contentType, raw); }
    catch (e) { return sendJSON(res, 400, { error: 'Falha ao interpretar upload: ' + e.message }); }

    if (!parsed.files.length) return sendJSON(res, 400, { error: 'Nenhum arquivo enviado' });

    const saved = [];
    parsed.files.forEach(function (file) {
      const id = uid();
      const ext = path.extname(file.filename) || '';
      const storedName = id + ext;
      fs.writeFileSync(path.join(UPLOADS_DIR, storedName), file.data);
      const meta = {
        id: id,
        originalName: file.filename,
        storedName: storedName,
        size: file.data.length,
        mimeType: file.mimeType,
        uploadedAt: new Date().toISOString()
      };
      db.videos.push(meta);
      saved.push(meta);
      addLog('info', 'Arquivo enviado: ' + file.filename);
    });
    saveDB();
    sendJSON(res, 201, saved);
  }).catch(function (err) { sendJSON(res, 413, { error: err.message }); });
}

function handleVideoRename(req, res, id) {
  readJSONBody(req).then(function (body) {
    const video = db.videos.find(function (v) { return v.id === id; });
    if (!video) return sendJSON(res, 404, { error: 'Vídeo não encontrado' });
    const newName = (body.name || '').trim();
    if (!newName) return sendJSON(res, 400, { error: 'Nome inválido' });
    const oldName = video.originalName;
    video.originalName = newName;
    addLog('info', 'Arquivo renomeado: ' + oldName + ' -> ' + newName);
    saveDB();
    sendJSON(res, 200, video);
  }).catch(function (err) { sendJSON(res, 400, { error: err.message }); });
}

function handleVideoDelete(req, res, id) {
  const idx = db.videos.findIndex(function (v) { return v.id === id; });
  if (idx === -1) return sendJSON(res, 404, { error: 'Vídeo não encontrado' });
  const video = db.videos[idx];
  try { fs.unlinkSync(path.join(UPLOADS_DIR, video.storedName)); } catch (e) { /* já não existia */ }
  db.videos.splice(idx, 1);
  db.schedule = db.schedule.filter(function (s) { return s.videoId !== id; });
  db.events = db.events.filter(function (ev) { return ev.videoId !== id; });
  addLog('info', 'Arquivo removido: ' + video.originalName);
  saveDB();
  sendJSON(res, 200, { ok: true });
}

// Reprodução/preview com suporte a Range (usado pela Biblioteca)
function serveMedia(req, res, id) {
  const video = db.videos.find(function (v) { return v.id === id; });
  if (!video) { res.writeHead(404); return res.end('Vídeo não encontrado'); }
  const filePath = path.join(UPLOADS_DIR, video.storedName);
  let stat;
  try { stat = fs.statSync(filePath); } catch (e) { res.writeHead(404); return res.end('Arquivo não encontrado no disco'); }

  const contentType = video.mimeType || 'application/octet-stream';
  const range = req.headers.range;
  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    let start, end;
    if (match && match[1] === '' && match[2] !== '') {
      // Range de sufixo (ex.: "bytes=-500" = últimos 500 bytes do arquivo).
      const suffixLength = parseInt(match[2], 10);
      start = Math.max(stat.size - suffixLength, 0);
      end = stat.size - 1;
    } else if (match) {
      start = match[1] ? parseInt(match[1], 10) : 0;
      end = match[2] ? parseInt(match[2], 10) : stat.size - 1;
    } else {
      start = 0;
      end = stat.size - 1;
    }
    if (end >= stat.size) end = stat.size - 1;
    if (isNaN(start) || isNaN(end) || start > end || start >= stat.size || start < 0) {
      res.writeHead(416, { 'Content-Range': 'bytes */' + stat.size });
      return res.end();
    }
    res.writeHead(206, {
      'Content-Range': 'bytes ' + start + '-' + end + '/' + stat.size,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': contentType
    });
    fs.createReadStream(filePath, { start: start, end: end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': contentType, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(filePath).pipe(res);
  }
}

// ---------------------------------------------------------------------
// Handlers — Programação
// ---------------------------------------------------------------------
function handleScheduleList(req, res) {
  const list = db.schedule.slice().sort(function (a, b) {
    return toMinutes(a.startTime) - toMinutes(b.startTime) || a.order - b.order;
  });
  sendJSON(res, 200, list);
}

function handleScheduleCreate(req, res) {
  readJSONBody(req).then(function (body) {
    if (!body.videoId || !db.videos.find(function (v) { return v.id === body.videoId; })) {
      return sendJSON(res, 400, { error: 'Vídeo inválido' });
    }
    if (!body.startTime) return sendJSON(res, 400, { error: 'Horário de início é obrigatório' });
    const entry = {
      id: uid(),
      videoId: body.videoId,
      startTime: body.startTime,
      order: Number(body.order) || 0,
      repeatDaily: !!body.repeatDaily
    };
    db.schedule.push(entry);
    addLog('info', 'Programação criada para ' + entry.startTime);
    saveDB();
    sendJSON(res, 201, entry);
  }).catch(function (err) { sendJSON(res, 400, { error: err.message }); });
}

function handleScheduleUpdate(req, res, id) {
  readJSONBody(req).then(function (body) {
    const entry = db.schedule.find(function (s) { return s.id === id; });
    if (!entry) return sendJSON(res, 404, { error: 'Programação não encontrada' });
    if (body.videoId) entry.videoId = body.videoId;
    if (body.startTime) entry.startTime = body.startTime;
    if (body.order !== undefined) entry.order = Number(body.order) || 0;
    if (body.repeatDaily !== undefined) entry.repeatDaily = !!body.repeatDaily;
    addLog('info', 'Programação atualizada: ' + entry.startTime);
    saveDB();
    sendJSON(res, 200, entry);
  }).catch(function (err) { sendJSON(res, 400, { error: err.message }); });
}

function handleScheduleDelete(req, res, id) {
  const idx = db.schedule.findIndex(function (s) { return s.id === id; });
  if (idx === -1) return sendJSON(res, 404, { error: 'Programação não encontrada' });
  db.schedule.splice(idx, 1);
  addLog('info', 'Item de programação removido');
  saveDB();
  sendJSON(res, 200, { ok: true });
}

// ---------------------------------------------------------------------
// Handlers — Eventos
// ---------------------------------------------------------------------
function handleEventsList(req, res) {
  const scheduled = db.events.filter(function (e) { return e.status === 'agendado'; })
    .sort(function (a, b) { return new Date(a.datetime) - new Date(b.datetime); });
  const history = db.history.slice(0, 100);
  sendJSON(res, 200, { scheduled: scheduled, history: history });
}

function handleEventCreate(req, res) {
  readJSONBody(req).then(function (body) {
    if (!body.videoId || !db.videos.find(function (v) { return v.id === body.videoId; })) {
      return sendJSON(res, 400, { error: 'Vídeo inválido' });
    }
    if (!body.datetime) return sendJSON(res, 400, { error: 'Data/hora é obrigatória' });
    const entry = { id: uid(), videoId: body.videoId, datetime: body.datetime, status: 'agendado' };
    db.events.push(entry);
    addLog('info', 'Evento agendado para ' + body.datetime);
    saveDB();
    sendJSON(res, 201, entry);
  }).catch(function (err) { sendJSON(res, 400, { error: err.message }); });
}

function handleEventDelete(req, res, id) {
  const idx = db.events.findIndex(function (e) { return e.id === id && e.status === 'agendado'; });
  if (idx === -1) return sendJSON(res, 404, { error: 'Evento não encontrado ou já concluído' });
  db.events.splice(idx, 1);
  addLog('info', 'Evento agendado removido');
  saveDB();
  sendJSON(res, 200, { ok: true });
}

// ---------------------------------------------------------------------
// Handlers — Configurações
// ---------------------------------------------------------------------
function handleConfigGet(req, res) {
  sendJSON(res, 200, db.config);
}

function handleConfigUpdate(req, res) {
  readJSONBody(req).then(function (body) {
    if (body.videosFolder !== undefined) db.config.videosFolder = body.videosFolder;
    if (body.output) db.config.output = Object.assign({}, db.config.output, body.output);
    if (body.general) db.config.general = Object.assign({}, db.config.general, body.general);
    addLog('info', 'Configurações atualizadas');
    saveDB();
    sendJSON(res, 200, db.config);
  }).catch(function (err) { sendJSON(res, 400, { error: err.message }); });
}

// ---------------------------------------------------------------------
// Handlers — Logs
// ---------------------------------------------------------------------
function handleLogsList(req, res, parsedUrl) {
  const level = parsedUrl.searchParams.get('level');
  let list = db.logs.slice().reverse();
  if (level) list = list.filter(function (l) { return l.level === level; });
  sendJSON(res, 200, list.slice(0, 300));
}

function handleLogsStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  res.write(': conectado\n\n');
  logClients.add(res);
  function cleanup() { logClients.delete(res); }
  req.on('close', cleanup);
  req.on('error', cleanup);
  res.on('error', cleanup);
}

// ---------------------------------------------------------------------
// Página HTML/CSS/JS (frontend embutido — sem frameworks)
// ---------------------------------------------------------------------
function serveIndex(res) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(PAGE_HTML);
}

const PAGE_HTML = "<!DOCTYPE html>" +
"<html lang=\"pt-BR\">" +
"<head>" +
"<meta charset=\"UTF-8\">" +
"<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">" +
"<title>TV Sul Capixaba — Programação</title>" +
"<style>" +
"  * { box-sizing: border-box; margin: 0; padding: 0; }" +
"" +
"  :root {" +
"    --bg: #05060a;" +
"    --panel: #0d0f16;" +
"    --panel-2: #12141c;" +
"    --panel-3: #171a24;" +
"    --border: #1c1f2a;" +
"    --text: #f2f3f5;" +
"    --text-dim: #9a9fad;" +
"    --text-faint: #5b606e;" +
"    --accent: #e2543a;" +
"    --accent-dim: rgba(226,84,58,0.14);" +
"    --blue: #3b6fe0;" +
"    --blue-dim: rgba(59,111,224,0.14);" +
"    --live: #3ecf6a;" +
"    --live-dim: rgba(62,207,106,0.14);" +
"    --amber: #f0c14b;" +
"    --radius: 12px;" +
"    --radius-sm: 8px;" +
"  }" +
"" +
"  html, body {" +
"    background: var(--bg);" +
"    color: var(--text);" +
"    font-family: -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, Arial, sans-serif;" +
"    font-variant-numeric: tabular-nums;" +
"    -webkit-font-smoothing: antialiased;" +
"  }" +
"" +
"  body { display: flex; min-height: 100vh; }" +
"" +
"  a { color: inherit; text-decoration: none; }" +
"  button { font-family: inherit; }" +
"" +
"  /* ================= Sidebar ================= */" +
"  .sidebar {" +
"    width: 248px;" +
"    flex-shrink: 0;" +
"    background: var(--panel);" +
"    border-right: 1px solid var(--border);" +
"    display: flex;" +
"    flex-direction: column;" +
"    position: sticky;" +
"    top: 0;" +
"    height: 100vh;" +
"    overflow-y: auto;" +
"    transition: transform .25s ease;" +
"    z-index: 40;" +
"  }" +
"" +
"  .sidebar-logo {" +
"    display: flex;" +
"    align-items: center;" +
"    gap: 10px;" +
"    padding: 22px 22px 20px;" +
"  }" +
"  .sidebar-logo .mark {" +
"    width: 30px; height: 30px;" +
"    border-radius: 8px;" +
"    background: linear-gradient(135deg, var(--accent), #ff8a65);" +
"    display: flex; align-items: center; justify-content: center;" +
"    font-size: 15px;" +
"    flex-shrink: 0;" +
"  }" +
"  .sidebar-logo .word {" +
"    font-size: 15px;" +
"    font-weight: 700;" +
"    letter-spacing: .01em;" +
"    line-height: 1.15;" +
"  }" +
"  .sidebar-logo .word small {" +
"    display: block;" +
"    font-size: 10px;" +
"    font-weight: 500;" +
"    color: var(--text-faint);" +
"    letter-spacing: .12em;" +
"    text-transform: uppercase;" +
"    margin-top: 2px;" +
"  }" +
"" +
"  .nav-scroll { padding: 4px 12px 24px; }" +
"" +
"  .nav-group { margin-top: 18px; }" +
"  .nav-group:first-child { margin-top: 4px; }" +
"  .nav-group-label {" +
"    font-size: 10.5px;" +
"    font-weight: 700;" +
"    letter-spacing: .1em;" +
"    text-transform: uppercase;" +
"    color: var(--text-faint);" +
"    padding: 0 10px 8px;" +
"  }" +
"" +
"  .nav-item {" +
"    display: flex;" +
"    align-items: center;" +
"    gap: 11px;" +
"    padding: 9px 10px;" +
"    border-radius: var(--radius-sm);" +
"    font-size: 13.5px;" +
"    color: var(--text-dim);" +
"    cursor: pointer;" +
"    margin-bottom: 1px;" +
"  }" +
"  .nav-item .ic { width: 17px; text-align: center; font-size: 14px; opacity: .85; }" +
"  .nav-item:hover { background: var(--panel-3); color: var(--text); }" +
"  .nav-item.active {" +
"    background: var(--panel-3);" +
"    color: var(--text);" +
"    box-shadow: inset 2px 0 0 var(--accent);" +
"  }" +
"" +
"  .sidebar-foot {" +
"    margin-top: auto;" +
"    padding: 16px 22px 22px;" +
"    border-top: 1px solid var(--border);" +
"    font-size: 11.5px;" +
"    color: var(--text-faint);" +
"  }" +
"  .sidebar-foot .dot { color: var(--live); }" +
"" +
"  .sidebar-toggle {" +
"    display: none;" +
"  }" +
"" +
"  /* ================= Controles reais do motor (reaproveitam .btn/.btn-ghost) ================= */" +
"  .engine-controls { display: flex; gap: 8px; margin-top: 2px; }" +
"  .engine-controls .btn.is-active { background: var(--accent); color: #fff; border-color: transparent; }" +
"  #previewVideo { display: none; width: 100%; height: 100%; object-fit: cover; }" +
"" +
"" +
"  /* ================= Main ================= */" +
"  main { flex: 1; min-width: 0; padding: 30px 36px 60px; }" +
"" +
"  .topbar { display: none; }" +
"" +
"  .page-header {" +
"    display: flex;" +
"    align-items: flex-start;" +
"    gap: 14px;" +
"    margin-bottom: 26px;" +
"  }" +
"  .back-btn {" +
"    all: unset; cursor: pointer;" +
"    width: 34px; height: 34px;" +
"    border-radius: 50%;" +
"    background: var(--panel-2);" +
"    border: 1px solid var(--border);" +
"    display: flex; align-items: center; justify-content: center;" +
"    color: var(--text-dim);" +
"    font-size: 16px;" +
"    flex-shrink: 0;" +
"  }" +
"  .back-btn:hover { color: var(--text); }" +
"" +
"  .page-header h1 {" +
"    font-size: 21px;" +
"    font-weight: 800;" +
"    letter-spacing: .01em;" +
"    display: flex;" +
"    align-items: baseline;" +
"    gap: 8px;" +
"    flex-wrap: wrap;" +
"  }" +
"  .page-header h1 .sub { font-weight: 600; color: var(--text-dim); font-size: 15px; }" +
"" +
"  .badges { display: flex; gap: 8px; margin-top: 9px; }" +
"  .badge {" +
"    font-size: 11px;" +
"    font-weight: 700;" +
"    padding: 4px 9px;" +
"    border-radius: 999px;" +
"    background: var(--panel-3);" +
"    border: 1px solid var(--border);" +
"    color: var(--text-dim);" +
"  }" +
"" +
"  .header-spacer { flex: 1; }" +
"  .header-actions { display: flex; gap: 10px; align-items: center; }" +
"" +
"  /* ================= Buttons ================= */" +
"  .btn {" +
"    all: unset; cursor: pointer; box-sizing: border-box;" +
"    font-size: 13px; font-weight: 700;" +
"    padding: 10px 16px;" +
"    border-radius: var(--radius-sm);" +
"    display: inline-flex; align-items: center; gap: 7px;" +
"    white-space: nowrap;" +
"  }" +
"  .btn-primary { background: var(--accent); color: #fff; }" +
"  .btn-primary:hover { background: #ef6146; }" +
"  .btn-ghost { background: var(--panel-3); color: var(--text); border: 1px solid var(--border); }" +
"  .btn-ghost:hover { border-color: #333747; }" +
"  .icon-btn {" +
"    all: unset; cursor: pointer;" +
"    width: 34px; height: 34px;" +
"    border-radius: var(--radius-sm);" +
"    background: var(--panel-3);" +
"    border: 1px solid var(--border);" +
"    display: flex; align-items: center; justify-content: center;" +
"    color: var(--text-dim);" +
"  }" +
"  .icon-btn.danger:hover { color: var(--accent); border-color: rgba(226,84,58,.4); }" +
"  .link-btn {" +
"    all: unset; cursor: pointer;" +
"    font-size: 13px; font-weight: 700;" +
"    color: var(--text-dim);" +
"  }" +
"  .link-btn.danger { color: var(--accent); }" +
"  .link-btn.danger:hover { text-decoration: underline; }" +
"" +
"  /* ================= Hero row ================= */" +
"  .hero {" +
"    display: grid;" +
"    grid-template-columns: 1.15fr 1fr 1fr;" +
"    gap: 16px;" +
"    margin-bottom: 18px;" +
"  }" +
"" +
"  .preview {" +
"    background: #000;" +
"    border-radius: var(--radius);" +
"    border: 1px solid var(--border);" +
"    aspect-ratio: 16/9;" +
"    position: relative;" +
"    overflow: hidden;" +
"  }" +
"  .preview-frame {" +
"    position: absolute; inset: 0;" +
"    background:" +
"      radial-gradient(circle at 30% 20%, rgba(226,84,58,.25), transparent 55%)," +
"      radial-gradient(circle at 75% 80%, rgba(59,111,224,.22), transparent 55%)," +
"      #0a0b10;" +
"    display: flex; align-items: center; justify-content: center;" +
"  }" +
"  .preview-frame .glyph {" +
"    width: 54px; height: 54px;" +
"    border-radius: 50%;" +
"    border: 1.5px solid rgba(255,255,255,.35);" +
"    display: flex; align-items: center; justify-content: center;" +
"    color: rgba(255,255,255,.75);" +
"    font-size: 18px;" +
"  }" +
"  .preview-controls {" +
"    position: absolute; left: 0; right: 0; bottom: 0;" +
"    padding: 10px 12px;" +
"    display: flex; align-items: center; gap: 14px;" +
"    background: linear-gradient(transparent, rgba(0,0,0,.55));" +
"    color: #fff;" +
"    font-size: 14px;" +
"  }" +
"  .preview-controls span:last-child { margin-left: auto; }" +
"" +
"  .card {" +
"    background: var(--panel);" +
"    border: 1px solid var(--border);" +
"    border-radius: var(--radius);" +
"    padding: 18px 18px 16px;" +
"    display: flex;" +
"    flex-direction: column;" +
"  }" +
"  .card.now-playing { border-left: 2.5px solid var(--live); }" +
"  .card.up-next { border-left: 2.5px solid var(--text-faint); }" +
"" +
"  .eyebrow {" +
"    display: flex; align-items: center; gap: 7px;" +
"    font-size: 11px; font-weight: 800; letter-spacing: .09em;" +
"    color: var(--text-faint);" +
"    margin-bottom: 10px;" +
"  }" +
"  .eyebrow.live-color { color: var(--live); }" +
"" +
"  .dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; flex-shrink: 0; }" +
"  .dot.pulsing { animation: pulse 1.8s ease-in-out infinite; }" +
"  @media (prefers-reduced-motion: reduce) { .dot.pulsing { animation: none; } }" +
"  @keyframes pulse {" +
"    0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(62,207,106,.5); }" +
"    50% { opacity: .55; box-shadow: 0 0 0 5px rgba(62,207,106,0); }" +
"  }" +
"" +
"  .card h3, .card h4 {" +
"    font-size: 15px; font-weight: 700; line-height: 1.35;" +
"    margin-bottom: 8px;" +
"  }" +
"  .time-range { font-size: 12.5px; color: var(--text-dim); margin-bottom: 12px; }" +
"" +
"  .progress {" +
"    height: 5px; border-radius: 999px;" +
"    background: var(--panel-3);" +
"    overflow: hidden; margin-bottom: 8px;" +
"  }" +
"  .progress-fill { height: 100%; background: var(--live); border-radius: 999px; }" +
"  .progress-labels {" +
"    display: flex; justify-content: space-between;" +
"    font-size: 11.5px; color: var(--text-faint);" +
"  }" +
"" +
"  .starts-in {" +
"    font-size: 12.5px; color: var(--text-dim);" +
"    margin-top: auto; margin-bottom: 12px;" +
"  }" +
"  .starts-in strong { color: var(--text); font-weight: 700; }" +
"" +
"  .card .pill-btn {" +
"    all: unset; cursor: pointer; align-self: flex-start;" +
"    font-size: 12px; font-weight: 700;" +
"    padding: 7px 13px;" +
"    border-radius: 999px;" +
"    background: var(--panel-3);" +
"    border: 1px solid var(--border);" +
"    color: var(--text-dim);" +
"  }" +
"  .card .pill-btn:hover { color: var(--text); border-color: #333747; }" +
"" +
"  .items-count { font-size: 12px; color: var(--text-faint); margin-bottom: 22px; }" +
"" +
"  /* ================= Tabs ================= */" +
"  .tabs {" +
"    display: flex; gap: 4px;" +
"    border-bottom: 1px solid var(--border);" +
"    margin-bottom: 22px;" +
"  }" +
"  .tab {" +
"    all: unset; cursor: pointer;" +
"    padding: 10px 4px; margin-right: 22px;" +
"    font-size: 14px; font-weight: 700; color: var(--text-faint);" +
"    display: flex; align-items: center; gap: 8px;" +
"    border-bottom: 2px solid transparent;" +
"    position: relative; top: 1px;" +
"  }" +
"  .tab .tab-count {" +
"    font-size: 11px; font-weight: 800;" +
"    background: var(--panel-3);" +
"    color: var(--text-dim);" +
"    padding: 1px 7px;" +
"    border-radius: 999px;" +
"  }" +
"  .tab.active { color: var(--text); border-bottom-color: var(--accent); }" +
"  .tab.active .tab-count { background: var(--accent-dim); color: var(--accent); }" +
"  .tab:hover:not(.active) { color: var(--text-dim); }" +
"" +
"  .tab-panel { display: none; }" +
"  .tab-panel.active { display: block; }" +
"" +
"  /* ================= Control bar ================= */" +
"  .control-bar {" +
"    display: flex;" +
"    align-items: flex-end;" +
"    gap: 22px;" +
"    flex-wrap: wrap;" +
"    background: var(--panel);" +
"    border: 1px solid var(--border);" +
"    border-radius: var(--radius);" +
"    padding: 18px 20px;" +
"    margin-bottom: 14px;" +
"  }" +
"  .control-group { display: flex; flex-direction: column; gap: 8px; }" +
"  .control-group label {" +
"    font-size: 11.5px; font-weight: 700; color: var(--text-faint);" +
"    letter-spacing: .02em;" +
"  }" +
"" +
"  .segmented {" +
"    display: flex; background: var(--panel-3);" +
"    border: 1px solid var(--border);" +
"    border-radius: var(--radius-sm);" +
"    padding: 3px;" +
"  }" +
"  .segmented-btn {" +
"    all: unset; cursor: pointer;" +
"    font-size: 12.5px; font-weight: 700;" +
"    color: var(--text-dim);" +
"    padding: 7px 13px;" +
"    border-radius: 6px;" +
"    display: flex; align-items: center; gap: 6px;" +
"  }" +
"  .segmented-btn.active { background: var(--panel); color: var(--text); }" +
"" +
"  .input-like {" +
"    display: flex; align-items: center; gap: 9px;" +
"    font-size: 13px; color: var(--text);" +
"    background: var(--panel-3);" +
"    border: 1px solid var(--border);" +
"    border-radius: var(--radius-sm);" +
"    padding: 9px 12px;" +
"    min-width: 210px;" +
"    cursor: pointer;" +
"  }" +
"  .input-like .chev { margin-left: auto; color: var(--text-faint); font-size: 11px; }" +
"  .input-like:hover { border-color: #333747; }" +
"" +
"  .control-bar .btn-primary { margin-left: auto; }" +
"" +
"  .live-banner {" +
"    display: flex; align-items: center; gap: 12px;" +
"    background: var(--live-dim);" +
"    border: 1px solid rgba(62,207,106,.28);" +
"    border-radius: var(--radius-sm);" +
"    padding: 11px 16px;" +
"    font-size: 12.5px;" +
"    color: var(--text-dim);" +
"    margin-bottom: 26px;" +
"  }" +
"  .live-pill {" +
"    display: flex; align-items: center; gap: 6px;" +
"    font-size: 11px; font-weight: 800; letter-spacing: .05em;" +
"    color: var(--live);" +
"    flex-shrink: 0;" +
"  }" +
"" +
"  /* ================= Schedule list header ================= */" +
"  .list-header {" +
"    display: flex; align-items: flex-end; justify-content: space-between;" +
"    gap: 16px; flex-wrap: wrap;" +
"    margin-bottom: 16px;" +
"  }" +
"  .list-header h2 { font-size: 16px; font-weight: 800; margin-bottom: 4px; }" +
"  .list-meta { font-size: 12px; color: var(--text-faint); }" +
"  .list-actions { display: flex; align-items: center; gap: 14px; }" +
"" +
"  /* ================= Table ================= */" +
"  .table-wrap {" +
"    background: var(--panel);" +
"    border: 1px solid var(--border);" +
"    border-radius: var(--radius);" +
"    overflow: hidden;" +
"  }" +
"  .table-scroll { overflow-x: auto; }" +
"  table.schedule-table { width: 100%; border-collapse: collapse; min-width: 640px; }" +
"  .schedule-table thead th {" +
"    text-align: left;" +
"    font-size: 11px; font-weight: 800; letter-spacing: .07em; text-transform: uppercase;" +
"    color: var(--text-faint);" +
"    padding: 13px 18px;" +
"    background: var(--panel-2);" +
"    border-bottom: 1px solid var(--border);" +
"  }" +
"  .schedule-table td {" +
"    padding: 13px 18px;" +
"    font-size: 13.5px;" +
"    border-bottom: 1px solid var(--border);" +
"    color: var(--text);" +
"    vertical-align: middle;" +
"  }" +
"  .schedule-table tbody tr:last-child td { border-bottom: none; }" +
"  .schedule-table tbody tr:not(.date-row):hover { background: var(--panel-2); }" +
"  .empty-row { color: var(--text-faint); text-align: center; padding: 24px !important; }" +
"" +
"  .date-row td {" +
"    background: var(--panel-3);" +
"    color: var(--text-faint);" +
"    font-size: 11.5px; font-weight: 800; letter-spacing: .05em; text-transform: uppercase;" +
"    padding: 9px 18px;" +
"  }" +
"" +
"  .drag { color: var(--text-faint); white-space: nowrap; width: 1%; }" +
"  .source-cell { display: flex; align-items: center; gap: 10px; }" +
"  .source-cell .file-ic {" +
"    width: 26px; height: 26px; border-radius: 6px; flex-shrink: 0;" +
"    background: var(--panel-3); border: 1px solid var(--border);" +
"    display: flex; align-items: center; justify-content: center; font-size: 12px;" +
"  }" +
"  .source-cell .name-wrap { min-width: 0; }" +
"  .source-cell .name { font-weight: 600; }" +
"  .source-cell .name.break-name { color: var(--text-dim); font-style: italic; font-weight: 500; }" +
"" +
"  .mono { font-variant-numeric: tabular-nums; color: var(--text-dim); }" +
"  .row-actions { text-align: right; white-space: nowrap; }" +
"  .row-actions button {" +
"    all: unset; cursor: pointer; color: var(--text-faint);" +
"    padding: 4px 6px; border-radius: 6px;" +
"  }" +
"  .row-actions button:hover { color: var(--accent); background: var(--accent-dim); }" +
"" +
"  .table-more {" +
"    text-align: center;" +
"    padding: 14px;" +
"    font-size: 12.5px;" +
"    color: var(--text-faint);" +
"    background: var(--panel-2);" +
"  }" +
"" +
"  /* ================= Files tab (empty) ================= */" +
"  .files-empty {" +
"    background: var(--panel);" +
"    border: 1px dashed var(--border);" +
"    border-radius: var(--radius);" +
"    padding: 60px 24px;" +
"    text-align: center;" +
"    color: var(--text-faint);" +
"    font-size: 13.5px;" +
"  }" +
"  .files-empty .big-ic { font-size: 26px; margin-bottom: 10px; }" +
"" +
"  /* ================= Responsive ================= */" +
"  @media (max-width: 980px) {" +
"    .hero { grid-template-columns: 1fr; }" +
"  }" +
"" +
"  @media (max-width: 760px) {" +
"    body { flex-direction: column; }" +
"" +
"    .sidebar {" +
"      position: fixed; left: 0; top: 0; bottom: 0;" +
"      transform: translateX(-100%);" +
"      box-shadow: 24px 0 40px rgba(0,0,0,.5);" +
"    }" +
"    .sidebar.open { transform: translateX(0); }" +
"" +
"    .topbar {" +
"      display: flex; align-items: center; gap: 12px;" +
"      padding: 14px 18px;" +
"      border-bottom: 1px solid var(--border);" +
"      position: sticky; top: 0; z-index: 30;" +
"      background: var(--bg);" +
"    }" +
"    .topbar .mark {" +
"      width: 26px; height: 26px; border-radius: 7px;" +
"      background: linear-gradient(135deg, var(--accent), #ff8a65);" +
"      display: flex; align-items: center; justify-content: center; font-size: 13px;" +
"    }" +
"    .topbar .word { font-size: 14px; font-weight: 800; }" +
"    .sidebar-toggle {" +
"      all: unset; display: flex; cursor: pointer;" +
"      margin-left: auto;" +
"      width: 32px; height: 32px; border-radius: 8px;" +
"      background: var(--panel-2); border: 1px solid var(--border);" +
"      align-items: center; justify-content: center;" +
"      color: var(--text-dim); font-size: 15px;" +
"    }" +
"    .scrim {" +
"      display: none;" +
"      position: fixed; inset: 0; background: rgba(0,0,0,.5); z-index: 39;" +
"    }" +
"    .scrim.show { display: block; }" +
"" +
"    main { padding: 20px 16px 48px; }" +
"    .control-bar { flex-direction: column; align-items: stretch; }" +
"    .control-bar .btn-primary { margin-left: 0; }" +
"    .input-like { min-width: 0; }" +
"    .list-header { flex-direction: column; align-items: stretch; }" +
"    .list-actions { justify-content: space-between; }" +
"  }" +
"</style>" +
"</head>" +
"<body>" +
"" +
"  <div class=\"scrim\" id=\"scrim\"></div>" +
"" +
"  <aside class=\"sidebar\" id=\"sidebar\">" +
"    <div class=\"sidebar-logo\">" +
"      <div class=\"mark\">📡</div>" +
"      <div class=\"word\">TV Sul Capixaba<small>Painel de Playout</small></div>" +
"    </div>" +
"" +
"    <div class=\"nav-scroll\">" +
"      <div class=\"nav-group\">" +
"        <div class=\"nav-group-label\">Transmissão</div>" +
"        <a class=\"nav-item\"><span class=\"ic\">▦</span>Dashboard</a>" +
"        <a class=\"nav-item active\"><span class=\"ic\">◷</span>Programação</a>" +
"        <a class=\"nav-item\"><span class=\"ic\">☍</span>Eventos</a>" +
"      </div>" +
"      <div class=\"nav-group\">" +
"        <div class=\"nav-group-label\">Conteúdo</div>" +
"        <a class=\"nav-item\"><span class=\"ic\">⇧</span>Arquivos</a>" +
"        <a class=\"nav-item\"><span class=\"ic\">▤</span>Biblioteca</a>" +
"      </div>" +
"      <div class=\"nav-group\">" +
"        <div class=\"nav-group-label\">Sistema</div>" +
"        <a class=\"nav-item\"><span class=\"ic\">⚙</span>Configurações</a>" +
"        <a class=\"nav-item\"><span class=\"ic\">≣</span>Logs</a>" +
"      </div>" +
"    </div>" +
"" +
"    <div class=\"sidebar-foot\"><span class=\"dot\">●</span>&nbsp; No ar — canal principal</div>" +
"  </aside>" +
"" +
"  <main>" +
"    <div class=\"topbar\">" +
"      <div class=\"mark\">📡</div>" +
"      <div class=\"word\">TV Sul Capixaba</div>" +
"      <button class=\"sidebar-toggle\" id=\"menuToggle\">☰</button>" +
"    </div>" +
"" +
"    <header class=\"page-header\">" +
"      <button class=\"back-btn\">‹</button>" +
"      <div>" +
"        <h1>Programação <span class=\"sub\">— Canal Principal</span></h1>" +
"        <div class=\"badges\"><span class=\"badge\">720p</span><span class=\"badge\">30 fps</span></div>" +
"      </div>" +
"      <div class=\"header-spacer\"></div>" +
"      <div class=\"header-actions\">" +
"        <button class=\"btn btn-ghost\">Desativar canal</button>" +
"        <button class=\"icon-btn danger\">🗑</button>" +
"      </div>" +
"    </header>" +
"" +
"    <section class=\"hero\">" +
"      <div class=\"preview\">" +
"        <div class=\"preview-frame\" id=\"previewGlyph\">" +
"          <div class=\"glyph\">▶</div>" +
"        </div>" +
"        <video id=\"previewVideo\" muted loop playsinline></video>" +
"        <div class=\"preview-controls\">" +
"          <span>■</span><span>🔊</span><span>⛶</span>" +
"        </div>" +
"      </div>" +
"" +
"      <div class=\"card now-playing\">" +
"        <div class=\"eyebrow live-color\"><span class=\"dot\" id=\"nowPlayingDot\"></span>TOCANDO AGORA</div>" +
"        <h3 id=\"nowPlayingTitle\">Transmissão parada</h3>" +
"        <div class=\"time-range\" id=\"nowPlayingRange\"></div>" +
"        <div class=\"progress\"><div class=\"progress-fill\" id=\"nowPlayingFill\" style=\"width:0%\"></div></div>" +
"        <div class=\"progress-labels\"><span id=\"nowPlayingElapsed\">00:00:00</span><span id=\"nowPlayingRemaining\">00:00:00</span></div>" +
"        <div class=\"engine-controls\">" +
"          <button class=\"btn btn-ghost\" id=\"btnIniciar\">▶ Iniciar</button>" +
"          <button class=\"btn btn-ghost\" id=\"btnParar\">■ Parar</button>" +
"          <button class=\"btn btn-ghost\" id=\"btnReiniciar\">↻ Reiniciar</button>" +
"        </div>" +
"      </div>" +
"" +
"      <div class=\"card up-next\">" +
"        <div class=\"eyebrow\">A SEGUIR</div>" +
"        <h4 id=\"upNextTitle\">—</h4>" +
"        <div class=\"time-range\" id=\"upNextRange\"></div>" +
"        <div class=\"starts-in\">Começa em <strong id=\"upNextStartsIn\">—</strong></div>" +
"        <button class=\"pill-btn\">Ver programação</button>" +
"      </div>" +
"    </section>" +
"" +
"    <div class=\"items-count\" id=\"itemsCount\">0 itens na fila</div>" +
"" +
"    <nav class=\"tabs\">" +
"      <button class=\"tab active\" data-tab=\"schedule\">Programação <span class=\"tab-count\" id=\"tabCountSchedule\">0</span></button>" +
"      <button class=\"tab\" data-tab=\"files\">Arquivos <span class=\"tab-count\" id=\"tabCountFiles\">0</span></button>" +
"    </nav>" +
"" +
"    <section class=\"tab-panel active\" id=\"tab-schedule\">" +
"      <div class=\"control-bar\">" +
"        <div class=\"control-group\">" +
"          <label>Modo de reprodução</label>" +
"          <div class=\"segmented\">" +
"            <button class=\"segmented-btn active\" data-mode=\"schedule\">🕐 Programação</button>" +
"            <button class=\"segmented-btn\" data-mode=\"loop\">🔁 Loop</button>" +
"          </div>" +
"        </div>" +
"        <div class=\"control-group\">" +
"          <label>Início</label>" +
"          <div class=\"input-like\">📅 20/07/2026 16:29<span class=\"chev\">⌄</span></div>" +
"        </div>" +
"        <div class=\"control-group\">" +
"          <label>Destino de saída</label>" +
"          <div class=\"input-like\">📹 TV Sul Capixaba — Principal<span class=\"chev\">⌄</span></div>" +
"        </div>" +
"        <button class=\"btn btn-primary\">📡 Atualizar programação</button>" +
"      </div>" +
"" +
"      <div class=\"live-banner\">" +
"        <span class=\"live-pill\"><span class=\"dot\" id=\"liveBannerDot\"></span><span id=\"liveBannerLabel\">FORA DO AR</span></span>" +
"        O modo Programação toca cada fonte no horário exato definido. <span id=\"liveBannerCount\">Nenhum item cadastrado.</span>" +
"      </div>" +
"" +
"      <div class=\"list-header\">" +
"        <div>" +
"          <h2>Lista de programação</h2>" +
"          <span class=\"list-meta\" id=\"listMeta\">0 itens</span>" +
"        </div>" +
"        <div class=\"list-actions\">" +
"          <button class=\"link-btn danger\">Remover todos</button>" +
"          <button class=\"btn btn-ghost\">Adicionar intervalo</button>" +
"          <button class=\"btn btn-primary\">＋ Adicionar fonte</button>" +
"        </div>" +
"      </div>" +
"" +
"      <div class=\"table-wrap\">" +
"        <div class=\"table-scroll\">" +
"          <table class=\"schedule-table\">" +
"            <thead>" +
"              <tr><th>#</th><th>Fonte</th><th>Início</th><th>Duração</th><th></th></tr>" +
"            </thead>" +
"            <tbody id=\"scheduleTbody\">" +
"              <tr><td colspan=\"5\" class=\"empty-row\">Carregando programação...</td></tr>" +
"            </tbody>" +
"          </table>" +
"        </div>" +
"      </div>" +
"    </section>" +
"" +
"    <section class=\"tab-panel\" id=\"tab-files\">" +
"      <div class=\"files-empty\" id=\"filesEmpty\">" +
"        <div class=\"big-ic\">⇧</div>" +
"        Nenhum arquivo enviado ainda.<br>" +
"        Envie vídeos pela aba Arquivos para disponibilizá-los aqui." +
"      </div>" +
"    </section>" +
"  </main>" +
"" +
"<script>" +
"  // Alternância de abas Programação / Arquivos (apenas UI)" +
"  document.querySelectorAll('.tab').forEach(function (tab) {" +
"    tab.addEventListener('click', function () {" +
"      document.querySelectorAll('.tab').forEach(function (t) { t.classList.remove('active'); });" +
"      document.querySelectorAll('.tab-panel').forEach(function (p) { p.classList.remove('active'); });" +
"      tab.classList.add('active');" +
"      document.getElementById('tab-' + tab.getAttribute('data-tab')).classList.add('active');" +
"    });" +
"  });" +
"" +
"  // Alternância do modo de reprodução (Programação / Loop) — apenas estado visual," +
"  // não existe esse conceito no motor real ainda." +
"  document.querySelectorAll('.segmented-btn').forEach(function (btn) {" +
"    btn.addEventListener('click', function () {" +
"      document.querySelectorAll('.segmented-btn').forEach(function (b) { b.classList.remove('active'); });" +
"      btn.classList.add('active');" +
"    });" +
"  });" +
"" +
"  // Menu lateral em telas estreitas" +
"  var sidebar = document.getElementById('sidebar');" +
"  var scrim = document.getElementById('scrim');" +
"  var toggle = document.getElementById('menuToggle');" +
"  function closeMenu() { sidebar.classList.remove('open'); scrim.classList.remove('show'); }" +
"  toggle.addEventListener('click', function () {" +
"    sidebar.classList.add('open');" +
"    scrim.classList.add('show');" +
"  });" +
"  scrim.addEventListener('click', closeMenu);" +
"  document.querySelectorAll('.sidebar .nav-item').forEach(function (item) {" +
"    item.addEventListener('click', closeMenu);" +
"  });" +
"" +
"  // ===================================================================" +
"  // Integração real com a API do painel (sem inventar endpoints novos)" +
"  // ===================================================================" +
"  function escapeHtml(s) {" +
"    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;');" +
"  }" +
"  function apiGet(url) { return fetch(url).then(function (r) { return r.json(); }); }" +
"  function apiSend(url, method, body) {" +
"    return fetch(url, { method: method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })" +
"      .then(function (r) { return r.json().then(function (data) { if (!r.ok) throw new Error(data.error || 'Erro'); return data; }); });" +
"  }" +
"  function pad2(n) { return String(n).padStart(2, '0'); }" +
"  function secondsToClock(sec) {" +
"    sec = Math.max(0, Math.round(sec));" +
"    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;" +
"    return pad2(h) + ':' + pad2(m) + ':' + pad2(s);" +
"  }" +
"  function timeToMinutes(hhmm) {" +
"    var parts = (hhmm || '00:00').split(':');" +
"    return (parseInt(parts[0], 10) || 0) * 60 + (parseInt(parts[1], 10) || 0);" +
"  }" +
"  function minutesToDurationLabel(mins) {" +
"    var h = Math.floor(mins / 60), m = Math.round(mins % 60);" +
"    return pad2(h) + 'h' + pad2(m) + 'min';" +
"  }" +
"" +
"  var videosById = {};" +
"  var scheduleList = [];" +
"  var lastPreviewSrc = null;" +
"" +
"  function loadReferenceData() {" +
"    return Promise.all([apiGet('/api/videos'), apiGet('/api/schedule')]).then(function (res) {" +
"      videosById = {};" +
"      res[0].forEach(function (v) { videosById[v.id] = v; });" +
"      scheduleList = res[1].slice().sort(function (a, b) { return timeToMinutes(a.startTime) - timeToMinutes(b.startTime); });" +
"" +
"      document.getElementById('tabCountSchedule').textContent = scheduleList.length;" +
"      document.getElementById('tabCountFiles').textContent = res[0].length;" +
"      document.getElementById('itemsCount').textContent = scheduleList.length + ' itens na fila';" +
"      document.getElementById('listMeta').textContent = scheduleList.length + ' itens cadastrados';" +
"      document.getElementById('liveBannerCount').textContent = scheduleList.length" +
"        ? 'Programação com ' + scheduleList.length + ' item(ns) cadastrado(s).'" +
"        : 'Nenhum item cadastrado ainda em Programação.';" +
"" +
"      renderScheduleTable();" +
"    });" +
"  }" +
"" +
"  function renderScheduleTable() {" +
"    var tbody = document.getElementById('scheduleTbody');" +
"    if (!scheduleList.length) {" +
"      tbody.innerHTML = '<tr><td colspan=\"5\" class=\"empty-row\">Nenhum item de programação cadastrado ainda.</td></tr>';" +
"      return;" +
"    }" +
"    var rows = '';" +
"    scheduleList.forEach(function (entry, i) {" +
"      var next = scheduleList[(i + 1) % scheduleList.length];" +
"      var startMin = timeToMinutes(entry.startTime);" +
"      var nextMin = timeToMinutes(next.startTime);" +
"      var durMin = nextMin - startMin; if (durMin <= 0) durMin += 1440;" +
"      var video = videosById[entry.videoId];" +
"      var name = video ? video.originalName : '(vídeo removido)';" +
"      rows += '<tr>'" +
"        + '<td class=\"drag\">≡ ' + (i + 1) + '</td>'" +
"        + '<td class=\"source-cell\"><span class=\"file-ic\">🎬</span><span class=\"name-wrap\"><span class=\"name\">' + escapeHtml(name) + '</span></span></td>'" +
"        + '<td>' + entry.startTime + ' (todos os dias)</td>'" +
"        + '<td class=\"mono\">' + minutesToDurationLabel(durMin) + '</td>'" +
"        + '<td class=\"row-actions\"><button disabled title=\"Gerenciar pela aba Programação\">🗑</button></td>'" +
"        + '</tr>';" +
"    });" +
"    tbody.innerHTML = rows;" +
"  }" +
"" +
"  function findCurrentAndNextEntry(nowMinutes) {" +
"    var sorted = scheduleList;" +
"    var current = sorted[sorted.length - 1];" +
"    var currentIdx = sorted.length - 1;" +
"    for (var i = 0; i < sorted.length; i++) {" +
"      if (timeToMinutes(sorted[i].startTime) <= nowMinutes) { current = sorted[i]; currentIdx = i; }" +
"    }" +
"    var next = sorted[(currentIdx + 1) % sorted.length];" +
"    return { current: current, next: next };" +
"  }" +
"" +
"  function refreshStatus() {" +
"    apiGet('/api/status').then(function (s) {" +
"      var dot = document.getElementById('nowPlayingDot');" +
"      var titleEl = document.getElementById('nowPlayingTitle');" +
"      var rangeEl = document.getElementById('nowPlayingRange');" +
"      var fillEl = document.getElementById('nowPlayingFill');" +
"      var elapsedEl = document.getElementById('nowPlayingElapsed');" +
"      var remainingEl = document.getElementById('nowPlayingRemaining');" +
"      var nextTitleEl = document.getElementById('upNextTitle');" +
"      var nextRangeEl = document.getElementById('upNextRange');" +
"      var nextStartsInEl = document.getElementById('upNextStartsIn');" +
"      var previewVideo = document.getElementById('previewVideo');" +
"      var previewGlyph = document.getElementById('previewGlyph');" +
"      var liveDot = document.getElementById('liveBannerDot');" +
"      var liveLabel = document.getElementById('liveBannerLabel');" +
"" +
"      dot.classList.toggle('pulsing', !!s.running);" +
"      liveDot.classList.toggle('pulsing', !!s.running);" +
"      liveLabel.textContent = s.running ? 'NO AR' : 'FORA DO AR';" +
"" +
"      document.getElementById('btnIniciar').classList.toggle('is-active', !!s.running);" +
"      document.getElementById('btnParar').classList.toggle('is-active', !s.running);" +
"" +
"      if (!s.running || !scheduleList.length) {" +
"        titleEl.textContent = s.running ? 'Nenhum item agendado' : 'Transmissão parada';" +
"        rangeEl.textContent = '';" +
"        fillEl.style.width = '0%';" +
"        elapsedEl.textContent = '00:00:00';" +
"        remainingEl.textContent = '00:00:00';" +
"        nextTitleEl.textContent = '—';" +
"        nextRangeEl.textContent = '';" +
"        nextStartsInEl.textContent = '—';" +
"        previewVideo.style.display = 'none';" +
"        previewGlyph.style.display = 'flex';" +
"        previewVideo.pause();" +
"        return;" +
"      }" +
"" +
"      var now = new Date();" +
"      var nowMinutes = now.getHours() * 60 + now.getMinutes();" +
"      var nowSeconds = nowMinutes * 60 + now.getSeconds();" +
"      var found = findCurrentAndNextEntry(nowMinutes);" +
"" +
"      if (found.current) {" +
"        var startSec = timeToMinutes(found.current.startTime) * 60;" +
"        var nextSec = timeToMinutes(found.next.startTime) * 60;" +
"        var totalSec = nextSec - startSec; if (totalSec <= 0) totalSec += 86400;" +
"        var elapsedSec = nowSeconds - startSec; if (elapsedSec < 0) elapsedSec += 86400;" +
"        elapsedSec = Math.min(elapsedSec, totalSec);" +
"        var remainingSec = Math.max(0, totalSec - elapsedSec);" +
"" +
"        var video = videosById[found.current.videoId];" +
"        titleEl.textContent = video ? video.originalName : (s.nowPlaying !== '—' ? s.nowPlaying : '(vídeo removido)');" +
"        rangeEl.textContent = found.current.startTime + ' – ' + found.next.startTime;" +
"        fillEl.style.width = Math.min(100, (elapsedSec / totalSec * 100)) + '%';" +
"        elapsedEl.textContent = secondsToClock(elapsedSec);" +
"        remainingEl.textContent = secondsToClock(remainingSec);" +
"" +
"        var nextVideo = videosById[found.next.videoId];" +
"        nextTitleEl.textContent = nextVideo ? nextVideo.originalName : '(vídeo removido)';" +
"        nextRangeEl.textContent = found.next.startTime;" +
"        var startsInSec = nextSec - nowSeconds; if (startsInSec < 0) startsInSec += 86400;" +
"        nextStartsInEl.textContent = secondsToClock(startsInSec);" +
"" +
"        if (video) {" +
"          var mediaUrl = '/media/' + video.id;" +
"          if (lastPreviewSrc !== mediaUrl) {" +
"            previewVideo.src = mediaUrl;" +
"            lastPreviewSrc = mediaUrl;" +
"          }" +
"          previewVideo.style.display = 'block';" +
"          previewGlyph.style.display = 'none';" +
"          previewVideo.play().catch(function () {});" +
"        } else {" +
"          previewVideo.style.display = 'none';" +
"          previewGlyph.style.display = 'flex';" +
"        }" +
"      }" +
"    }).catch(function () {});" +
"  }" +
"" +
"  function control(action) {" +
"    apiSend('/api/control', 'POST', { action: action }).then(refreshStatus).catch(function (err) { alert(err.message); });" +
"  }" +
"  document.getElementById('btnIniciar').addEventListener('click', function () { control('iniciar'); });" +
"  document.getElementById('btnParar').addEventListener('click', function () { control('parar'); });" +
"  document.getElementById('btnReiniciar').addEventListener('click', function () { control('reiniciar'); });" +
"" +
"  loadReferenceData().then(function () {" +
"    refreshStatus();" +
"    setInterval(refreshStatus, 2000);" +
"    setInterval(loadReferenceData, 30000);" +
"  });" +
"</script>" +
"" +
"</body>" +
"</html>" +
"";


// ---------------------------------------------------------------------
// Roteador HTTP
// ---------------------------------------------------------------------
function handleRequest(req, res) {
  const parsedUrl = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const pathname = decodeURIComponent(parsedUrl.pathname);
  const method = req.method;
  let m;

  if (method === 'GET' && pathname === '/') return serveIndex(res);
  if (method === 'GET' && pathname.indexOf('/media/') === 0) return serveMedia(req, res, pathname.slice(7));

  if (pathname === '/api/status' && method === 'GET') return handleStatus(req, res);
  if (pathname === '/api/control' && method === 'POST') return handleControl(req, res);

  if (pathname === '/api/videos' && method === 'GET') return handleVideosList(req, res, parsedUrl);
  if (pathname === '/api/videos/upload' && method === 'POST') return handleVideoUpload(req, res);
  if ((m = /^\/api\/videos\/([a-f0-9]+)$/.exec(pathname))) {
    if (method === 'GET') return handleVideoInfo(req, res, m[1]);
    if (method === 'PATCH') return handleVideoRename(req, res, m[1]);
    if (method === 'DELETE') return handleVideoDelete(req, res, m[1]);
  }

  if (pathname === '/api/schedule' && method === 'GET') return handleScheduleList(req, res);
  if (pathname === '/api/schedule' && method === 'POST') return handleScheduleCreate(req, res);
  if ((m = /^\/api\/schedule\/([a-f0-9]+)$/.exec(pathname))) {
    if (method === 'PUT') return handleScheduleUpdate(req, res, m[1]);
    if (method === 'DELETE') return handleScheduleDelete(req, res, m[1]);
  }

  if (pathname === '/api/events' && method === 'GET') return handleEventsList(req, res);
  if (pathname === '/api/events' && method === 'POST') return handleEventCreate(req, res);
  if ((m = /^\/api\/events\/([a-f0-9]+)$/.exec(pathname)) && method === 'DELETE') return handleEventDelete(req, res, m[1]);

  if (pathname === '/api/config' && method === 'GET') return handleConfigGet(req, res);
  if (pathname === '/api/config' && method === 'PUT') return handleConfigUpdate(req, res);

  if (pathname === '/api/logs' && method === 'GET') return handleLogsList(req, res, parsedUrl);
  if (pathname === '/api/logs/stream' && method === 'GET') return handleLogsStream(req, res);

  sendJSON(res, 404, { error: 'Rota não encontrada' });
}

const server = http.createServer(function (req, res) {
  try {
    handleRequest(req, res);
  } catch (err) {
    addLog('error', 'Erro interno: ' + err.message);
    sendJSON(res, 500, { error: 'Erro interno do servidor' });
  }
});

runEnvironmentDetection();

server.listen(PORT, function () {
  console.log('Painel TV Sul Capixaba (MVP) rodando em http://localhost:' + PORT);
  addLog('info', 'Painel iniciado na porta ' + PORT);
});
