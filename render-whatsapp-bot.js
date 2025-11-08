/* render-whatsapp-bot.js
 - Baileys WhatsApp connection
 - Express API + static public/ (dashboard)
 - /check-jid, /send, /upload-lines, /events (SSE)
 - 10s default delay for sends and bulk lines
*/
const express = require('express');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeInMemoryStore
} = require('@adiwajshing/baileys');

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const AUTH_DIR = process.env.AUTH_DIR || './auth_info';
const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads';
const WEBHOOK_URL = process.env.WEBHOOK_URL || null;

if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// SSE clients
const sseClients = new Set();
function sseSend(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch (e) { /* ignore */ }
  }
}

// multer for uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const upload = multer({ storage });

// in-memory store
const store = makeInMemoryStore({ logger });

let sock = null;
let saveCreds = null;

(async () => {
  const { state, saveCreds: _saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  saveCreds = _saveCreds;

  let version = [2, 2311, 4];
  try {
    const v = await fetchLatestBaileysVersion();
    version = v.version;
    logger.info({ version }, 'Using Baileys WA version');
  } catch (e) {
    logger.warn('Could not fetch latest WA version; using fallback');
  }

  async function startSock() {
    sock = makeWASocket({
      logger,
      printQRInTerminal: false,
      auth: state,
      version,
      browser: ['render-whatsapp-bot', 'Chrome', '1.0.0']
    });

    store.bind(sock.ev);
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        qrcode.generate(qr, { small: true }, (q) => logger.info('\n' + q));
        logger.info('QR code printed to logs. Scan with WhatsApp -> Linked Devices -> Link a device.');
        sseSend({ type: 'qr', message: 'QR generated - check logs' });
      }
      if (connection === 'close') {
        const reason = (lastDisconnect?.error)?.output?.statusCode || lastDisconnect?.error?.name || 'unknown';
        logger.warn({ lastDisconnect }, `connection closed: ${reason}`);
        sseSend({ type: 'status', connection: 'closed', reason });
        const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
        if (shouldReconnect) setTimeout(startSock, 2000);
      }
      if (connection === 'open') {
        logger.info('✅ WhatsApp connection open');
        sseSend({ type: 'status', connection: 'open' });
      }
    });

    sock.ev.on('messages.upsert', async (m) => {
      const messages = m.messages || [];
      for (const msg of messages) {
        if (!msg.message) continue;
        const simplified = {
          id: msg.key.id,
          remoteJid: msg.key.remoteJid,
          fromMe: !!msg.key.fromMe,
          timestamp: msg.messageTimestamp?.low || msg.messageTimestamp || Date.now(),
          message: msg.message
        };
        logger.info({ simplified }, 'incoming message');
        sseSend({ type: 'message', data: simplified });
        if (WEBHOOK_URL) {
          try {
            await fetch(WEBHOOK_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ event: 'message', data: simplified })
            });
          } catch (err) {
            logger.warn({ err }, 'Failed webhook');
          }
        }
      }
    });

    return sock;
  }

  startSock().catch((e) => { logger.error({ e }, 'Failed to start socket'); process.exit(1); });
})();

function normalizeJid(input) {
  if (!input) return null;
  input = String(input).trim();
  if (input.includes('@')) return input;
  if (/^\d+$/.test(input)) return `${input}@s.whatsapp.net`;
  return null;
}

// check-jid
app.post('/check-jid', (req, res) => {
  const text = req.body?.jid || req.query?.jid || '';
  const normalized = normalizeJid(text);
  const ok = !!normalized;
  res.json({ ok, normalized });
});

// send with optional delayMs (defaults to 10000)
app.post('/send', async (req, res) => {
  try {
    const { to, message, delayMs } = req.body || {};
    if (!to || !message) return res.status(400).json({ error: 'Missing to or message' });
    if (!sock) return res.status(500).json({ error: 'Socket not ready' });
    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
    const d = parseInt(delayMs || 10000, 10);
    if (d > 0) await new Promise(r => setTimeout(r, d));
    const r = await sock.sendMessage(jid, { text: message });
    res.json({ ok: true, result: r });
    sseSend({ type: 'send', to: jid, message, status: 'sent' });
  } catch (err) {
    logger.error({ err }, 'send error');
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// upload-lines: accepts form-data with file field 'file' and field 'to'; sends each non-empty line with delay
app.post('/upload-lines', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const toRaw = req.body.to;
    if (!toRaw) return res.status(400).json({ error: 'Missing `to` field' });
    const jid = toRaw.includes('@') ? toRaw : `${toRaw}@s.whatsapp.net`;
    const delayMs = parseInt(req.body.delayMs || '10000', 10);

    const filePath = req.file.path;
    const text = fs.readFileSync(filePath, 'utf8');
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
    if (lines.length === 0) return res.status(400).json({ error: 'No non-empty lines found in file' });

    (async () => {
      sseSend({ type: 'bulkStart', total: lines.length, to: jid });
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        try {
          if (!sock) throw new Error('Socket not ready');
          await new Promise(r => setTimeout(r, delayMs));
          await sock.sendMessage(jid, { text: line });
          sseSend({ type: 'bulkProgress', index: i+1, total: lines.length, line });
        } catch (err) {
          sseSend({ type: 'bulkError', index: i+1, error: String(err) });
          logger.error({ err }, 'Error sending line');
        }
      }
      sseSend({ type: 'bulkDone', total: lines.length, to: jid });
    })();

    res.json({ ok: true, uploading: true, lines: lines.length });
  } catch (err) {
    logger.error({ err }, 'upload error');
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// SSE events endpoint
app.get('/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write('retry: 10000\n\n');
  sseClients.add(res);
  req.on('close', () => { sseClients.delete(res); });
});

app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const port = process.env.PORT || 3000;
app.listen(port, () => logger.info(`HTTP server listening on ${port}`));