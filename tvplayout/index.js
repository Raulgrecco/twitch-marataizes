/**
 * index.js — Painel de Transmissão TV Sul Capixaba (arquivo único)
 * ---------------------------------------------------------------------------
 * Zero dependências externas — só o que já vem instalado com o Node.
 * Não precisa de "npm install", não precisa de package.json.
 * Roda com: node index.js
 *
 * A senha do painel NÃO precisa vir de variável de ambiente — no primeiro
 * acesso pelo navegador, o próprio painel pede pra você criar uma senha,
 * e guarda o hash dela em config.json. Isso permite instalar isso uma vez,
 * tirar um snapshot da VPS, e qualquer instância nova criada a partir desse
 * snapshot pede a senha de novo pelo navegador — sem precisar de SSH.
 *
 * Variáveis de ambiente (ambas opcionais):
 *   PAINEL_PASSWORD  — se quiser fixar a senha por env var em vez de criar
 *                       pelo navegador (compatibilidade com instalações antigas)
 *   PORT             — porta do servidor (padrão 3000)
 * ---------------------------------------------------------------------------
 */

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn, exec } = require("child_process");

const PORT = process.env.PORT || 3000;
const APP_VERSION = "2026-07-21.1"; // sobe esse número a cada mudança real, é o que o botão "Atualizar" compara
const UPDATE_URL_DEFAULT = "https://raw.githubusercontent.com/Raulgrecco/twitch-marataizes/main/tvplayout/index.js";

function hashPassword(pass) {
  return crypto.createHash("sha256").update(pass).digest("hex");
}

const FILES_DIR = path.join(__dirname, "files");
const CONFIG_FILE = path.join(__dirname, "config.json");

if (!fs.existsSync(FILES_DIR)) fs.mkdirSync(FILES_DIR);

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return { youtubeStreamKey: "", srtUrl: "", schedule: [], pendingEvents: [], activeEvent: null };
  }
}
function writeConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

// ---------------------------------------------------------------------------
// utilidades pra responder JSON / ler corpo pequeno (JSON) da requisição
// ---------------------------------------------------------------------------
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8") || "{}";
        resolve(JSON.parse(text));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}
function isSafeName(name) {
  return typeof name === "string" && name.length > 0 && !name.includes("/") && !name.includes("\\") && !name.includes("..");
}

// ---------------------------------------------------------------------------
// arquivos
// ---------------------------------------------------------------------------
function listFiles() {
  return fs.readdirSync(FILES_DIR).map((name) => {
    const stat = fs.statSync(path.join(FILES_DIR, name));
    return { name, sizeMB: Math.round(stat.size / 1024 / 1024) };
  });
}

// upload: o vídeo vem como corpo bruto da requisição (não multipart), com o
// nome do arquivo no parâmetro ?filename= — assim não precisamos de nenhuma
// biblioteca externa pra interpretar multipart/form-data.
function handleUpload(req, res, filename) {
  if (!isSafeName(filename)) return sendJson(res, 400, { error: "nome de arquivo inválido" });
  const dest = path.join(FILES_DIR, filename);
  const writeStream = fs.createWriteStream(dest);
  req.pipe(writeStream);
  writeStream.on("finish", () => sendJson(res, 200, { ok: true, filename }));
  writeStream.on("error", (err) => sendJson(res, 500, { error: err.message }));
  req.on("error", () => writeStream.destroy());
}

// ---------------------------------------------------------------------------
// motor de playout — duas peças:
//   outerProcess: conecta no YouTube/SRT UMA vez e nunca reinicia enquanto a
//                 live estiver no ar. Lê de stdin.
//   feederProcess: lê UM arquivo de vídeo por vez (em loop) e escreve no
//                  stdin do outerProcess. Esse sim é trocado/matado à vontade
//                  — a troca de fonte não derruba a conexão com o YouTube.
// ---------------------------------------------------------------------------
let outerProcess = null;
let feederProcess = null;
let currentFeederFile = null;   // nome do arquivo tocando agora no feeder
let startedAt = null;
let lastBitrateKbps = null;
let schedulerTimer = null;
const logBuffer = [];
function pushLog(line) {
  logBuffer.push(`[${new Date().toLocaleTimeString("pt-BR")}] ${line}`);
  if (logBuffer.length > 200) logBuffer.shift();
}
function isRunning() {
  return outerProcess !== null;
}

function buildOuterArgs(cfg) {
  const outputs = [];
  if (cfg.youtubeStreamKey) outputs.push(`[f=flv]rtmp://a.rtmp.youtube.com/live2/${cfg.youtubeStreamKey}`);
  if (cfg.srtUrl) outputs.push(`[f=mpegts]${cfg.srtUrl}`);
  if (outputs.length === 0) throw new Error("nenhum destino configurado (falta a chave do YouTube ou a URL SRT)");
  return [
    "-re", "-f", "mpegts", "-i", "pipe:0",
    "-c", "copy",
    "-map", "0:v:0", "-map", "0:a:0",
    "-f", "tee", outputs.join("|")
  ];
}

// troca o que está tocando, SEM tocar no outerProcess (é essa a peça-chave)
function switchFeederTo(filename) {
  const filePath = path.join(FILES_DIR, filename);
  if (!fs.existsSync(filePath)) throw new Error(`arquivo não encontrado: ${filename}`);
  if (currentFeederFile === filename && feederProcess) return; // já é isso, não troca de novo

  if (feederProcess) {
    feederProcess.stdout.unpipe();
    feederProcess.kill("SIGKILL");
    feederProcess = null;
  }

  pushLog(`trocando fonte para: ${filename}`);
  feederProcess = spawn("ffmpeg", [
    "-re", "-stream_loop", "-1", "-i", filePath,
    "-c:v", "libx264", "-preset", "veryfast", "-b:v", "3000k", "-maxrate", "3000k", "-bufsize", "6000k",
    "-s", "1280x720", "-r", "30",
    "-c:a", "aac", "-b:a", "128k", "-ar", "44100",
    "-map", "0:v:0", "-map", "0:a:0",
    "-f", "mpegts", "pipe:1"
  ]);
  currentFeederFile = filename;

  feederProcess.stderr.on("data", (data) => {
    const text = data.toString();
    const match = text.match(/bitrate=\s*([\d.]+)kbits\/s/);
    if (match) lastBitrateKbps = parseFloat(match[1]);
  });
  feederProcess.on("error", (err) => pushLog(`erro no feeder: ${err.message}`));

  if (outerProcess && outerProcess.stdin.writable) {
    feederProcess.stdout.pipe(outerProcess.stdin, { end: false }); // end:false é o que mantém a live viva na troca
  }
}

// ---------------------------------------------------------------------------
// agendador — decide, a cada 15s, o que deveria estar tocando agora
// ---------------------------------------------------------------------------
function nowHHMM() {
  const d = new Date();
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}
function pickBaseBlockFile(schedule, hhmm) {
  if (!schedule || schedule.length === 0) return null;
  const sorted = [...schedule].sort((a, b) => a.time.localeCompare(b.time));
  let chosen = sorted[sorted.length - 1]; // se hhmm for antes de todos, cai no último (vira da meia-noite)
  for (const block of sorted) {
    if (block.time <= hhmm) chosen = block;
  }
  return chosen ? chosen.file : null;
}
function schedulerTick() {
  if (!isRunning()) return;
  const cfg = readConfig();
  const hhmm = nowHHMM();

  // 1) evento ativo (manual ou agendado) já expirou?
  if (cfg.activeEvent && cfg.activeEvent.expiresAt && Date.now() >= cfg.activeEvent.expiresAt) {
    pushLog(`evento "${cfg.activeEvent.file}" terminou — voltando pra programação normal`);
    cfg.activeEvent = null;
    writeConfig(cfg);
  }

  // 2) tem evento agendado (ainda não disparado) cuja hora chegou?
  if (!cfg.activeEvent && cfg.pendingEvents && cfg.pendingEvents.length > 0) {
    const idx = cfg.pendingEvents.findIndex((e) => e.time <= hhmm);
    if (idx !== -1) {
      const ev = cfg.pendingEvents[idx];
      cfg.pendingEvents.splice(idx, 1);
      cfg.activeEvent = { file: ev.file, expiresAt: Date.now() + ev.durationMin * 60000 };
      pushLog(`evento agendado disparado: ${ev.file} por ${ev.durationMin}min`);
      writeConfig(cfg);
    }
  }

  // 3) o que deveria estar tocando agora?
  const targetFile = cfg.activeEvent ? cfg.activeEvent.file : pickBaseBlockFile(cfg.schedule, hhmm);
  if (targetFile && targetFile !== currentFeederFile) {
    try { switchFeederTo(targetFile); } catch (err) { pushLog(`falha ao trocar fonte: ${err.message}`); }
  }
}

function startStream() {
  if (isRunning()) throw new Error("já está transmitindo");
  const cfg = readConfig();
  const hasBase = cfg.schedule && cfg.schedule.length > 0;
  if (!hasBase) throw new Error("a programação base está vazia — adicione pelo menos um bloco");

  lastBitrateKbps = null;
  pushLog("iniciando transmissão (outer)...");
  outerProcess = spawn("ffmpeg", buildOuterArgs(cfg));
  startedAt = new Date().toISOString();

  cfg.wasRunning = true;
  writeConfig(cfg);

  outerProcess.stderr.on("data", (data) => {
    data.toString().split("\n").map((l) => l.trim()).filter(Boolean).forEach((l) => pushLog(l));
  });
  outerProcess.on("exit", (code) => {
    pushLog(`transmissão encerrada (código ${code})`);
    outerProcess = null;
    startedAt = null;
    lastBitrateKbps = null;
    if (feederProcess) { feederProcess.kill("SIGKILL"); feederProcess = null; }
    currentFeederFile = null;
    if (schedulerTimer) { clearInterval(schedulerTimer); schedulerTimer = null; }
    const cfgNow = readConfig();
    if (cfgNow.wasRunning) {
      pushLog("reconectando em 10s...");
      setTimeout(() => {
        try { startStream(); } catch (err) { pushLog("falha ao reconectar: " + err.message); }
      }, 10000);
    }
  });

  // dispara logo de cara (não espera 15s pra decidir o que tocar) e depois
  // segue verificando periodicamente pra agenda/eventos.
  schedulerTick();
  schedulerTimer = setInterval(schedulerTick, 15000);
}

function stopStream() {
  if (!isRunning()) throw new Error("não está transmitindo");
  pushLog("parando transmissão...");
  const cfg = readConfig();
  cfg.wasRunning = false;
  writeConfig(cfg);
  if (schedulerTimer) { clearInterval(schedulerTimer); schedulerTimer = null; }
  if (feederProcess) { feederProcess.kill("SIGKILL"); feederProcess = null; }
  currentFeederFile = null;
  outerProcess.kill("SIGINT");
  outerProcess = null;
  startedAt = null;
  lastBitrateKbps = null;
}

// -------- controle manual de evento (botões "Entrar Evento" / "Voltar") --------
function startEventNow(filename, durationMin) {
  if (!isRunning()) throw new Error("a transmissão precisa estar no ar pra entrar em evento");
  const filePath = path.join(FILES_DIR, filename);
  if (!fs.existsSync(filePath)) throw new Error("arquivo não encontrado");
  const cfg = readConfig();
  cfg.activeEvent = { file: filename, expiresAt: durationMin ? Date.now() + durationMin * 60000 : null };
  writeConfig(cfg);
  pushLog(`evento manual iniciado: ${filename}`);
  switchFeederTo(filename);
}
function endEventNow() {
  const cfg = readConfig();
  if (!cfg.activeEvent) throw new Error("não tem evento ativo agora");
  cfg.activeEvent = null;
  writeConfig(cfg);
  pushLog("evento encerrado manualmente — voltando pra programação normal");
  const targetFile = pickBaseBlockFile(cfg.schedule, nowHHMM());
  if (targetFile) switchFeederTo(targetFile);
}

// ---------------------------------------------------------------------------
// auto-atualização — baixa do GitHub, valida com "node --check" antes de
// substituir (pra nunca trocar por um arquivo quebrado), e se reinicia
// sozinho (o systemd, com Restart=always, sobe a versão nova automaticamente).
// ---------------------------------------------------------------------------
function fetchUrl(urlStr) {
  return new Promise((resolve, reject) => {
    https.get(urlStr, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} ao baixar atualização`));
      let chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    }).on("error", reject);
  });
}
function extractVersion(source) {
  const match = source.match(/APP_VERSION\s*=\s*"([^"]+)"/);
  return match ? match[1] : null;
}
async function checkForUpdate() {
  const cfg = readConfig();
  const updateUrl = cfg.updateUrl || UPDATE_URL_DEFAULT;
  const remoteSource = await fetchUrl(updateUrl);
  const remoteVersion = extractVersion(remoteSource);
  return { remoteSource, remoteVersion, updateAvailable: remoteVersion && remoteVersion !== APP_VERSION };
}
function applyUpdateAndRestart(remoteSource) {
  return new Promise((resolve, reject) => {
    const tmpPath = path.join(__dirname, "index.update-check.js");
    fs.writeFileSync(tmpPath, remoteSource);
    exec(`node --check "${tmpPath}"`, (err) => {
      if (err) {
        fs.unlinkSync(tmpPath);
        return reject(new Error("o arquivo baixado tem erro de sintaxe — atualização cancelada, nada foi trocado"));
      }
      fs.renameSync(tmpPath, path.join(__dirname, "index.js"));
      pushLog("atualização aplicada — reiniciando em 2s...");
      resolve();
      setTimeout(() => process.exit(0), 2000); // o systemd (Restart=always) sobe a versão nova sozinho
    });
  });
}

// ---------------------------------------------------------------------------
// autenticação — a senha fica guardada (com hash) no config.json, definida
// pela própria página no primeiro acesso. PAINEL_PASSWORD (env) ainda
// funciona, se alguém preferir configurar assim (compatibilidade).
// ---------------------------------------------------------------------------
function hasPasswordConfigured() {
  const cfg = readConfig();
  return Boolean(cfg.passwordHash) || Boolean(process.env.PAINEL_PASSWORD);
}
function isAuthorized(req) {
  if (!hasPasswordConfigured()) return true; // ainda no modo "primeiro acesso"
  const cfg = readConfig();
  const auth = req.headers.authorization;
  if (!auth) return false;
  const [, encoded] = auth.split(" ");
  const decoded = Buffer.from(encoded || "", "base64").toString();
  const [, pass] = decoded.split(":");
  if (process.env.PAINEL_PASSWORD && pass === process.env.PAINEL_PASSWORD) return true;
  if (cfg.passwordHash && hashPassword(pass || "") === cfg.passwordHash) return true;
  return false;
}

// ---------------------------------------------------------------------------
// roteador
// ---------------------------------------------------------------------------
function mimeForFile(name) {
  const ext = path.extname(name).toLowerCase();
  return { ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mkv": "video/x-matroska" }[ext] || "application/octet-stream";
}

// serve o arquivo com suporte a Range (essencial pra dar play/adiantar o
// vídeo sem precisar baixar tudo primeiro) — rota pública, sem senha,
// porque é feita pra ser embutida no site.
function serveMedia(req, res, filename) {
  if (!isSafeName(filename)) { res.writeHead(400); return res.end("nome inválido"); }
  const filePath = path.join(FILES_DIR, filename);
  if (!fs.existsSync(filePath)) { res.writeHead(404); return res.end("não encontrado"); }
  const stat = fs.statSync(filePath);
  const mime = mimeForFile(filename);
  const range = req.headers.range;
  if (range) {
    const match = range.match(/bytes=(\d*)-(\d*)/);
    const start = match[1] ? parseInt(match[1], 10) : 0;
    const end = match[2] ? parseInt(match[2], 10) : stat.size - 1;
    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${stat.size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
      "Content-Type": mime
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { "Content-Length": stat.size, "Content-Type": mime, "Accept-Ranges": "bytes" });
    fs.createReadStream(filePath).pipe(res);
  }
}

function watchPageHtml(filename) {
  const safeTitle = filename.replace(/</g, "");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${safeTitle} — TV Sul Capixaba</title>
<style>html,body{margin:0;background:#000;height:100%;} video{width:100%;height:100%;display:block;}</style>
</head><body>
<video src="/media/${encodeURIComponent(filename)}" controls playsinline></video>
</body></html>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // -------- biblioteca de VOD — público, sem senha, pra poder embutir no site --------
  if (req.method === "GET" && pathname.startsWith("/media/")) {
    return serveMedia(req, res, decodeURIComponent(pathname.replace("/media/", "")));
  }
  if (req.method === "GET" && pathname.startsWith("/watch/")) {
    const filename = decodeURIComponent(pathname.replace("/watch/", ""));
    if (!fs.existsSync(path.join(FILES_DIR, filename))) { res.writeHead(404); return res.end("não encontrado"); }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(watchPageHtml(filename));
  }

  // -------- primeiro acesso: definir a senha (sem exigir autenticação) --------
  if (!hasPasswordConfigured()) {
    if (req.method === "GET" && pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(SETUP_HTML);
    }
    if (req.method === "POST" && pathname === "/api/setup") {
      const body = await readJsonBody(req);
      if (!body.password || body.password.length < 6) {
        return sendJson(res, 400, { error: "a senha precisa ter pelo menos 6 caracteres" });
      }
      const cfg = readConfig();
      cfg.passwordHash = hashPassword(body.password);
      writeConfig(cfg);
      return sendJson(res, 200, { ok: true });
    }
    // qualquer outra rota, enquanto não tiver senha, também cai na tela de setup
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(SETUP_HTML);
    }
  }

  if (!isAuthorized(req)) {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Painel TV Sul Capixaba"' });
    return res.end("Acesso restrito.");
  }

  try {
    // -------- página principal --------
    if (req.method === "GET" && pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(PAGE_HTML);
    }

    // -------- arquivos --------
    if (req.method === "GET" && pathname === "/api/files") {
      return sendJson(res, 200, { files: listFiles() });
    }
    if (req.method === "POST" && pathname === "/api/upload") {
      const filename = url.searchParams.get("filename");
      return handleUpload(req, res, filename);
    }
    if (req.method === "DELETE" && pathname.startsWith("/api/files/")) {
      const name = decodeURIComponent(pathname.replace("/api/files/", ""));
      if (!isSafeName(name)) return sendJson(res, 400, { error: "nome inválido" });
      const filePath = path.join(FILES_DIR, name);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      const cfg = readConfig();
      cfg.schedule = (cfg.schedule || []).filter((b) => b.file !== name);
      cfg.pendingEvents = (cfg.pendingEvents || []).filter((e) => e.file !== name);
      writeConfig(cfg);
      return sendJson(res, 200, { ok: true });
    }

    // -------- programação base (blocos por horário, repete todo dia) --------
    if (req.method === "GET" && pathname === "/api/schedule") {
      return sendJson(res, 200, { schedule: readConfig().schedule || [] });
    }
    if (req.method === "POST" && pathname === "/api/schedule") {
      const body = await readJsonBody(req);
      const cfg = readConfig();
      const existing = new Set(fs.readdirSync(FILES_DIR));
      const blocks = Array.isArray(body.schedule) ? body.schedule : [];
      cfg.schedule = blocks.filter((b) => b && isSafeName(b.file) && existing.has(b.file) && /^\d{2}:\d{2}$/.test(b.time));
      writeConfig(cfg);
      return sendJson(res, 200, { ok: true, schedule: cfg.schedule });
    }

    // -------- eventos agendados (disparo único, por horário) --------
    if (req.method === "GET" && pathname === "/api/events") {
      const cfg = readConfig();
      return sendJson(res, 200, { pendingEvents: cfg.pendingEvents || [], activeEvent: cfg.activeEvent || null });
    }
    if (req.method === "POST" && pathname === "/api/events") {
      const body = await readJsonBody(req);
      if (!isSafeName(body.file) || !fs.existsSync(path.join(FILES_DIR, body.file))) {
        return sendJson(res, 400, { error: "arquivo inválido" });
      }
      if (!/^\d{2}:\d{2}$/.test(body.time)) return sendJson(res, 400, { error: "horário inválido (use HH:MM)" });
      const durationMin = Number(body.durationMin) || 30;
      const cfg = readConfig();
      cfg.pendingEvents = cfg.pendingEvents || [];
      cfg.pendingEvents.push({ file: body.file, time: body.time, durationMin });
      writeConfig(cfg);
      return sendJson(res, 200, { ok: true, pendingEvents: cfg.pendingEvents });
    }
    if (req.method === "DELETE" && pathname.startsWith("/api/events/")) {
      const idx = Number(pathname.replace("/api/events/", ""));
      const cfg = readConfig();
      cfg.pendingEvents = cfg.pendingEvents || [];
      if (idx >= 0 && idx < cfg.pendingEvents.length) cfg.pendingEvents.splice(idx, 1);
      writeConfig(cfg);
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === "POST" && pathname === "/api/event/start") {
      const body = await readJsonBody(req);
      const durationMin = body.durationMin ? Number(body.durationMin) : null;
      startEventNow(body.file, durationMin);
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === "POST" && pathname === "/api/event/end") {
      endEventNow();
      return sendJson(res, 200, { ok: true });
    }

    // -------- configuração --------
    if (req.method === "GET" && pathname === "/api/config") {
      const cfg = readConfig();
      return sendJson(res, 200, { youtubeConfigured: Boolean(cfg.youtubeStreamKey), srtConfigured: Boolean(cfg.srtUrl) });
    }
    if (req.method === "POST" && pathname === "/api/config") {
      const body = await readJsonBody(req);
      const cfg = readConfig();
      if (typeof body.youtubeStreamKey === "string" && body.youtubeStreamKey.trim()) cfg.youtubeStreamKey = body.youtubeStreamKey.trim();
      if (typeof body.srtUrl === "string" && body.srtUrl.trim()) cfg.srtUrl = body.srtUrl.trim();
      writeConfig(cfg);
      return sendJson(res, 200, { ok: true });
    }

    // -------- controle --------
    if (req.method === "POST" && pathname === "/api/start") {
      startStream();
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === "POST" && pathname === "/api/stop") {
      stopStream();
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === "POST" && pathname === "/api/restart") {
      if (isRunning()) stopStream();
      startStream();
      return sendJson(res, 200, { ok: true });
    }

    // -------- status --------
    if (req.method === "GET" && pathname === "/api/status") {
      const cfg = readConfig();
      const base = {
        running: isRunning(),
        startedAt,
        uploadMbps: lastBitrateKbps ? Math.round((lastBitrateKbps / 1000) * 10) / 10 : null,
        scheduleCount: (cfg.schedule || []).length,
        nowPlaying: currentFeederFile,
        activeEvent: cfg.activeEvent || null
      };
      if (!isRunning() || !outerProcess) return sendJson(res, 200, { ...base, cpu: null, mem: null });
      return exec(`ps -p ${outerProcess.pid} -o %cpu,%mem --no-headers`, (err, stdout) => {
        if (err || !stdout.trim()) return sendJson(res, 200, { ...base, cpu: null, mem: null });
        const [cpu, mem] = stdout.trim().split(/\s+/).map(Number);
        return sendJson(res, 200, { ...base, cpu, mem });
      });
    }

    // -------- logs --------
    if (req.method === "GET" && pathname === "/api/logs") {
      return sendJson(res, 200, { logs: logBuffer.slice(-50) });
    }

    // -------- auto-atualização --------
    if (req.method === "GET" && pathname === "/api/version") {
      return sendJson(res, 200, { version: APP_VERSION });
    }
    if (req.method === "GET" && pathname === "/api/check-update") {
      try {
        const { remoteVersion, updateAvailable } = await checkForUpdate();
        return sendJson(res, 200, { currentVersion: APP_VERSION, remoteVersion, updateAvailable: Boolean(updateAvailable) });
      } catch (err) {
        return sendJson(res, 502, { error: err.message });
      }
    }
    if (req.method === "POST" && pathname === "/api/self-update") {
      try {
        const { remoteSource, remoteVersion } = await checkForUpdate();
        if (!remoteVersion) return sendJson(res, 502, { error: "não achei a versão no arquivo remoto — atualização cancelada" });
        await applyUpdateAndRestart(remoteSource);
        return sendJson(res, 200, { ok: true, newVersion: remoteVersion });
      } catch (err) {
        return sendJson(res, 502, { error: err.message });
      }
    }

    sendJson(res, 404, { error: "não encontrado" });
  } catch (err) {
    sendJson(res, 400, { error: err.message });
  }
});

// ---------------------------------------------------------------------------
// a página (single-page app, sem build, sem dependências)
// ---------------------------------------------------------------------------
const SETUP_HTML = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TV Sul Capixaba — Primeiro acesso</title>
<style>
  :root{--bg:#0B0E13;--surface:#12161D;--border:#242A34;--text:#F2F1EC;--muted:#9C9A93;--accent:#E8543E;--accent-on:#1A0705;}
  *{box-sizing:border-box;}
  body{margin:0;background:var(--bg);color:var(--text);font-family:-apple-system,"Segoe UI",sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px;}
  .card{max-width:380px;width:100%;background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:28px;}
  h1{font-size:17px;margin:0 0 6px;}
  p{color:var(--muted);font-size:13px;margin:0 0 20px;}
  input{width:100%;background:#1a1f28;border:1px solid var(--border);border-radius:8px;padding:12px;color:var(--text);font-size:14px;margin-bottom:14px;}
  button{background:var(--accent);color:var(--accent-on);border:none;border-radius:8px;padding:12px 18px;font-weight:700;font-size:14px;cursor:pointer;width:100%;}
  .msg{font-size:13px;margin-top:12px;padding:10px;border-radius:8px;display:none;}
  .msg.err{background:#321616;color:#f19a9a;display:block;}
</style>
</head>
<body>
  <div class="card">
    <h1>📡 TV Sul Capixaba</h1>
    <p>Primeiro acesso — crie uma senha pra proteger o painel. Só você vai poder ver isso a partir de agora.</p>
    <input type="password" id="pw1" placeholder="crie uma senha (mín. 6 caracteres)">
    <input type="password" id="pw2" placeholder="confirme a senha">
    <button id="btnSetup">Criar senha e entrar</button>
    <div class="msg" id="setupMsg"></div>
  </div>
<script>
document.getElementById('btnSetup').addEventListener('click', async () => {
  const pw1 = document.getElementById('pw1').value;
  const pw2 = document.getElementById('pw2').value;
  const msg = document.getElementById('setupMsg');
  if (pw1 !== pw2) { msg.textContent = 'as senhas não são iguais'; msg.className = 'msg err'; return; }
  const res = await fetch('/api/setup', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: pw1 })
  });
  const data = await res.json();
  if (res.ok) {
    location.reload();
  } else {
    msg.textContent = data.error; msg.className = 'msg err';
  }
});
</script>
</body>
</html>`;

const PAGE_HTML = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TV Sul Capixaba — Painel de Transmissão</title>
<style>
  :root{--bg:#0B0E13;--surface:#12161D;--surface2:#171C25;--border:#242A34;--text:#F2F1EC;--muted:#9C9A93;--accent:#E8543E;--accent-on:#1A0705;--green:#5FD068;}
  *{box-sizing:border-box;}
  body{margin:0;background:var(--bg);color:var(--text);font-family:-apple-system,"Segoe UI",sans-serif;display:flex;min-height:100vh;}
  aside{width:210px;background:var(--surface);border-right:1px solid var(--border);padding:20px 0;flex-shrink:0;}
  aside h1{font-size:15px;padding:0 20px 18px;margin:0;border-bottom:1px solid var(--border);margin-bottom:10px;}
  aside .navitem{display:block;padding:11px 20px;color:var(--muted);cursor:pointer;font-size:14px;border-left:3px solid transparent;}
  aside .navitem.active{color:var(--text);background:var(--surface2);border-left-color:var(--accent);}
  main{flex:1;padding:28px 32px;max-width:760px;}
  .page{display:none;} .page.active{display:block;}
  h2{font-size:18px;margin:0 0 18px;}
  .card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:20px;margin-bottom:18px;}
  .stat-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;}
  .stat{background:var(--surface2);border-radius:10px;padding:14px;text-align:center;}
  .stat .v{font-size:20px;font-weight:700;} .stat .l{font-size:11px;color:var(--muted);margin-top:4px;}
  .status-row{display:flex;align-items:center;gap:10px;margin-bottom:16px;font-size:14px;}
  .dot{width:10px;height:10px;border-radius:50%;background:#555;}
  .dot.on{background:var(--green);box-shadow:0 0 8px var(--green);} .dot.off{background:#666;}
  button{background:var(--accent);color:var(--accent-on);border:none;border-radius:8px;padding:11px 16px;font-weight:700;font-size:13px;cursor:pointer;}
  button.secondary{background:var(--surface2);color:var(--text);border:1px solid var(--border);}
  button:disabled{opacity:.45;cursor:not-allowed;}
  button.small{padding:6px 10px;font-size:12px;}
  .btnrow{display:flex;gap:10px;margin-top:14px;}
  input[type=text],input[type=file]{width:100%;background:#1a1f28;border:1px solid var(--border);border-radius:8px;padding:10px 12px;color:var(--text);font-size:14px;margin-bottom:12px;}
  label{display:block;font-size:12px;color:var(--muted);margin-bottom:6px;}
  ul.filelist{list-style:none;padding:0;margin:0;}
  ul.filelist li{display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border);font-size:13px;}
  ul.filelist li:last-child{border-bottom:none;}
  .fname{flex:1;}
  .fsize{color:var(--muted);font-size:12px;margin-right:10px;}
  .msg{font-size:13px;margin-top:10px;padding:9px 12px;border-radius:8px;display:none;}
  .msg.ok{background:#16321f;color:#8ee6a4;display:block;} .msg.err{background:#321616;color:#f19a9a;display:block;}
  #logBox{background:#000;border-radius:8px;padding:12px;font-family:monospace;font-size:12px;color:#8ee6a4;height:280px;overflow-y:auto;white-space:pre-wrap;}
  progress{width:100%;margin-top:6px;}
</style>
</head>
<body>

<aside>
  <h1>📡 TV Sul Capixaba</h1>
  <div class="navitem active" data-page="dashboard">Dashboard</div>
  <div class="navitem" data-page="arquivos">Arquivos</div>
  <div class="navitem" data-page="biblioteca">Biblioteca</div>
  <div class="navitem" data-page="programacao">Programação</div>
  <div class="navitem" data-page="eventos">Eventos</div>
  <div class="navitem" data-page="config">Configurações</div>
  <div class="navitem" data-page="logs">Logs</div>
</aside>

<main>

  <div class="page active" id="page-dashboard">
    <h2>Dashboard</h2>
    <div class="card">
      <div class="status-row"><div class="dot off" id="statusDot"></div><span id="statusText">verificando...</span></div>
      <div class="status-row" style="font-size:13px;color:var(--muted);"><span>tocando agora: <b id="nowPlaying" style="color:var(--text);">—</b></span></div>
      <div class="status-row" id="eventBanner" style="display:none;background:#2a1a0f;border:1px solid var(--accent);border-radius:8px;padding:10px 12px;">
        <span>🔴 evento no ar: <b id="eventFileLabel"></b></span>
      </div>
      <div class="stat-grid">
        <div class="stat"><div class="v" id="statCpu">—</div><div class="l">CPU</div></div>
        <div class="stat"><div class="v" id="statMem">—</div><div class="l">RAM</div></div>
        <div class="stat"><div class="v" id="statBitrate">—</div><div class="l">SAÍDA</div></div>
        <div class="stat"><div class="v" id="statUptime">—</div><div class="l">NO AR HÁ</div></div>
      </div>
      <div class="btnrow">
        <button id="btnStart">▶ Iniciar</button>
        <button id="btnStop" class="secondary">■ Parar</button>
        <button id="btnRestart" class="secondary">⟳ Reiniciar</button>
      </div>
      <div class="msg" id="controlMsg"></div>
    </div>
  </div>

  <div class="page" id="page-arquivos">
    <h2>Arquivos</h2>
    <div class="card">
      <input type="file" id="videoFile" accept="video/*">
      <button id="btnUpload">Enviar vídeo</button>
      <progress id="uploadProgress" value="0" max="100" style="display:none;"></progress>
      <div class="msg" id="uploadMsg"></div>
    </div>
    <div class="card">
      <ul class="filelist" id="fileList"></ul>
    </div>
  </div>

  <div class="page" id="page-biblioteca">
    <h2>Biblioteca (links públicos, pra embutir no site)</h2>
    <p style="color:var(--muted);font-size:13px;margin:-8px 0 16px;">Cada vídeo enviado já tem um link próprio de reprodução — dá pra compartilhar direto ou colocar num &lt;iframe&gt; no portal.</p>
    <div class="card">
      <ul class="filelist" id="libraryList"></ul>
    </div>
  </div>

  <div class="page" id="page-programacao">
    <h2>Programação base (repete todo dia)</h2>
    <p style="color:var(--muted);font-size:13px;margin:-8px 0 16px;">Cada bloco toca em loop até chegar a hora do próximo. Ex: 00:00 → Grandão A, 08:00 → Grandão B.</p>
    <div class="card">
      <ul class="filelist" id="scheduleList"></ul>
      <div class="btnrow" style="margin-top:16px;">
        <input type="text" id="schedTime" placeholder="HH:MM" style="max-width:100px;margin-bottom:0;">
        <select id="schedFile" style="flex:1;background:#1a1f28;border:1px solid var(--border);border-radius:8px;color:var(--text);padding:10px;"></select>
        <button id="btnAddBlock">+ adicionar bloco</button>
      </div>
      <div class="msg" id="scheduleMsg"></div>
    </div>
  </div>

  <div class="page" id="page-eventos">
    <h2>Eventos</h2>
    <div class="card">
      <h2 style="font-size:14px;">Entrar em evento agora</h2>
      <select id="eventFileNow" style="width:100%;background:#1a1f28;border:1px solid var(--border);border-radius:8px;color:var(--text);padding:10px;margin-bottom:12px;"></select>
      <label>Duração em minutos (deixe vazio pra ficar até você clicar em "voltar")</label>
      <input type="text" id="eventDurationNow" placeholder="ex: 30">
      <div class="btnrow">
        <button id="btnEventStart">🔴 Entrar Evento</button>
        <button id="btnEventEnd" class="secondary">⏮ Voltar à Programação</button>
      </div>
      <div class="msg" id="eventNowMsg"></div>
    </div>
    <div class="card">
      <h2 style="font-size:14px;">Agendar evento futuro (dispara sozinho no horário)</h2>
      <input type="text" id="schedEvTime" placeholder="HH:MM" style="max-width:100px;">
      <select id="schedEvFile" style="width:100%;background:#1a1f28;border:1px solid var(--border);border-radius:8px;color:var(--text);padding:10px;margin:10px 0;"></select>
      <label>Duração em minutos</label>
      <input type="text" id="schedEvDuration" placeholder="ex: 30">
      <button id="btnScheduleEvent">Agendar evento</button>
      <div class="msg" id="eventSchedMsg"></div>
      <ul class="filelist" id="pendingEventsList" style="margin-top:16px;"></ul>
    </div>
  </div>

  <div class="page" id="page-config">
    <h2>Configurações</h2>
    <div class="card">
      <label>Stream Key do YouTube</label>
      <input type="text" id="youtubeKey" placeholder="cole a chave do YouTube Studio aqui">
      <label>URL SRT da Soul TV (opcional)</label>
      <input type="text" id="srtUrl" placeholder="srt://...">
      <button id="btnSaveConfig">Salvar destinos</button>
      <div class="msg" id="configMsg"></div>
    </div>
    <div class="card">
      <div style="font-size:13px;color:var(--muted);margin-bottom:12px;">versão instalada: <b id="currentVersionLabel" style="color:var(--text);">—</b></div>
      <div class="btnrow" style="margin-top:0;">
        <button id="btnCheckUpdate" class="secondary">Verificar atualização</button>
        <button id="btnApplyUpdate" style="display:none;">⬆ Atualizar agora</button>
      </div>
      <div class="msg" id="updateMsg"></div>
    </div>
  </div>

  <div class="page" id="page-logs">
    <h2>Logs</h2>
    <div class="card"><div id="logBox">sem atividade ainda...</div></div>
  </div>

</main>

<script>

document.querySelectorAll('.navitem').forEach((item) => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.navitem').forEach((i) => i.classList.remove('active'));
    document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
    item.classList.add('active');
    document.getElementById('page-' + item.dataset.page).classList.add('active');
    if (item.dataset.page === 'arquivos') loadFiles();
    if (item.dataset.page === 'biblioteca') loadLibrary();
    if (item.dataset.page === 'programacao') loadSchedule();
    if (item.dataset.page === 'eventos') loadEvents();
    if (item.dataset.page === 'config') loadVersion();
  });
});

function showMsg(id, text, ok) {
  const el = document.getElementById(id);
  el.textContent = text;
  el.className = 'msg ' + (ok ? 'ok' : 'err');
}
function fmtUptime(startedAt) {
  if (!startedAt) return '—';
  const secs = Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000);
  const h = String(Math.floor(secs / 3600)).padStart(2, '0');
  const m = String(Math.floor((secs % 3600) / 60)).padStart(2, '0');
  const s = String(secs % 60).padStart(2, '0');
  return h + ':' + m + ':' + s;
}

async function refreshStatus() {
  const res = await fetch('/api/status');
  const data = await res.json();
  document.getElementById('statusDot').className = 'dot ' + (data.running ? 'on' : 'off');
  document.getElementById('statusText').textContent = data.running ? 'transmitindo agora' : 'parado';
  document.getElementById('btnStart').disabled = data.running;
  document.getElementById('btnStop').disabled = !data.running;
  document.getElementById('statCpu').textContent = data.cpu != null ? data.cpu + '%' : '—';
  document.getElementById('statMem').textContent = data.mem != null ? data.mem + '%' : '—';
  document.getElementById('statBitrate').textContent = data.uploadMbps != null ? data.uploadMbps + ' Mbps' : '—';
  document.getElementById('statUptime').textContent = fmtUptime(data.startedAt);
  document.getElementById('nowPlaying').textContent = data.nowPlaying || '—';
  const banner = document.getElementById('eventBanner');
  if (data.activeEvent) {
    banner.style.display = 'flex';
    document.getElementById('eventFileLabel').textContent = data.activeEvent.file;
  } else {
    banner.style.display = 'none';
  }
}

async function loadFiles() {
  const res = await fetch('/api/files');
  const data = await res.json();
  const ul = document.getElementById('fileList');
  ul.innerHTML = data.files.length ? '' : '<li>nenhum arquivo enviado ainda</li>';
  data.files.forEach((f) => {
    const li = document.createElement('li');
    li.innerHTML = '<span class="fname">' + f.name + '</span><span class="fsize">' + f.sizeMB + ' MB</span>';
    const btn = document.createElement('button');
    btn.className = 'small secondary';
    btn.textContent = 'excluir';
    btn.onclick = async () => { await fetch('/api/files/' + encodeURIComponent(f.name), { method: 'DELETE' }); loadFiles(); };
    li.appendChild(btn);
    ul.appendChild(li);
  });
}

async function populateFileSelect(selectEl) {
  const res = await fetch('/api/files');
  const { files } = await res.json();
  selectEl.innerHTML = files.length
    ? files.map(f => '<option value="' + f.name + '">' + f.name + '</option>').join('')
    : '<option value="">nenhum arquivo enviado ainda</option>';
}

async function loadLibrary() {
  const res = await fetch('/api/files');
  const { files } = await res.json();
  const ul = document.getElementById('libraryList');
  ul.innerHTML = files.length ? '' : '<li>nenhum arquivo enviado ainda</li>';
  files.forEach((f) => {
    const watchUrl = location.origin + '/watch/' + encodeURIComponent(f.name);
    const embedCode = '<iframe src="' + watchUrl + '" width="640" height="360" frameborder="0" allowfullscreen></iframe>';
    const li = document.createElement('li');
    li.style.flexDirection = 'column';
    li.style.alignItems = 'flex-start';
    li.style.gap = '6px';
    li.innerHTML =
      '<span class="fname" style="font-weight:600;">' + f.name + '</span>' +
      '<div style="display:flex;gap:8px;width:100%;">' +
        '<input type="text" readonly value="' + watchUrl + '" style="flex:1;margin:0;font-size:12px;">' +
        '<button class="small secondary" data-copy="' + watchUrl + '">copiar link</button>' +
      '</div>' +
      '<div style="display:flex;gap:8px;width:100%;">' +
        '<input type="text" readonly value=\'' + embedCode + '\' style="flex:1;margin:0;font-size:12px;">' +
        '<button class="small secondary" data-copy="' + embedCode.replace(/"/g, '&quot;') + '">copiar embed</button>' +
      '</div>';
    ul.appendChild(li);
  });
  ul.querySelectorAll('button[data-copy]').forEach((btn) => {
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(btn.getAttribute('data-copy'));
      btn.textContent = 'copiado!';
      setTimeout(() => { btn.textContent = btn.getAttribute('data-copy').startsWith('<iframe') ? 'copiar embed' : 'copiar link'; }, 1500);
    });
  });
}

// -------- programação base --------
async function loadSchedule() {
  await populateFileSelect(document.getElementById('schedFile'));
  const res = await fetch('/api/schedule');
  const { schedule } = await res.json();
  const ul = document.getElementById('scheduleList');
  const sorted = [...schedule].sort((a, b) => a.time.localeCompare(b.time));
  ul.innerHTML = sorted.length ? '' : '<li>nenhum bloco na programação ainda</li>';
  sorted.forEach((block) => {
    const li = document.createElement('li');
    li.innerHTML = '<span class="fname"><b>' + block.time + '</b> — ' + block.file + '</span>';
    const btn = document.createElement('button');
    btn.className = 'small secondary';
    btn.textContent = 'remover';
    btn.onclick = async () => {
      const rest = schedule.filter((b) => !(b.time === block.time && b.file === block.file));
      await fetch('/api/schedule', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ schedule: rest }) });
      loadSchedule();
    };
    li.appendChild(btn);
    ul.appendChild(li);
  });
}
document.getElementById('btnAddBlock').addEventListener('click', async () => {
  const time = document.getElementById('schedTime').value.trim();
  const file = document.getElementById('schedFile').value;
  if (!/^\d{2}:\d{2}$/.test(time) || !file) { showMsg('scheduleMsg', 'preencha horário (HH:MM) e escolha um arquivo', false); return; }
  const res = await fetch('/api/schedule');
  const { schedule } = await res.json();
  schedule.push({ time, file });
  const saveRes = await fetch('/api/schedule', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ schedule }) });
  showMsg('scheduleMsg', saveRes.ok ? 'bloco adicionado!' : 'falha ao salvar', saveRes.ok);
  document.getElementById('schedTime').value = '';
  loadSchedule();
});

// -------- eventos --------
async function loadEvents() {
  await populateFileSelect(document.getElementById('eventFileNow'));
  await populateFileSelect(document.getElementById('schedEvFile'));
  const res = await fetch('/api/events');
  const { pendingEvents } = await res.json();
  const ul = document.getElementById('pendingEventsList');
  ul.innerHTML = pendingEvents.length ? '' : '<li>nenhum evento agendado</li>';
  pendingEvents.forEach((ev, idx) => {
    const li = document.createElement('li');
    li.innerHTML = '<span class="fname"><b>' + ev.time + '</b> — ' + ev.file + ' (' + ev.durationMin + 'min)</span>';
    const btn = document.createElement('button');
    btn.className = 'small secondary';
    btn.textContent = 'cancelar';
    btn.onclick = async () => { await fetch('/api/events/' + idx, { method: 'DELETE' }); loadEvents(); };
    li.appendChild(btn);
    ul.appendChild(li);
  });
}
document.getElementById('btnEventStart').addEventListener('click', async () => {
  const file = document.getElementById('eventFileNow').value;
  const durationMin = document.getElementById('eventDurationNow').value.trim();
  if (!file) { showMsg('eventNowMsg', 'escolha um arquivo', false); return; }
  const res = await fetch('/api/event/start', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file, durationMin: durationMin || null })
  });
  const data = await res.json();
  showMsg('eventNowMsg', res.ok ? 'evento no ar!' : data.error, res.ok);
  refreshStatus();
});
document.getElementById('btnEventEnd').addEventListener('click', async () => {
  const res = await fetch('/api/event/end', { method: 'POST' });
  const data = await res.json();
  showMsg('eventNowMsg', res.ok ? 'voltou pra programação normal.' : data.error, res.ok);
  refreshStatus();
});
document.getElementById('btnScheduleEvent').addEventListener('click', async () => {
  const time = document.getElementById('schedEvTime').value.trim();
  const file = document.getElementById('schedEvFile').value;
  const durationMin = Number(document.getElementById('schedEvDuration').value.trim()) || 30;
  if (!/^\d{2}:\d{2}$/.test(time) || !file) { showMsg('eventSchedMsg', 'preencha horário (HH:MM) e escolha um arquivo', false); return; }
  const res = await fetch('/api/events', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ time, file, durationMin })
  });
  const data = await res.json();
  showMsg('eventSchedMsg', res.ok ? 'evento agendado!' : data.error, res.ok);
  document.getElementById('schedEvTime').value = '';
  loadEvents();
});

document.getElementById('btnUpload').addEventListener('click', async () => {
  const fileInput = document.getElementById('videoFile');
  if (!fileInput.files[0]) { showMsg('uploadMsg', 'escolha um arquivo primeiro', false); return; }
  const file = fileInput.files[0];
  const progress = document.getElementById('uploadProgress');
  progress.style.display = 'block';
  const xhr = new XMLHttpRequest();
  xhr.upload.addEventListener('progress', (e) => { progress.value = Math.round((e.loaded / e.total) * 100); });
  xhr.onload = () => {
    progress.style.display = 'none';
    if (xhr.status === 200) { showMsg('uploadMsg', 'vídeo enviado com sucesso!', true); loadFiles(); }
    else showMsg('uploadMsg', 'falha ao enviar o vídeo', false);
  };
  xhr.open('POST', '/api/upload?filename=' + encodeURIComponent(file.name));
  xhr.send(file);
});

document.getElementById('btnSaveConfig').addEventListener('click', async () => {
  const youtubeStreamKey = document.getElementById('youtubeKey').value;
  const srtUrl = document.getElementById('srtUrl').value;
  const res = await fetch('/api/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ youtubeStreamKey, srtUrl })
  });
  showMsg('configMsg', res.ok ? 'destinos salvos!' : 'falha ao salvar', res.ok);
  document.getElementById('youtubeKey').value = '';
  document.getElementById('srtUrl').value = '';
});

// -------- auto-atualização --------
async function loadVersion() {
  const res = await fetch('/api/version');
  const { version } = await res.json();
  document.getElementById('currentVersionLabel').textContent = version;
  document.getElementById('btnApplyUpdate').style.display = 'none';
  document.getElementById('updateMsg').style.display = 'none';
}
document.getElementById('btnCheckUpdate').addEventListener('click', async () => {
  showMsg('updateMsg', 'verificando...', true);
  const res = await fetch('/api/check-update');
  const data = await res.json();
  if (!res.ok) { showMsg('updateMsg', data.error, false); return; }
  if (data.updateAvailable) {
    showMsg('updateMsg', 'tem atualização disponível: ' + data.remoteVersion, true);
    document.getElementById('btnApplyUpdate').style.display = 'inline-block';
  } else {
    showMsg('updateMsg', 'já está na versão mais recente.', true);
  }
});
document.getElementById('btnApplyUpdate').addEventListener('click', async () => {
  showMsg('updateMsg', 'atualizando e reiniciando — aguarde uns 10 segundos...', true);
  const btn = document.getElementById('btnApplyUpdate');
  btn.disabled = true;
  try {
    const res = await fetch('/api/self-update', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) { showMsg('updateMsg', data.error, false); btn.disabled = false; return; }
  } catch (err) {
    // o processo pode já ter caído pra reiniciar antes da resposta chegar — normal
  }
  setTimeout(async () => {
    try {
      const check = await fetch('/api/version');
      const { version } = await check.json();
      showMsg('updateMsg', 'atualizado! versão agora: ' + version, true);
      document.getElementById('currentVersionLabel').textContent = version;
      btn.style.display = 'none';
      btn.disabled = false;
    } catch (err) {
      showMsg('updateMsg', 'ainda reiniciando, recarregue a página em alguns segundos...', false);
    }
  }, 6000);
});

document.getElementById('btnStart').addEventListener('click', async () => {
  const res = await fetch('/api/start', { method: 'POST' });
  const data = await res.json();
  showMsg('controlMsg', res.ok ? 'transmissão iniciada!' : data.error, res.ok);
  refreshStatus();
});
document.getElementById('btnStop').addEventListener('click', async () => {
  const res = await fetch('/api/stop', { method: 'POST' });
  const data = await res.json();
  showMsg('controlMsg', res.ok ? 'transmissão parada.' : data.error, res.ok);
  refreshStatus();
});
document.getElementById('btnRestart').addEventListener('click', async () => {
  const res = await fetch('/api/restart', { method: 'POST' });
  const data = await res.json();
  showMsg('controlMsg', res.ok ? 'transmissão reiniciada!' : data.error, res.ok);
  refreshStatus();
});

async function refreshLogs() {
  const res = await fetch('/api/logs');
  const data = await res.json();
  const box = document.getElementById('logBox');
  const wasAtBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 10;
  box.textContent = data.logs.join('\\n') || 'sem atividade ainda...';
  if (wasAtBottom) box.scrollTop = box.scrollHeight;
}

refreshStatus();
loadFiles();
setInterval(refreshStatus, 3000);
setInterval(refreshLogs, 3000);
</script>
</body>
</html>`;

server.listen(PORT, () => {
  // NOVO ▸ o Node corta requisições que demoram mais de 5 minutos por
  // padrão — pra um upload de vídeo grande numa conexão comum, isso é
  // fácil de bater e a barra trava sem aviso nenhum. Desligado aqui.
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.timeout = 0;
  console.log("Painel rodando na porta " + PORT + " (sem dependências externas)");
  const cfg = readConfig();
  if (cfg.wasRunning) {
    pushLog("painel reiniciado — retomando a transmissão automaticamente...");
    try { startStream(); } catch (err) { pushLog("não foi possível retomar: " + err.message); }
  }
});
