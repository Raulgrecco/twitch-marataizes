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
const NORMALIZED_DIR = path.join(__dirname, 'data', 'normalized');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024; // 2GB — limite de segurança do MVP

[DATA_DIR, UPLOADS_DIR, NORMALIZED_DIR].forEach(function (dir) {
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
      resolution: '1280x720',
      bitrate: '2000k',
      format: 'A definir (RTMP chega na Etapa 10, SRT na Etapa 11)'
    },
    general: {
      channelName: 'TV Sul Capixaba',
      timezone: 'America/Sao_Paulo'
    },
    rtmp: {
      url: ''
    },
    destinations: []
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

// Migração: quem já tinha configurado um único destino RTMP (versão anterior)
// ganha esse destino automaticamente na nova lista de destinos, uma única vez.
if (!db.config.destinations || !db.config.destinations.length) {
  db.config.destinations = (db.config.rtmp && db.config.rtmp.url)
    ? [{ id: 'migrado', name: 'YouTube', url: db.config.rtmp.url, enabled: true }]
    : [];
}

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

// Garante uma cópia do vídeo já normalizada (mesma resolução/taxa de
// quadros/formato de áudio) para uso em playlists com mais de um vídeo.
// A normalização só acontece na primeira vez para cada vídeo+resolução —
// depois fica em cache em disco e é só reaproveitada (rápido).
function ensureNormalizedVideo(video, targetW, targetH, bitrate) {
  const normalizedPath = path.join(NORMALIZED_DIR, video.id + '_' + targetW + 'x' + targetH + '.mp4');
  if (fs.existsSync(normalizedPath)) return normalizedPath;
  const originalPath = path.join(UPLOADS_DIR, video.storedName);
  const args = [
    '-y', '-i', originalPath,
    '-vf', 'scale=' + targetW + ':' + targetH + ':force_original_aspect_ratio=decrease,' +
      'pad=' + targetW + ':' + targetH + ':(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', bitrate,
    '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-b:a', '128k',
    '-metadata', 'service=' + FFMPEG_MARKER,
    normalizedPath
  ];
  addLog('info', 'Preparando vídeo para a playlist (só na primeira vez): ' + video.originalName);
  execFileSync(envInfo.ffmpegPath, args, { stdio: 'ignore' });
  return normalizedPath;
}

// Mata qualquer processo do FFmpeg que ainda esteja rodando no sistema,
// mesmo que o painel não tenha nenhuma referência a ele (por exemplo, um
// processo órfão de uma sessão anterior que não encerrou corretamente —
// isso causa o erro "mais de uma transmissão usando a mesma URL" no
// destino, porque dois processos ficam publicando ao mesmo tempo).
const FFMPEG_MARKER = 'tv-sul-capixaba-painel';

function killOrphanFFmpegProcesses() {
  try {
    execFileSync('pkill', ['-9', '-f', FFMPEG_MARKER]);
    addLog('info', 'Processo(s) órfão(s) do FFmpeg (do painel) encontrado(s) e encerrado(s).');
  } catch (e) {
    // pkill retorna código de saída diferente de zero quando não encontra
    // nenhum processo correspondente — esse é o caso normal (nada a
    // limpar), não uma falha real.
  }
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
  playlistCount: 0,
  wasPlaylistMode: false,

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

    // Garante que nenhum FFmpeg de uma sessão anterior ficou publicando
    // por trás, antes de iniciar uma transmissão nova.
    killOrphanFFmpegProcesses();

    const self = this;
    const resolution = (db.config.output.resolution || '1280x720').replace(/\s+/g, '');
    const bitrate = db.config.output.bitrate || '2000k';

    const activeDestinations = (db.config.destinations || []).filter(function (d) {
      return d.enabled && d.url && d.url.trim();
    });

    // Transmite todos os vídeos enviados em sequência, do mais antigo ao
    // mais novo, repetindo a lista inteira quando chegar ao fim. Se não
    // houver nenhum vídeo ainda, cai para o sinal de teste local.
    const playlistVideos = db.videos.slice().sort(function (a, b) {
      return new Date(a.uploadedAt) - new Date(b.uploadedAt);
    }).filter(function (v) {
      return fs.existsSync(path.join(UPLOADS_DIR, v.storedName));
    });
    const hasVideoFile = playlistVideos.length > 0;

    let inputArgs;
    let mapArgs = [];
    if (playlistVideos.length === 1) {
      // Um único vídeo: toca direto, sem necessidade de normalizar nada.
      inputArgs = ['-re', '-stream_loop', '-1', '-i', path.join(UPLOADS_DIR, playlistVideos[0].storedName)];
      mapArgs = ['-map', '0:v', '-map', '0:a?'];
      this.currentVideoId = playlistVideos[0].id;
      this.playlistCount = 1;
      this.wasPlaylistMode = true;
    } else if (playlistVideos.length > 1) {
      // Vários vídeos podem ter resolução, taxa de quadros ou formato de
      // áudio diferentes. "Colar" os arquivos originais direto (concat
      // demuxer) faz o FFmpeg reinicializar o decodificador a cada troca,
      // travando a imagem por um instante (era o problema relatado).
      // Por isso cada vídeo é normalizado (mesma resolução/taxa/áudio) UMA
      // ÚNICA VEZ e a cópia fica em cache — depois disso, a concatenação é
      // sequencial e contínua, sem reinicializar nada entre um e outro.
      const dims = resolution.split('x');
      const targetW = dims[0] || '1280';
      const targetH = dims[1] || '720';

      let normalizedPaths;
      try {
        normalizedPaths = playlistVideos.map(function (v) {
          return ensureNormalizedVideo(v, targetW, targetH, bitrate);
        });
      } catch (err) {
        addLog('error', 'Falha ao preparar vídeos da playlist: ' + err.message);
        return;
      }

      const playlistPath = path.join(DATA_DIR, 'playlist.txt');
      const playlistContent = normalizedPaths.map(function (p) {
        return "file '" + p.replace(/'/g, "'\\''") + "'";
      }).join('\n');
      fs.writeFileSync(playlistPath, playlistContent);

      inputArgs = ['-re', '-stream_loop', '-1', '-f', 'concat', '-safe', '0', '-i', playlistPath];
      mapArgs = ['-map', '0:v', '-map', '0:a?'];
      // Com vários vídeos não dá pra saber com certeza qual está tocando
      // dentro do processo do FFmpeg sem inspecionar o vídeo, então
      // mostramos a contagem em vez de inventar um nome.
      this.currentVideoId = null;
      this.playlistCount = playlistVideos.length;
      this.wasPlaylistMode = true;
    } else {
      // testsrc não tem áudio — soma uma fonte de áudio mudo para os
      // destinos que exigem uma trilha de áudio (a maioria dos players).
      inputArgs = [
        '-f', 'lavfi', '-i', 'testsrc=size=' + resolution + ':rate=30',
        '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo'
      ];
      mapArgs = ['-map', '0:v', '-map', '1:a'];
      this.currentVideoId = null;
      this.playlistCount = 0;
      this.wasPlaylistMode = false;
    }

    const bitrateNum = parseInt(bitrate, 10) || 2000;
    const bufsize = (bitrateNum * 2) + 'k';
    const encodeArgs = [
      '-c:v', 'libx264', '-preset', 'ultrafast',
      '-b:v', bitrate, '-maxrate', bitrate, '-bufsize', bufsize,
      '-g', '60', '-keyint_min', '60',
      '-c:a', 'aac', '-ar', '44100', '-b:a', '128k',
      '-metadata', 'service=' + FFMPEG_MARKER
    ];
    if (!hasVideoFile) encodeArgs.push('-shortest');

    let outputArgs;
    if (activeDestinations.length > 0) {
      // Detecta o protocolo pela URL (rtmp:// ou srt://) e usa o muxer do
      // FFmpeg "tee" para mandar o mesmo encode para todos os destinos ativos
      // ao mesmo tempo. "onfail=ignore" evita que um destino com problema
      // derrube a transmissão para os demais.
      const teeOutputs = activeDestinations.map(function (d) {
        const url = d.url.trim();
        const isSrt = /^srt:\/\//i.test(url);
        const muxer = isSrt ? 'mpegts' : 'flv';
        return '[f=' + muxer + ':onfail=ignore]' + url;
      }).join('|');
      outputArgs = ['-f', 'tee', teeOutputs];
    } else {
      outputArgs = ['-f', 'null', '-'];
    }

    const args = ['-hide_banner', '-loglevel', 'warning']
      .concat(inputArgs, mapArgs, encodeArgs, outputArgs);

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
    this.outputLabel = resolution + ' @ ' + bitrate
      + (activeDestinations.length ? ' → ' + activeDestinations.length + ' destino(s)' : ' (teste local)');
    addLog('info', 'Transmissão iniciada — processo FFmpeg criado (PID ' + child.pid + ')'
      + (hasVideoFile
          ? ' — fonte: ' + (playlistVideos.length === 1 ? playlistVideos[0].originalName : 'playlist com ' + playlistVideos.length + ' vídeos')
          : ' — fonte: sinal de teste')
      + (activeDestinations.length
          ? ' — destinos: ' + activeDestinations.map(function (d) { return d.name; }).join(', ')
          : ' — destino: teste local (nenhum destino ativo configurado)'));

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
      if (wasStoppedManually) return;

      // A playlist terminou de tocar sozinha (chegou ao fim da lista) e o
      // usuário não mandou parar — reinicia do começo automaticamente para
      // manter o loop contínuo, em vez de tratar isso como uma falha.
      if (code === 0 && self.wasPlaylistMode) {
        addLog('info', 'Playlist chegou ao fim — reiniciando do início automaticamente.');
        const tokenAntes = self.restartToken;
        self.running = false;
        setTimeout(function () {
          if (self.restartToken === tokenAntes) self.start();
        }, 300);
        return;
      }

      self.running = false;
      self.startedAt = null;
      self.outputLabel = '—';
      addLog('error', 'Processo do FFmpeg encerrou inesperadamente (código ' + code + (signal ? ', sinal ' + signal : '') + ')');
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
    // Garante de verdade que nada fica publicando depois do Parar —
    // independente do que o painel achava que era o estado (por exemplo,
    // um processo órfão de uma sessão anterior que o painel nem sabia
    // que existia).
    killOrphanFFmpegProcesses();
    this.running = false;
    this.startedAt = null;
    this.outputLabel = '—';
    this.ffmpegProcess = null;
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
    let nowPlayingLabel = '—';
    if (this.running) {
      if (video) nowPlayingLabel = video.originalName;
      else if (this.playlistCount > 1) nowPlayingLabel = 'Playlist (' + this.playlistCount + ' vídeos)';
    }
    let upSeconds = 0;
    if (this.running && this.startedAt) upSeconds = Math.floor((Date.now() - this.startedAt) / 1000);
    return {
      running: this.running,
      nowPlaying: nowPlayingLabel,
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
    if (body.rtmp) db.config.rtmp = Object.assign({}, db.config.rtmp, body.rtmp);
    if (body.destinations !== undefined) db.config.destinations = body.destinations;
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

const PAGE_HTML = "<!DOCTYPE html>\n<html lang=\"pt-BR\">\n<head>\n<meta charset=\"UTF-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n<title>TV Sul Capixaba — Transmissão</title>\n<style>\n  * { box-sizing: border-box; margin: 0; padding: 0; }\n  body {\n    font-family: -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, Arial, sans-serif;\n    background: #05060a; color: #f2f3f5;\n    display: flex; justify-content: center;\n    padding: 40px 20px;\n  }\n  .box { width: 100%; max-width: 560px; }\n  h1 { font-size: 20px; font-weight: 700; margin-bottom: 24px; }\n\n  .card {\n    background: #0d0f16; border: 1px solid #1c1f2a; border-radius: 12px;\n    padding: 20px; margin-bottom: 16px;\n  }\n  .card h2 { font-size: 13px; font-weight: 700; color: #9a9fad; text-transform: uppercase; letter-spacing: .04em; margin-bottom: 14px; }\n\n  .status-row { display: flex; align-items: center; gap: 10px; font-size: 16px; font-weight: 700; margin-bottom: 16px; }\n  .status-dot { width: 10px; height: 10px; border-radius: 50%; background: #6b7280; flex-shrink: 0; }\n  .status-dot.on { background: #3ecf6a; }\n\n  .controls { display: flex; gap: 10px; }\n  button {\n    all: unset; cursor: pointer; text-align: center;\n    font-size: 14px; font-weight: 700; padding: 12px 18px; border-radius: 8px;\n  }\n  .btn-play { background: #3ecf6a; color: #04340c; flex: 1; }\n  .btn-stop { background: #e2543a; color: #fff; flex: 1; }\n  button:disabled { opacity: .5; cursor: default; }\n\n  input[type=text] {\n    width: 100%; background: #171a24; border: 1px solid #1c1f2a; color: #f2f3f5;\n    padding: 10px 12px; border-radius: 8px; font-size: 14px; margin-bottom: 10px;\n  }\n  .btn-save { background: #171a24; color: #f2f3f5; border: 1px solid #1c1f2a; width: 100%; }\n\n  .upload-row { display: flex; gap: 10px; margin-bottom: 6px; }\n  input[type=file] { flex: 1; color: #9a9fad; font-size: 13px; }\n  .btn-upload { background: #e2543a; color: #fff; }\n\n  .progress { height: 6px; border-radius: 999px; background: #171a24; overflow: hidden; margin-top: 10px; display: none; }\n  .progress-fill { height: 100%; background: #3b6fe0; width: 0%; }\n\n  ul.video-list { list-style: none; }\n  ul.video-list li {\n    display: flex; align-items: center; justify-content: space-between; gap: 10px;\n    padding: 10px 0; border-bottom: 1px solid #1c1f2a; font-size: 14px;\n  }\n  ul.video-list li:last-child { border-bottom: none; }\n  ul.video-list .name { word-break: break-word; }\n  ul.video-list .meta { color: #9a9fad; font-size: 12px; }\n  .empty { color: #5b606e; font-size: 13px; padding: 6px 0; }\n  .del-btn { all: unset; cursor: pointer; color: #5b606e; font-size: 13px; flex-shrink: 0; }\n  .del-btn:hover { color: #e2543a; }\n\n  .dest-row {\n    display: flex; align-items: center; justify-content: space-between; gap: 10px;\n    padding: 10px 0; border-bottom: 1px solid #1c1f2a; font-size: 14px;\n  }\n  .dest-row:last-child { border-bottom: none; }\n  .dest-row label { display: flex; align-items: center; gap: 8px; }\n  .dest-row .meta { color: #9a9fad; font-size: 12px; }\n  .dest-actions { display: flex; gap: 12px; flex-shrink: 0; }\n  .link-btn { all: unset; cursor: pointer; color: #9a9fad; font-size: 13px; }\n  .link-btn:hover { color: #f2f3f5; }\n  .dest-form { margin-top: 10px; }\n</style>\n</head>\n<body>\n<div class=\"box\">\n  <h1>TV Sul Capixaba — Transmissão</h1>\n\n  <div class=\"card\">\n    <div class=\"status-row\"><span class=\"status-dot\" id=\"statusDot\"></span><span id=\"statusText\">Parado</span></div>\n    <div class=\"controls\">\n      <button class=\"btn-play\" id=\"btnPlay\">▶ Play</button>\n      <button class=\"btn-stop\" id=\"btnStop\">⏹ Stop</button>\n    </div>\n  </div>\n\n  <div class=\"card\">\n    <h2>Destinos de transmissão</h2>\n    <div id=\"destList\"></div>\n    <div class=\"dest-form\">\n      <input type=\"text\" id=\"destName\" placeholder=\"Nome (ex: YouTube)\" />\n      <input type=\"text\" id=\"destUrl\" placeholder=\"rtmp://... ou srt://...\" />\n      <button class=\"btn-save\" id=\"btnAddDest\">+ Adicionar destino</button>\n    </div>\n  </div>\n\n  <div class=\"card\">\n    <h2>Enviar vídeo</h2>\n    <div class=\"upload-row\">\n      <input type=\"file\" id=\"fileInput\" accept=\"video/*\" />\n      <button class=\"btn-upload\" id=\"btnUpload\">Enviar</button>\n    </div>\n    <div class=\"progress\" id=\"uploadProgress\"><div class=\"progress-fill\" id=\"uploadProgressFill\"></div></div>\n  </div>\n\n  <div class=\"card\">\n    <h2>Vídeos enviados</h2>\n    <ul class=\"video-list\" id=\"videoList\"></ul>\n  </div>\n</div>\n\n<script>\n  function apiGet(url) { return fetch(url).then(function (r) { return r.json(); }); }\n  function apiSend(url, method, body) {\n    return fetch(url, { method: method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })\n      .then(function (r) { return r.json().then(function (data) { if (!r.ok) throw new Error(data.error || 'Erro'); return data; }); });\n  }\n  function escapeHtml(s) {\n    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;');\n  }\n  function formatBytes(n) {\n    if (!n) return '0 B';\n    var units = ['B', 'KB', 'MB', 'GB']; var i = 0; var v = n;\n    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }\n    return v.toFixed(1) + ' ' + units[i];\n  }\n\n  var destinations = [];\n  function detectProtocolLabel(url) {\n    if (/^rtmps?:\\/\\//i.test(url)) return 'RTMP';\n    if (/^srt:\\/\\//i.test(url)) return 'SRT';\n    return '?';\n  }\n  function loadDestinations() {\n    return apiGet('/api/config').then(function (c) {\n      destinations = c.destinations || [];\n      renderDestinations();\n    });\n  }\n  function renderDestinations() {\n    var el = document.getElementById('destList');\n    if (!destinations.length) { el.innerHTML = '<div class=\"empty\">Nenhum destino cadastrado ainda.</div>'; return; }\n    var html = '';\n    destinations.forEach(function (d) {\n      html += '<div class=\"dest-row\">'\n        + '<label><input type=\"checkbox\" class=\"dest-toggle\" data-id=\"' + d.id + '\" ' + (d.enabled ? 'checked' : '') + ' /> '\n        + escapeHtml(d.name) + ' <span class=\"meta\">(' + detectProtocolLabel(d.url) + ')</span></label>'\n        + '<span class=\"dest-actions\">'\n        + '<button class=\"link-btn\" data-act=\"edit\" data-id=\"' + d.id + '\">Editar</button>'\n        + '<button class=\"del-btn\" data-act=\"del\" data-id=\"' + d.id + '\">Excluir</button>'\n        + '</span></div>';\n    });\n    el.innerHTML = html;\n  }\n  function saveDestinations() {\n    return apiSend('/api/config', 'PUT', { destinations: destinations });\n  }\n  document.getElementById('btnAddDest').addEventListener('click', function () {\n    var name = document.getElementById('destName').value.trim();\n    var url = document.getElementById('destUrl').value.trim();\n    if (!name || !url) { alert('Preencha nome e URL.'); return; }\n    destinations.push({ id: Date.now().toString(36), name: name, url: url, enabled: true });\n    document.getElementById('destName').value = '';\n    document.getElementById('destUrl').value = '';\n    saveDestinations().then(renderDestinations).catch(function (err) { alert(err.message); });\n  });\n  document.getElementById('destList').addEventListener('change', function (e) {\n    if (!e.target.classList.contains('dest-toggle')) return;\n    var dest = destinations.find(function (d) { return d.id === e.target.getAttribute('data-id'); });\n    if (dest) dest.enabled = e.target.checked;\n    saveDestinations().catch(function (err) { alert(err.message); });\n  });\n  document.getElementById('destList').addEventListener('click', function (e) {\n    var btn = e.target.closest('button[data-act]');\n    if (!btn) return;\n    var idx = destinations.findIndex(function (d) { return d.id === btn.getAttribute('data-id'); });\n    if (idx === -1) return;\n    if (btn.getAttribute('data-act') === 'del') {\n      if (!confirm('Excluir este destino?')) return;\n      destinations.splice(idx, 1);\n      saveDestinations().then(renderDestinations).catch(function (err) { alert(err.message); });\n    } else {\n      var d = destinations[idx];\n      var newName = prompt('Nome:', d.name);\n      if (newName === null) return;\n      var newUrl = prompt('URL (rtmp:// ou srt://):', d.url);\n      if (newUrl === null) return;\n      d.name = newName.trim() || d.name;\n      d.url = newUrl.trim() || d.url;\n      saveDestinations().then(renderDestinations).catch(function (err) { alert(err.message); });\n    }\n  });\n\n  function loadVideos() {\n    apiGet('/api/videos?sort=date').then(function (list) {\n      var ul = document.getElementById('videoList');\n      if (!list.length) { ul.innerHTML = '<li class=\"empty\">Nenhum vídeo enviado ainda.</li>'; return; }\n      var html = '';\n      list.forEach(function (v) {\n        html += '<li><div><div class=\"name\">' + escapeHtml(v.originalName) + '</div>'\n          + '<div class=\"meta\">' + formatBytes(v.size) + '</div></div>'\n          + '<button class=\"del-btn\" data-id=\"' + v.id + '\">Excluir</button></li>';\n      });\n      ul.innerHTML = html;\n    });\n  }\n  document.getElementById('videoList').addEventListener('click', function (e) {\n    var btn = e.target.closest('.del-btn');\n    if (!btn) return;\n    if (!confirm('Excluir este vídeo?')) return;\n    apiSend('/api/videos/' + btn.getAttribute('data-id'), 'DELETE').then(loadVideos).catch(function (err) { alert(err.message); });\n  });\n\n  document.getElementById('btnUpload').addEventListener('click', function () {\n    var input = document.getElementById('fileInput');\n    if (!input.files.length) { alert('Escolha um arquivo de vídeo primeiro.'); return; }\n    var fd = new FormData();\n    fd.append('video', input.files[0]);\n    var bar = document.getElementById('uploadProgress');\n    var fill = document.getElementById('uploadProgressFill');\n    bar.style.display = 'block'; fill.style.width = '0%';\n    var xhr = new XMLHttpRequest();\n    xhr.open('POST', '/api/videos/upload');\n    xhr.upload.onprogress = function (evt) {\n      if (evt.lengthComputable) fill.style.width = Math.round(evt.loaded / evt.total * 100) + '%';\n    };\n    xhr.onload = function () {\n      bar.style.display = 'none'; input.value = '';\n      if (xhr.status >= 200 && xhr.status < 300) loadVideos();\n      else alert('Falha no envio.');\n    };\n    xhr.onerror = function () { bar.style.display = 'none'; alert('Erro de rede no envio.'); };\n    xhr.send(fd);\n  });\n\n  function refreshStatus() {\n    apiGet('/api/status').then(function (s) {\n      document.getElementById('statusDot').classList.toggle('on', !!s.running);\n      document.getElementById('statusText').textContent = s.running ? 'Transmitindo' : 'Parado';\n      document.getElementById('btnPlay').disabled = !!s.running;\n      document.getElementById('btnStop').disabled = !s.running;\n    }).catch(function () {});\n  }\n  document.getElementById('btnPlay').addEventListener('click', function () {\n    apiSend('/api/control', 'POST', { action: 'iniciar' }).then(refreshStatus).catch(function (err) { alert(err.message); });\n  });\n  document.getElementById('btnStop').addEventListener('click', function () {\n    apiSend('/api/control', 'POST', { action: 'parar' }).then(refreshStatus).catch(function (err) { alert(err.message); });\n  });\n\n  loadDestinations();\n  loadVideos();\n  refreshStatus();\n  setInterval(refreshStatus, 2000);\n</script>\n</body>\n</html>\n";



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
killOrphanFFmpegProcesses();

server.listen(PORT, function () {
  console.log('Painel TV Sul Capixaba (MVP) rodando em http://localhost:' + PORT);
  addLog('info', 'Painel iniciado na porta ' + PORT);
});
