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

const PAGE_HTML = "<!DOCTYPE html>\n<html lang=\"pt-BR\">\n<head>\n<meta charset=\"UTF-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n<title>TV Sul Capixaba — Programação</title>\n<style>\n  * { box-sizing: border-box; margin: 0; padding: 0; }\n\n  :root {\n    --bg: #05060a;\n    --panel: #0d0f16;\n    --panel-2: #12141c;\n    --panel-3: #171a24;\n    --border: #1c1f2a;\n    --text: #f2f3f5;\n    --text-dim: #9a9fad;\n    --text-faint: #5b606e;\n    --accent: #e2543a;\n    --accent-dim: rgba(226,84,58,0.14);\n    --blue: #3b6fe0;\n    --blue-dim: rgba(59,111,224,0.14);\n    --live: #3ecf6a;\n    --live-dim: rgba(62,207,106,0.14);\n    --amber: #f0c14b;\n    --radius: 12px;\n    --radius-sm: 8px;\n  }\n\n  html, body {\n    background: var(--bg);\n    color: var(--text);\n    font-family: -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, Arial, sans-serif;\n    font-variant-numeric: tabular-nums;\n    -webkit-font-smoothing: antialiased;\n  }\n\n  body { display: flex; min-height: 100vh; }\n\n  a { color: inherit; text-decoration: none; }\n  button { font-family: inherit; }\n\n  /* ================= Sidebar ================= */\n  .sidebar {\n    width: 248px;\n    flex-shrink: 0;\n    background: var(--panel);\n    border-right: 1px solid var(--border);\n    display: flex;\n    flex-direction: column;\n    position: sticky;\n    top: 0;\n    height: 100vh;\n    overflow-y: auto;\n    transition: transform .25s ease;\n    z-index: 40;\n  }\n\n  .sidebar-logo {\n    display: flex;\n    align-items: center;\n    gap: 10px;\n    padding: 22px 22px 20px;\n  }\n  .sidebar-logo .mark {\n    width: 30px; height: 30px;\n    border-radius: 8px;\n    background: linear-gradient(135deg, var(--accent), #ff8a65);\n    display: flex; align-items: center; justify-content: center;\n    font-size: 15px;\n    flex-shrink: 0;\n  }\n  .sidebar-logo .word {\n    font-size: 15px;\n    font-weight: 700;\n    letter-spacing: .01em;\n    line-height: 1.15;\n  }\n  .sidebar-logo .word small {\n    display: block;\n    font-size: 10px;\n    font-weight: 500;\n    color: var(--text-faint);\n    letter-spacing: .12em;\n    text-transform: uppercase;\n    margin-top: 2px;\n  }\n\n  .nav-scroll { padding: 4px 12px 24px; }\n\n  .nav-group { margin-top: 18px; }\n  .nav-group:first-child { margin-top: 4px; }\n  .nav-group-label {\n    font-size: 10.5px;\n    font-weight: 700;\n    letter-spacing: .1em;\n    text-transform: uppercase;\n    color: var(--text-faint);\n    padding: 0 10px 8px;\n  }\n\n  .nav-item {\n    display: flex;\n    align-items: center;\n    gap: 11px;\n    padding: 9px 10px;\n    border-radius: var(--radius-sm);\n    font-size: 13.5px;\n    color: var(--text-dim);\n    cursor: pointer;\n    margin-bottom: 1px;\n  }\n  .nav-item .ic { width: 17px; text-align: center; font-size: 14px; opacity: .85; }\n  .nav-item:hover { background: var(--panel-3); color: var(--text); }\n  .nav-item.active {\n    background: var(--panel-3);\n    color: var(--text);\n    box-shadow: inset 2px 0 0 var(--accent);\n  }\n\n  .sidebar-foot {\n    margin-top: auto;\n    padding: 16px 22px 22px;\n    border-top: 1px solid var(--border);\n    font-size: 11.5px;\n    color: var(--text-faint);\n  }\n  .sidebar-foot .dot { color: var(--live); }\n\n  .sidebar-toggle {\n    display: none;\n  }\n\n  /* ================= Main ================= */\n  main { flex: 1; min-width: 0; padding: 30px 36px 60px; }\n\n  .topbar { display: none; }\n\n  .page-header {\n    display: flex;\n    align-items: flex-start;\n    gap: 14px;\n    margin-bottom: 26px;\n  }\n  .back-btn {\n    all: unset; cursor: pointer;\n    width: 34px; height: 34px;\n    border-radius: 50%;\n    background: var(--panel-2);\n    border: 1px solid var(--border);\n    display: flex; align-items: center; justify-content: center;\n    color: var(--text-dim);\n    font-size: 16px;\n    flex-shrink: 0;\n  }\n  .back-btn:hover { color: var(--text); }\n\n  .page-header h1 {\n    font-size: 21px;\n    font-weight: 800;\n    letter-spacing: .01em;\n    display: flex;\n    align-items: baseline;\n    gap: 8px;\n    flex-wrap: wrap;\n  }\n  .page-header h1 .sub { font-weight: 600; color: var(--text-dim); font-size: 15px; }\n\n  .badges { display: flex; gap: 8px; margin-top: 9px; }\n  .badge {\n    font-size: 11px;\n    font-weight: 700;\n    padding: 4px 9px;\n    border-radius: 999px;\n    background: var(--panel-3);\n    border: 1px solid var(--border);\n    color: var(--text-dim);\n  }\n\n  .header-spacer { flex: 1; }\n  .header-actions { display: flex; gap: 10px; align-items: center; }\n\n  /* ================= Buttons ================= */\n  .btn {\n    all: unset; cursor: pointer; box-sizing: border-box;\n    font-size: 13px; font-weight: 700;\n    padding: 10px 16px;\n    border-radius: var(--radius-sm);\n    display: inline-flex; align-items: center; gap: 7px;\n    white-space: nowrap;\n  }\n  .btn-primary { background: var(--accent); color: #fff; }\n  .btn-primary:hover { background: #ef6146; }\n  .btn-ghost { background: var(--panel-3); color: var(--text); border: 1px solid var(--border); }\n  .btn-ghost:hover { border-color: #333747; }\n  .icon-btn {\n    all: unset; cursor: pointer;\n    width: 34px; height: 34px;\n    border-radius: var(--radius-sm);\n    background: var(--panel-3);\n    border: 1px solid var(--border);\n    display: flex; align-items: center; justify-content: center;\n    color: var(--text-dim);\n  }\n  .icon-btn.danger:hover { color: var(--accent); border-color: rgba(226,84,58,.4); }\n  .link-btn {\n    all: unset; cursor: pointer;\n    font-size: 13px; font-weight: 700;\n    color: var(--text-dim);\n  }\n  .link-btn.danger { color: var(--accent); }\n  .link-btn.danger:hover { text-decoration: underline; }\n\n  /* ================= Hero row ================= */\n  .hero {\n    display: grid;\n    grid-template-columns: 1.15fr 1fr 1fr;\n    gap: 16px;\n    margin-bottom: 18px;\n  }\n\n  .preview {\n    background: #000;\n    border-radius: var(--radius);\n    border: 1px solid var(--border);\n    aspect-ratio: 16/9;\n    position: relative;\n    overflow: hidden;\n  }\n  .preview-frame {\n    position: absolute; inset: 0;\n    background:\n      radial-gradient(circle at 30% 20%, rgba(226,84,58,.25), transparent 55%),\n      radial-gradient(circle at 75% 80%, rgba(59,111,224,.22), transparent 55%),\n      #0a0b10;\n    display: flex; align-items: center; justify-content: center;\n  }\n  .preview-frame .glyph {\n    width: 54px; height: 54px;\n    border-radius: 50%;\n    border: 1.5px solid rgba(255,255,255,.35);\n    display: flex; align-items: center; justify-content: center;\n    color: rgba(255,255,255,.75);\n    font-size: 18px;\n  }\n  .preview-controls {\n    position: absolute; left: 0; right: 0; bottom: 0;\n    padding: 10px 12px;\n    display: flex; align-items: center; gap: 14px;\n    background: linear-gradient(transparent, rgba(0,0,0,.55));\n    color: #fff;\n    font-size: 14px;\n  }\n  .preview-controls span:last-child { margin-left: auto; }\n  .preview-controls span { cursor: pointer; padding: 6px; margin: -6px; display: inline-flex; }\n  .preview-controls span:last-child { margin-left: auto; margin-right: -6px; }\n\n  .card {\n    background: var(--panel);\n    border: 1px solid var(--border);\n    border-radius: var(--radius);\n    padding: 18px 18px 16px;\n    display: flex;\n    flex-direction: column;\n  }\n  .card.now-playing { border-left: 2.5px solid var(--live); }\n  .card.up-next { border-left: 2.5px solid var(--text-faint); }\n\n  .eyebrow {\n    display: flex; align-items: center; gap: 7px;\n    font-size: 11px; font-weight: 800; letter-spacing: .09em;\n    color: var(--text-faint);\n    margin-bottom: 10px;\n  }\n  .eyebrow.live-color { color: var(--live); }\n\n  .dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; flex-shrink: 0; }\n  .dot.pulsing { animation: pulse 1.8s ease-in-out infinite; }\n  @media (prefers-reduced-motion: reduce) { .dot.pulsing { animation: none; } }\n  @keyframes pulse {\n    0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(62,207,106,.5); }\n    50% { opacity: .55; box-shadow: 0 0 0 5px rgba(62,207,106,0); }\n  }\n\n  .card h3, .card h4 {\n    font-size: 15px; font-weight: 700; line-height: 1.35;\n    margin-bottom: 8px;\n  }\n  .time-range { font-size: 12.5px; color: var(--text-dim); margin-bottom: 12px; }\n\n  .progress {\n    height: 5px; border-radius: 999px;\n    background: var(--panel-3);\n    overflow: hidden; margin-bottom: 8px;\n  }\n  .progress-fill { height: 100%; background: var(--live); border-radius: 999px; }\n  .progress-labels {\n    display: flex; justify-content: space-between;\n    font-size: 11.5px; color: var(--text-faint);\n  }\n\n  .starts-in {\n    font-size: 12.5px; color: var(--text-dim);\n    margin-top: auto; margin-bottom: 12px;\n  }\n  .starts-in strong { color: var(--text); font-weight: 700; }\n\n  .card .pill-btn {\n    all: unset; cursor: pointer; align-self: flex-start;\n    font-size: 12px; font-weight: 700;\n    padding: 7px 13px;\n    border-radius: 999px;\n    background: var(--panel-3);\n    border: 1px solid var(--border);\n    color: var(--text-dim);\n  }\n  .card .pill-btn:hover { color: var(--text); border-color: #333747; }\n\n  .items-count { font-size: 12px; color: var(--text-faint); margin-bottom: 22px; }\n\n  /* ================= Tabs ================= */\n  .tabs {\n    display: flex; gap: 4px;\n    border-bottom: 1px solid var(--border);\n    margin-bottom: 22px;\n  }\n  .tab {\n    all: unset; cursor: pointer;\n    padding: 10px 4px; margin-right: 22px;\n    font-size: 14px; font-weight: 700; color: var(--text-faint);\n    display: flex; align-items: center; gap: 8px;\n    border-bottom: 2px solid transparent;\n    position: relative; top: 1px;\n  }\n  .tab .tab-count {\n    font-size: 11px; font-weight: 800;\n    background: var(--panel-3);\n    color: var(--text-dim);\n    padding: 1px 7px;\n    border-radius: 999px;\n  }\n  .tab.active { color: var(--text); border-bottom-color: var(--accent); }\n  .tab.active .tab-count { background: var(--accent-dim); color: var(--accent); }\n  .tab:hover:not(.active) { color: var(--text-dim); }\n\n  .tab-panel { display: none; }\n  .tab-panel.active { display: block; }\n\n  /* ================= Control bar ================= */\n  .control-bar {\n    display: flex;\n    align-items: flex-end;\n    gap: 22px;\n    flex-wrap: wrap;\n    background: var(--panel);\n    border: 1px solid var(--border);\n    border-radius: var(--radius);\n    padding: 18px 20px;\n    margin-bottom: 14px;\n  }\n  .control-group { display: flex; flex-direction: column; gap: 8px; }\n  .control-group label {\n    font-size: 11.5px; font-weight: 700; color: var(--text-faint);\n    letter-spacing: .02em;\n  }\n\n  .segmented {\n    display: flex; background: var(--panel-3);\n    border: 1px solid var(--border);\n    border-radius: var(--radius-sm);\n    padding: 3px;\n  }\n  .segmented-btn {\n    all: unset; cursor: pointer;\n    font-size: 12.5px; font-weight: 700;\n    color: var(--text-dim);\n    padding: 7px 13px;\n    border-radius: 6px;\n    display: flex; align-items: center; gap: 6px;\n  }\n  .segmented-btn.active { background: var(--panel); color: var(--text); }\n\n  .input-like {\n    display: flex; align-items: center; gap: 9px;\n    font-size: 13px; color: var(--text);\n    background: var(--panel-3);\n    border: 1px solid var(--border);\n    border-radius: var(--radius-sm);\n    padding: 9px 12px;\n    min-width: 210px;\n    cursor: pointer;\n  }\n  .input-like .chev { margin-left: auto; color: var(--text-faint); font-size: 11px; }\n  .input-like:hover { border-color: #333747; }\n\n  .control-bar .btn-primary { margin-left: auto; }\n\n  .live-banner {\n    display: flex; align-items: center; gap: 12px;\n    background: var(--live-dim);\n    border: 1px solid rgba(62,207,106,.28);\n    border-radius: var(--radius-sm);\n    padding: 11px 16px;\n    font-size: 12.5px;\n    color: var(--text-dim);\n    margin-bottom: 26px;\n  }\n  .live-pill {\n    display: flex; align-items: center; gap: 6px;\n    font-size: 11px; font-weight: 800; letter-spacing: .05em;\n    color: var(--live);\n    flex-shrink: 0;\n  }\n\n  /* ================= Schedule list header ================= */\n  .list-header {\n    display: flex; align-items: flex-end; justify-content: space-between;\n    gap: 16px; flex-wrap: wrap;\n    margin-bottom: 16px;\n  }\n  .list-header h2 { font-size: 16px; font-weight: 800; margin-bottom: 4px; }\n  .list-meta { font-size: 12px; color: var(--text-faint); }\n  .list-actions { display: flex; align-items: center; gap: 14px; }\n\n  /* ================= Table ================= */\n  .table-wrap {\n    background: var(--panel);\n    border: 1px solid var(--border);\n    border-radius: var(--radius);\n    overflow: hidden;\n  }\n  .table-scroll { overflow-x: auto; }\n  table.schedule-table { width: 100%; border-collapse: collapse; min-width: 640px; }\n  .schedule-table thead th {\n    text-align: left;\n    font-size: 11px; font-weight: 800; letter-spacing: .07em; text-transform: uppercase;\n    color: var(--text-faint);\n    padding: 13px 18px;\n    background: var(--panel-2);\n    border-bottom: 1px solid var(--border);\n  }\n  .schedule-table td {\n    padding: 13px 18px;\n    font-size: 13.5px;\n    border-bottom: 1px solid var(--border);\n    color: var(--text);\n    vertical-align: middle;\n  }\n  .schedule-table tbody tr:last-child td { border-bottom: none; }\n  .schedule-table tbody tr:not(.date-row):hover { background: var(--panel-2); }\n  .empty-row { color: var(--text-faint); text-align: center; padding: 24px !important; }\n\n  .date-row td {\n    background: var(--panel-3);\n    color: var(--text-faint);\n    font-size: 11.5px; font-weight: 800; letter-spacing: .05em; text-transform: uppercase;\n    padding: 9px 18px;\n  }\n\n  .drag { color: var(--text-faint); white-space: nowrap; width: 1%; }\n  .source-cell { display: flex; align-items: center; gap: 10px; }\n  .source-cell .file-ic {\n    width: 26px; height: 26px; border-radius: 6px; flex-shrink: 0;\n    background: var(--panel-3); border: 1px solid var(--border);\n    display: flex; align-items: center; justify-content: center; font-size: 12px;\n  }\n  .source-cell .name-wrap { min-width: 0; }\n  .source-cell .name { font-weight: 600; }\n  .source-cell .name.break-name { color: var(--text-dim); font-style: italic; font-weight: 500; }\n\n  .mono { font-variant-numeric: tabular-nums; color: var(--text-dim); }\n  .row-actions { text-align: right; white-space: nowrap; }\n  .row-actions button {\n    all: unset; cursor: pointer; color: var(--text-faint);\n    padding: 4px 6px; border-radius: 6px;\n  }\n  .row-actions button:hover { color: var(--accent); background: var(--accent-dim); }\n\n  .table-more {\n    text-align: center;\n    padding: 14px;\n    font-size: 12.5px;\n    color: var(--text-faint);\n    background: var(--panel-2);\n  }\n\n  /* ================= Files tab (empty) ================= */\n  .files-empty {\n    background: var(--panel);\n    border: 1px dashed var(--border);\n    border-radius: var(--radius);\n    padding: 60px 24px;\n    text-align: center;\n    color: var(--text-faint);\n    font-size: 13.5px;\n  }\n  .files-empty .big-ic { font-size: 26px; margin-bottom: 10px; }\n\n  /* ================= Responsive ================= */\n  @media (max-width: 980px) {\n    .hero { grid-template-columns: 1fr; }\n  }\n\n  @media (max-width: 760px) {\n    body { flex-direction: column; }\n\n    .sidebar {\n      position: fixed; left: 0; top: 0; bottom: 0;\n      transform: translateX(-100%);\n      box-shadow: 24px 0 40px rgba(0,0,0,.5);\n    }\n    .sidebar.open { transform: translateX(0); }\n\n    .topbar {\n      display: flex; align-items: center; gap: 12px;\n      padding: 14px 18px;\n      border-bottom: 1px solid var(--border);\n      position: sticky; top: 0; z-index: 30;\n      background: var(--bg);\n    }\n    .topbar .mark {\n      width: 26px; height: 26px; border-radius: 7px;\n      background: linear-gradient(135deg, var(--accent), #ff8a65);\n      display: flex; align-items: center; justify-content: center; font-size: 13px;\n    }\n    .topbar .word { font-size: 14px; font-weight: 800; }\n    .sidebar-toggle {\n      all: unset; display: flex; cursor: pointer;\n      margin-left: auto;\n      width: 32px; height: 32px; border-radius: 8px;\n      background: var(--panel-2); border: 1px solid var(--border);\n      align-items: center; justify-content: center;\n      color: var(--text-dim); font-size: 15px;\n    }\n    .scrim {\n      display: none;\n      position: fixed; inset: 0; background: rgba(0,0,0,.5); z-index: 39;\n    }\n    .scrim.show { display: block; }\n\n    main { padding: 20px 16px 48px; }\n    .control-bar { flex-direction: column; align-items: stretch; }\n    .control-bar .btn-primary { margin-left: 0; }\n    .input-like { min-width: 0; }\n    .list-header { flex-direction: column; align-items: stretch; }\n    .list-actions { justify-content: space-between; }\n  }\n</style>\n</head>\n<body>\n\n  <div class=\"scrim\" id=\"scrim\"></div>\n\n  <aside class=\"sidebar\" id=\"sidebar\">\n    <div class=\"sidebar-logo\">\n      <div class=\"mark\">📡</div>\n      <div class=\"word\">TV Sul Capixaba<small>Painel de Playout</small></div>\n    </div>\n\n    <div class=\"nav-scroll\">\n      <div class=\"nav-group\">\n        <div class=\"nav-group-label\">Transmissão</div>\n        <a class=\"nav-item\"><span class=\"ic\">▦</span>Dashboard</a>\n        <a class=\"nav-item active\"><span class=\"ic\">◷</span>Programação</a>\n        <a class=\"nav-item\"><span class=\"ic\">☍</span>Eventos</a>\n      </div>\n      <div class=\"nav-group\">\n        <div class=\"nav-group-label\">Conteúdo</div>\n        <a class=\"nav-item\"><span class=\"ic\">⇧</span>Arquivos</a>\n        <a class=\"nav-item\"><span class=\"ic\">▤</span>Biblioteca</a>\n      </div>\n      <div class=\"nav-group\">\n        <div class=\"nav-group-label\">Sistema</div>\n        <a class=\"nav-item\"><span class=\"ic\">⚙</span>Configurações</a>\n        <a class=\"nav-item\"><span class=\"ic\">≣</span>Logs</a>\n      </div>\n    </div>\n\n    <div class=\"sidebar-foot\"><span class=\"dot\">●</span>&nbsp; No ar — canal principal</div>\n  </aside>\n\n  <main>\n    <div class=\"topbar\">\n      <div class=\"mark\">📡</div>\n      <div class=\"word\">TV Sul Capixaba</div>\n      <button class=\"sidebar-toggle\" id=\"menuToggle\">☰</button>\n    </div>\n\n    <header class=\"page-header\">\n      <button class=\"back-btn\">‹</button>\n      <div>\n        <h1>Programação <span class=\"sub\">— Canal Principal</span></h1>\n        <div class=\"badges\"><span class=\"badge\">720p</span><span class=\"badge\">30 fps</span></div>\n      </div>\n      <div class=\"header-spacer\"></div>\n      <div class=\"header-actions\">\n        <button class=\"btn btn-ghost\">Desativar canal</button>\n        <button class=\"icon-btn danger\">🗑</button>\n      </div>\n    </header>\n\n    <section class=\"hero\">\n      <div class=\"preview\">\n        <div class=\"preview-frame\" id=\"previewGlyph\">\n          <div class=\"glyph\">▶</div>\n        </div>\n        <video id=\"previewVideo\" muted loop playsinline style=\"display:none; width:100%; height:100%; object-fit:cover;\"></video>\n        <div class=\"preview-controls\">\n          <span id=\"btnToggle\">■</span><span id=\"btnMute\">🔊</span><span id=\"btnFullscreen\">⛶</span>\n        </div>\n      </div>\n\n      <div class=\"card now-playing\">\n        <div class=\"eyebrow live-color\"><span class=\"dot\" id=\"nowPlayingDot\"></span>TOCANDO AGORA</div>\n        <h3 id=\"nowPlayingTitle\">Transmissão parada</h3>\n        <div class=\"time-range\" id=\"nowPlayingRange\"></div>\n        <div class=\"progress\"><div class=\"progress-fill\" id=\"nowPlayingFill\" style=\"width:0%\"></div></div>\n        <div class=\"progress-labels\"><span id=\"nowPlayingElapsed\">00:00:00</span><span id=\"nowPlayingRemaining\">00:00:00</span></div>\n      </div>\n\n      <div class=\"card up-next\">\n        <div class=\"eyebrow\">A SEGUIR</div>\n        <h4 id=\"upNextTitle\">—</h4>\n        <div class=\"time-range\" id=\"upNextRange\"></div>\n        <div class=\"starts-in\">Começa em <strong id=\"upNextStartsIn\">—</strong></div>\n        <button class=\"pill-btn\">Ver programação</button>\n      </div>\n    </section>\n\n    <div class=\"items-count\" id=\"itemsCount\">0 itens na fila</div>\n\n    <nav class=\"tabs\">\n      <button class=\"tab active\" data-tab=\"schedule\">Programação <span class=\"tab-count\" id=\"tabCountSchedule\">0</span></button>\n      <button class=\"tab\" data-tab=\"files\">Arquivos <span class=\"tab-count\" id=\"tabCountFiles\">0</span></button>\n    </nav>\n\n    <section class=\"tab-panel active\" id=\"tab-schedule\">\n      <div class=\"control-bar\">\n        <div class=\"control-group\">\n          <label>Modo de reprodução</label>\n          <div class=\"segmented\">\n            <button class=\"segmented-btn active\" data-mode=\"schedule\">🕐 Programação</button>\n            <button class=\"segmented-btn\" data-mode=\"loop\">🔁 Loop</button>\n          </div>\n        </div>\n        <div class=\"control-group\">\n          <label>Início</label>\n          <div class=\"input-like\">📅 20/07/2026 16:29<span class=\"chev\">⌄</span></div>\n        </div>\n        <div class=\"control-group\">\n          <label>Destino de saída</label>\n          <div class=\"input-like\">📹 TV Sul Capixaba — Principal<span class=\"chev\">⌄</span></div>\n        </div>\n        <button class=\"btn btn-primary\">📡 Atualizar programação</button>\n      </div>\n\n      <div class=\"live-banner\">\n        <span class=\"live-pill\"><span class=\"dot\" id=\"liveBannerDot\"></span><span id=\"liveBannerLabel\">FORA DO AR</span></span>\n        O modo Programação toca cada fonte no horário exato definido. <span id=\"liveBannerCount\">Nenhum item cadastrado.</span>\n      </div>\n\n      <div class=\"list-header\">\n        <div>\n          <h2>Lista de programação</h2>\n          <span class=\"list-meta\" id=\"listMeta\">0 itens</span>\n        </div>\n        <div class=\"list-actions\">\n          <button class=\"link-btn danger\">Remover todos</button>\n          <button class=\"btn btn-ghost\">Adicionar intervalo</button>\n          <button class=\"btn btn-primary\" id=\"btnAddSource\">＋ Adicionar fonte</button>\n        </div>\n      </div>\n\n      <div class=\"table-wrap\">\n        <div class=\"table-scroll\">\n          <table class=\"schedule-table\">\n            <thead>\n              <tr><th>#</th><th>Fonte</th><th>Início</th><th>Duração</th><th></th></tr>\n            </thead>\n            <tbody id=\"scheduleTbody\">\n              <tr><td colspan=\"5\" class=\"empty-row\">Carregando programação...</td></tr>\n            </tbody>\n          </table>\n        </div>\n      </div>\n    </section>\n\n    <section class=\"tab-panel\" id=\"tab-files\">\n      <div class=\"files-empty\" id=\"filesEmpty\">\n        <div class=\"big-ic\">⇧</div>\n        Nenhum arquivo enviado ainda.<br>\n        Envie vídeos pela aba Arquivos para disponibilizá-los aqui.\n      </div>\n    </section>\n  </main>\n\n<script>\n  // Alternância de abas Programação / Arquivos (apenas UI)\n  document.querySelectorAll('.tab').forEach(function (tab) {\n    tab.addEventListener('click', function () {\n      document.querySelectorAll('.tab').forEach(function (t) { t.classList.remove('active'); });\n      document.querySelectorAll('.tab-panel').forEach(function (p) { p.classList.remove('active'); });\n      tab.classList.add('active');\n      document.getElementById('tab-' + tab.getAttribute('data-tab')).classList.add('active');\n    });\n  });\n\n  document.querySelectorAll('.segmented-btn').forEach(function (btn) {\n    btn.addEventListener('click', function () {\n      document.querySelectorAll('.segmented-btn').forEach(function (b) { b.classList.remove('active'); });\n      btn.classList.add('active');\n    });\n  });\n\n  var sidebar = document.getElementById('sidebar');\n  var scrim = document.getElementById('scrim');\n  var toggle = document.getElementById('menuToggle');\n  function closeMenu() { sidebar.classList.remove('open'); scrim.classList.remove('show'); }\n  toggle.addEventListener('click', function () { sidebar.classList.add('open'); scrim.classList.add('show'); });\n  scrim.addEventListener('click', closeMenu);\n  document.querySelectorAll('.sidebar .nav-item').forEach(function (item) { item.addEventListener('click', closeMenu); });\n\n  // ===================================================================\n  // Integração real com a API já existente no index.js (nenhuma rota nova)\n  // ===================================================================\n  function escapeHtml(s) {\n    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;');\n  }\n  function apiGet(url) { return fetch(url).then(function (r) { return r.json(); }); }\n  function apiSend(url, method, body) {\n    return fetch(url, { method: method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })\n      .then(function (r) { return r.json().then(function (data) { if (!r.ok) throw new Error(data.error || 'Erro'); return data; }); });\n  }\n  function pad2(n) { return String(n).padStart(2, '0'); }\n  function secondsToClock(sec) {\n    sec = Math.max(0, Math.round(sec));\n    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;\n    return pad2(h) + ':' + pad2(m) + ':' + pad2(s);\n  }\n  function timeToMinutes(hhmm) {\n    var parts = (hhmm || '00:00').split(':');\n    return (parseInt(parts[0], 10) || 0) * 60 + (parseInt(parts[1], 10) || 0);\n  }\n  function minutesToDurationLabel(mins) {\n    var h = Math.floor(mins / 60), m = Math.round(mins % 60);\n    return pad2(h) + 'h' + pad2(m) + 'min';\n  }\n\n  var videosById = {};\n  var scheduleList = [];\n  var lastPreviewSrc = null;\n  var engineRunning = false;\n\n  function loadReferenceData() {\n    return Promise.all([apiGet('/api/videos'), apiGet('/api/schedule')]).then(function (res) {\n      videosById = {};\n      res[0].forEach(function (v) { videosById[v.id] = v; });\n      scheduleList = res[1].slice().sort(function (a, b) { return timeToMinutes(a.startTime) - timeToMinutes(b.startTime); });\n\n      document.getElementById('tabCountSchedule').textContent = scheduleList.length;\n      document.getElementById('tabCountFiles').textContent = res[0].length;\n      document.getElementById('itemsCount').textContent = scheduleList.length + ' itens na fila';\n      document.getElementById('listMeta').textContent = scheduleList.length + ' itens cadastrados';\n      document.getElementById('liveBannerCount').textContent = scheduleList.length\n        ? 'Programação com ' + scheduleList.length + ' item(ns) cadastrado(s).'\n        : 'Nenhum item cadastrado ainda em Programação.';\n\n      renderScheduleTable();\n    });\n  }\n\n  function renderScheduleTable() {\n    var tbody = document.getElementById('scheduleTbody');\n    if (!scheduleList.length) {\n      tbody.innerHTML = '<tr><td colspan=\"5\" class=\"empty-row\">Nenhum item de programação cadastrado ainda.</td></tr>';\n      return;\n    }\n    var rows = '';\n    scheduleList.forEach(function (entry, i) {\n      var next = scheduleList[(i + 1) % scheduleList.length];\n      var startMin = timeToMinutes(entry.startTime);\n      var nextMin = timeToMinutes(next.startTime);\n      var durMin = nextMin - startMin; if (durMin <= 0) durMin += 1440;\n      var video = videosById[entry.videoId];\n      var name = video ? video.originalName : '(vídeo removido)';\n      rows += '<tr>'\n        + '<td class=\"drag\">≡ ' + (i + 1) + '</td>'\n        + '<td class=\"source-cell\"><span class=\"file-ic\">🎬</span><span class=\"name-wrap\"><span class=\"name\">' + escapeHtml(name) + '</span></span></td>'\n        + '<td>' + entry.startTime + ' (todos os dias)</td>'\n        + '<td class=\"mono\">' + minutesToDurationLabel(durMin) + '</td>'\n        + '<td class=\"row-actions\"></td>'\n        + '</tr>';\n    });\n    tbody.innerHTML = rows;\n  }\n\n  function findCurrentAndNextEntry(nowMinutes) {\n    var sorted = scheduleList;\n    var current = sorted[sorted.length - 1];\n    var currentIdx = sorted.length - 1;\n    for (var i = 0; i < sorted.length; i++) {\n      if (timeToMinutes(sorted[i].startTime) <= nowMinutes) { current = sorted[i]; currentIdx = i; }\n    }\n    var next = sorted[(currentIdx + 1) % sorted.length];\n    return { current: current, next: next };\n  }\n\n  function refreshStatus() {\n    apiGet('/api/status').then(function (s) {\n      engineRunning = !!s.running;\n\n      var dot = document.getElementById('nowPlayingDot');\n      var titleEl = document.getElementById('nowPlayingTitle');\n      var rangeEl = document.getElementById('nowPlayingRange');\n      var fillEl = document.getElementById('nowPlayingFill');\n      var elapsedEl = document.getElementById('nowPlayingElapsed');\n      var remainingEl = document.getElementById('nowPlayingRemaining');\n      var nextTitleEl = document.getElementById('upNextTitle');\n      var nextRangeEl = document.getElementById('upNextRange');\n      var nextStartsInEl = document.getElementById('upNextStartsIn');\n      var previewVideo = document.getElementById('previewVideo');\n      var previewGlyph = document.getElementById('previewGlyph');\n      var liveDot = document.getElementById('liveBannerDot');\n      var liveLabel = document.getElementById('liveBannerLabel');\n      var btnToggle = document.getElementById('btnToggle');\n\n      dot.classList.toggle('pulsing', engineRunning);\n      liveDot.classList.toggle('pulsing', engineRunning);\n      liveLabel.textContent = engineRunning ? 'NO AR' : 'FORA DO AR';\n      btnToggle.textContent = engineRunning ? '■' : '▶';\n      btnToggle.title = engineRunning ? 'Parar transmissão' : 'Iniciar transmissão';\n\n      if (!engineRunning || !scheduleList.length) {\n        titleEl.textContent = engineRunning ? 'Nenhum item agendado' : 'Transmissão parada';\n        rangeEl.textContent = '';\n        fillEl.style.width = '0%';\n        elapsedEl.textContent = '00:00:00';\n        remainingEl.textContent = '00:00:00';\n        nextTitleEl.textContent = '—';\n        nextRangeEl.textContent = '';\n        nextStartsInEl.textContent = '—';\n        previewVideo.style.display = 'none';\n        previewGlyph.style.display = 'flex';\n        previewVideo.pause();\n        return;\n      }\n\n      var now = new Date();\n      var nowMinutes = now.getHours() * 60 + now.getMinutes();\n      var nowSeconds = nowMinutes * 60 + now.getSeconds();\n      var found = findCurrentAndNextEntry(nowMinutes);\n\n      if (found.current) {\n        var startSec = timeToMinutes(found.current.startTime) * 60;\n        var nextSec = timeToMinutes(found.next.startTime) * 60;\n        var totalSec = nextSec - startSec; if (totalSec <= 0) totalSec += 86400;\n        var elapsedSec = nowSeconds - startSec; if (elapsedSec < 0) elapsedSec += 86400;\n        elapsedSec = Math.min(elapsedSec, totalSec);\n        var remainingSec = Math.max(0, totalSec - elapsedSec);\n\n        var video = videosById[found.current.videoId];\n        titleEl.textContent = video ? video.originalName : (s.nowPlaying !== '—' ? s.nowPlaying : '(vídeo removido)');\n        rangeEl.textContent = found.current.startTime + ' – ' + found.next.startTime;\n        fillEl.style.width = Math.min(100, (elapsedSec / totalSec * 100)) + '%';\n        elapsedEl.textContent = secondsToClock(elapsedSec);\n        remainingEl.textContent = secondsToClock(remainingSec);\n\n        var nextVideo = videosById[found.next.videoId];\n        nextTitleEl.textContent = nextVideo ? nextVideo.originalName : '(vídeo removido)';\n        nextRangeEl.textContent = found.next.startTime;\n        var startsInSec = nextSec - nowSeconds; if (startsInSec < 0) startsInSec += 86400;\n        nextStartsInEl.textContent = secondsToClock(startsInSec);\n\n        if (video) {\n          var mediaUrl = '/media/' + video.id;\n          if (lastPreviewSrc !== mediaUrl) {\n            previewVideo.src = mediaUrl;\n            lastPreviewSrc = mediaUrl;\n          }\n          previewVideo.style.display = 'block';\n          previewGlyph.style.display = 'none';\n          previewVideo.play().catch(function () {});\n        } else {\n          previewVideo.style.display = 'none';\n          previewGlyph.style.display = 'flex';\n        }\n      }\n    }).catch(function () {});\n  }\n\n  function control(action) {\n    apiSend('/api/control', 'POST', { action: action }).then(refreshStatus).catch(function (err) { alert(err.message); });\n  }\n\n  document.getElementById('btnToggle').addEventListener('click', function () {\n    control(engineRunning ? 'parar' : 'iniciar');\n  });\n  document.getElementById('btnMute').addEventListener('click', function (e) {\n    var video = document.getElementById('previewVideo');\n    video.muted = !video.muted;\n    e.target.textContent = video.muted ? '🔇' : '🔊';\n  });\n  document.getElementById('btnFullscreen').addEventListener('click', function () {\n    var previewBox = document.querySelector('.preview');\n    if (previewBox.requestFullscreen) previewBox.requestFullscreen();\n  });\n\n  loadReferenceData().then(function () {\n    refreshStatus();\n    setInterval(refreshStatus, 2000);\n    setInterval(loadReferenceData, 30000);\n  });\n\n  // Fluxo mínimo: Adicionar fonte = escolher arquivo -> enviar -> perguntar horário -> criar na programação.\n  document.getElementById('btnAddSource').addEventListener('click', function () {\n    var input = document.createElement('input');\n    input.type = 'file';\n    input.accept = 'video/*';\n    input.addEventListener('change', function () {\n      if (!input.files.length) return;\n      var fd = new FormData();\n      fd.append('video', input.files[0]);\n      var xhr = new XMLHttpRequest();\n      xhr.open('POST', '/api/videos/upload');\n      xhr.onload = function () {\n        if (xhr.status < 200 || xhr.status >= 300) { alert('Falha no envio do vídeo.'); return; }\n        var video = JSON.parse(xhr.responseText)[0];\n        var horario = prompt('Horário de início (HH:MM), repete todos os dias:', '00:00');\n        if (!horario) return;\n        apiSend('/api/schedule', 'POST', { videoId: video.id, startTime: horario, order: scheduleList.length, repeatDaily: true })\n          .then(function () { loadReferenceData(); })\n          .catch(function (err) { alert(err.message); });\n      };\n      xhr.onerror = function () { alert('Erro de rede no envio.'); };\n      xhr.send(fd);\n    });\n    input.click();\n  });\n</script>\n\n</body>\n</html>\n";



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
