const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { resolveBrandUrl } = require('./brands');
const { runChatSession, getBrowserEndpoint } = require('./chatRunner');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const CHATS_FILE = path.join(DATA_DIR, 'chats.json');

fs.mkdirSync(DATA_DIR, { recursive: true });

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const chats = new Map();
const stopFlags = new Set();

function loadChats() {
  try {
    if (fs.existsSync(CHATS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(CHATS_FILE, 'utf8'));
      for (const c of parsed) {
        // Recover any orphaned in-progress sessions after a restart
        if (['in-progress', 'queued', 'ringing'].includes(c.status)) {
          c.status = 'ended';
          c.endedAt = c.endedAt || new Date().toISOString();
        }
        chats.set(c.id, c);
      }
    }
  } catch (err) {
    console.error('Failed loading chats.json:', err.message);
  }
}

function saveChats() {
  try {
    const all = Array.from(chats.values()).sort(
      (a, b) => new Date(b.startedAt) - new Date(a.startedAt)
    );
    // Keep screenshots on latest 30 sessions so chats.json stays fast
    const trimmed = all.map((c, idx) =>
      idx > 30 ? { ...c, lastScreenshot: null } : c
    );
    fs.writeFileSync(CHATS_FILE, JSON.stringify(trimmed, null, 2));
  } catch (err) {
    console.error('Failed saving chats.json:', err.message);
  }
}

function broadcast(event, data) {
  const payload = JSON.stringify({ event, data });
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(payload);
    }
  }
}

loadChats();

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ event: 'INIT_STATE', data: Array.from(chats.values()) }));
});

function startSessionExecution(chat) {
  chat.status = 'queued';
  chat.startedAt = new Date().toISOString();
  chats.set(chat.id, chat);
  saveChats();
  broadcast('CHAT_UPDATED', chat);

  runChatSession(chat, {
    onUpdate: () => {
      chats.set(chat.id, chat);
      broadcast('CHAT_UPDATED', chat);
    },
    onTranscript: (chatId, segment) => {
      broadcast('TRANSCRIPT_UPDATE', { chatId, segment });
    },
    onComplete: () => {
      stopFlags.delete(chat.id);
      chats.set(chat.id, chat);
      saveChats();
      broadcast('CHAT_UPDATED', chat);
    },
    shouldStop: () => stopFlags.has(chat.id)
  });
}

// --- API Routes ---

app.get('/api/config', (req, res) => {
  res.json({ browserConfigured: Boolean(getBrowserEndpoint()) });
});

app.get('/api/sync-history', (req, res) => {
  broadcast('INIT_STATE', Array.from(chats.values()));
  res.json({ ok: true, count: chats.size });
});

app.post('/api/chats/start', (req, res) => {
  const {
    targetUrl,
    brand = 'Rogers',
    segment = 'Consumer',
    useCase = 'Billing',
    language = 'English',
    scheduleAt = null,
    scheduleBucket = ''
  } = req.body;

  const resolvedUrl = (targetUrl || '').trim() || resolveBrandUrl(brand, segment, useCase, language);
  if (!resolvedUrl) {
    return res.status(400).json({ error: 'Target chat URL is required.' });
  }

  const normSeg = /business|smb/i.test(segment) ? 'SMB' : 'Consumer';
  const normLang = /^fr/i.test(language) ? 'FR' : 'EN';
  const normUc = /sale/i.test(useCase) ? 'Sales' : 'Billing';

  // Smart conflict detection for scheduled runs (15-min overlap on identical config)
  if (scheduleAt) {
    const targetMs = new Date(scheduleAt).getTime();
    const conflict = Array.from(chats.values()).find((c) => {
      if (c.status !== 'scheduled') return false;
      const s = c.structuredOutputs || {};
      const sameConfig =
        (s.brand || '').toLowerCase() === brand.toLowerCase() &&
        s.segment === normSeg &&
        s.useCase === normUc &&
        s.language === normLang;
      if (!sameConfig) return false;
      return Math.abs(new Date(c.startedAt).getTime() - targetMs) < 15 * 60 * 1000;
    });

    if (conflict) {
      return res.status(409).json({
        error: `Conflict: ${brand} (${normSeg} • ${normUc} • ${normLang}) is already scheduled within 15 minutes.`
      });
    }
  }

  const id = `chat_${crypto.randomUUID().slice(0, 8)}`;
  const chat = {
    id,
    status: scheduleAt ? 'scheduled' : 'queued',
    targetUrl: resolvedUrl,
    bucket: scheduleBucket || '',
    startedAt: scheduleAt || new Date().toISOString(),
    endedAt: null,
    transcript: [],
    lastScreenshot: null,
    structuredOutputs: {
      brand,
      segment: normSeg,
      useCase: normUc,
      language: normLang,
      waitTimes: '—',
      timeToAgent: '—',
      botResponseSec: null,
      systemUsed: '',
      hoops: '',
      ivrOptions: '',
      cxToAgent: ''
    }
  };

  chats.set(id, chat);
  saveChats();
  broadcast('CHAT_UPDATED', chat);

  if (scheduleAt) {
    return res.json({ scheduled: true, chat });
  }

  startSessionExecution(chat);
  res.json({ scheduled: false, chat });
});

app.post('/api/chats/:id/end', (req, res) => {
  const { id } = req.params;
  if (!chats.has(id)) return res.status(404).json({ error: 'Chat not found.' });
  stopFlags.add(id);
  res.json({ ok: true });
});

app.delete('/api/chats/schedule/:id', (req, res) => {
  const { id } = req.params;
  if (!chats.has(id)) return res.status(404).json({ error: 'Schedule not found.' });
  chats.delete(id);
  saveChats();
  broadcast('CHAT_DELETED', { id });
  res.json({ ok: true });
});

app.delete('/api/chats/:id', (req, res) => {
  const { id } = req.params;
  if (!chats.has(id)) return res.status(404).json({ error: 'Chat not found.' });
  chats.delete(id);
  saveChats();
  broadcast('CHAT_DELETED', { id });
  res.json({ ok: true });
});

app.post('/api/chats/bulk-delete', (req, res) => {
  const { ids = [] } = req.body;
  ids.forEach((id) => chats.delete(id));
  saveChats();
  broadcast('CHATS_BULK_DELETED', { ids });
  res.json({ ok: true, deleted: ids.length });
});

// Scheduler loop (runs every 10s)
setInterval(() => {
  const now = Date.now();
  for (const chat of chats.values()) {
    if (chat.status === 'scheduled' && new Date(chat.startedAt).getTime() <= now) {
      startSessionExecution(chat);
    }
  }
}, 10000);

server.listen(PORT, () => {
  console.log(`Comp Chat dashboard running on port ${PORT}`);
});
