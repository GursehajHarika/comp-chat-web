const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const XLSX = require('xlsx');
const { BRANDS } = require('./brands');
const { runChatSession, getBrowserEndpoint } = require('./chatRunner');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const CHATS_FILE = path.join(DATA_DIR, 'chats.json');
const SCHEDULES_FILE = path.join(DATA_DIR, 'schedules.json');

fs.mkdirSync(DATA_DIR, { recursive: true });

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function readJson(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {}
  return fallback;
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

let chatHistory = readJson(CHATS_FILE, []);
let schedules = readJson(SCHEDULES_FILE, []);
const activeSessions = new Map();
const stopFlags = new Set();

function persistHistory() {
  // Keep screenshots only on latest 40 records to keep JSON lean
  const trimmed = chatHistory.map((c, idx) =>
    idx > 40 ? { ...c, lastScreenshot: null } : c
  );
  writeJson(CHATS_FILE, trimmed);
}

function launchSession({ brandId, segment = 'Billing', language = 'EN', customUrl = '' }) {
  const brand = BRANDS[brandId];
  if (!brand) throw new Error(`Unknown brand: ${brandId}`);

  const id = crypto.randomUUID().slice(0, 8);
  const session = {
    id,
    brandId,
    brandName: brand.name,
    brandColor: brand.color,
    segment,
    language,
    customUrl,
    status: 'running',
    step: 'Queued...',
    startedAt: new Date().toISOString(),
    endedAt: null,
    botResponseSec: null,
    agentWaitSec: null,
    totalDurationSec: 0,
    transcript: [],
    lastScreenshot: null,
    error: null
  };

  activeSessions.set(id, session);

  runChatSession(session, {
    onUpdate: () => {
      activeSessions.set(id, { ...session });
    },
    onComplete: () => {
      activeSessions.delete(id);
      stopFlags.delete(id);
      chatHistory.unshift({ ...session });
      persistHistory();
    },
    shouldStop: () => stopFlags.has(id)
  });

  return session;
}

// --- API Routes ---

app.get('/api/config', (req, res) => {
  res.json({
    brands: Object.values(BRANDS),
    browserConfigured: Boolean(getBrowserEndpoint())
  });
});

app.get('/api/chats', (req, res) => {
  res.json({
    active: Array.from(activeSessions.values()),
    history: chatHistory
  });
});

app.post('/api/chats/start', (req, res) => {
  const { brandIds = [], segment = 'Billing', language = 'EN', customUrl = '' } = req.body;
  if (!brandIds.length) return res.status(400).json({ error: 'Select at least one brand.' });

  const started = [];
  for (const brandId of brandIds) {
    if (BRANDS[brandId]) {
      started.push(launchSession({ brandId, segment, language, customUrl }));
    }
  }
  res.json({ started });
});

app.post('/api/chats/:id/stop', (req, res) => {
  const { id } = req.params;
  if (!activeSessions.has(id)) return res.status(404).json({ error: 'Session not active.' });
  stopFlags.add(id);
  res.json({ ok: true });
});

app.delete('/api/chats', (req, res) => {
  const { ids = [] } = req.body;
  const idSet = new Set(ids);
  chatHistory = chatHistory.filter((c) => !idSet.has(c.id));
  persistHistory();
  res.json({ deleted: ids.length });
});

// --- Schedules with 15-min conflict detection ---

app.get('/api/schedules', (req, res) => res.json(schedules));

app.post('/api/schedules', (req, res) => {
  const { brandIds = [], segment = 'Billing', language = 'EN', runAt } = req.body;
  if (!brandIds.length || !runAt) {
    return res.status(400).json({ error: 'brandIds and runAt are required.' });
  }

  const targetMs = new Date(runAt).getTime();
  const conflict = schedules.find(
    (s) =>
      s.status === 'pending' &&
      Math.abs(new Date(s.runAt).getTime() - targetMs) < 15 * 60 * 1000 &&
      s.brandIds.some((b) => brandIds.includes(b))
  );

  if (conflict && !req.body.force) {
    return res.status(409).json({
      error: `Conflict: overlapping schedule within 15 minutes (${new Date(conflict.runAt).toLocaleString()}).`,
      conflict
    });
  }

  const item = {
    id: crypto.randomUUID().slice(0, 8),
    brandIds,
    segment,
    language,
    runAt,
    status: 'pending',
    createdAt: new Date().toISOString()
  };
  schedules.push(item);
  writeJson(SCHEDULES_FILE, schedules);
  res.json(item);
});

app.delete('/api/schedules/:id', (req, res) => {
  schedules = schedules.filter((s) => s.id !== req.params.id);
  writeJson(SCHEDULES_FILE, schedules);
  res.json({ ok: true });
});

// --- Excel Matrix + Raw Logs Export ---

app.get('/api/export', (req, res) => {
  const wb = XLSX.utils.book_new();

  // Sheet 1: Brand Summary Matrix
  const summaryRows = Object.values(BRANDS).map((b) => {
    const logs = chatHistory.filter((c) => c.brandId === b.id);
    const avg = (vals) =>
      vals.length ? Number((vals.reduce((a, x) => a + x, 0) / vals.length).toFixed(1)) : '-';

    const botTimes = logs.map((c) => c.botResponseSec).filter((v) => v !== null);
    const waitTimes = logs.map((c) => c.agentWaitSec).filter((v) => v !== null);
    const billingWait = logs
      .filter((c) => c.segment === 'Billing' && c.agentWaitSec !== null)
      .map((c) => c.agentWaitSec);
    const salesWait = logs
      .filter((c) => c.segment === 'Sales' && c.agentWaitSec !== null)
      .map((c) => c.agentWaitSec);

    return {
      Brand: b.name,
      'Total Runs': logs.length,
      'Avg Bot Reply (s)': avg(botTimes),
      'Avg Agent Wait (s)': avg(waitTimes),
      'Billing Wait (s)': avg(billingWait),
      'Sales Wait (s)': avg(salesWait)
    };
  });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaryRows), 'Summary Matrix');

  // Sheet 2: Raw Logs
  const rawRows = chatHistory.map((c) => ({
    ID: c.id,
    Date: c.startedAt.slice(0, 10),
    Time: new Date(c.startedAt).toLocaleTimeString(),
    Brand: c.brandName,
    Segment: c.segment,
    Language: c.language,
    Status: c.status,
    'Bot Reply (s)': c.botResponseSec ?? '',
    'Agent Wait (s)': c.agentWaitSec ?? '',
    'Total Duration (s)': c.totalDurationSec,
    Transcript: c.transcript.map((m) => `[${m.sender}] ${m.text}`).join(' | ')
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rawRows), 'Chat Logs');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="comp-chat-report.xlsx"');
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  res.send(buf);
});

// Scheduler loop (every 30s)
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const sched of schedules) {
    if (sched.status === 'pending' && new Date(sched.runAt).getTime() <= now) {
      sched.status = 'triggered';
      changed = true;
      for (const brandId of sched.brandIds) {
        if (BRANDS[brandId]) {
          launchSession({ brandId, segment: sched.segment, language: sched.language });
        }
      }
    }
  }
  if (changed) writeJson(SCHEDULES_FILE, schedules);
}, 30000);

app.listen(PORT, () => {
  console.log(`Comp Chat dashboard running on port ${PORT}`);
});
