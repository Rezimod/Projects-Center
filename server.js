/**
 * Projects Center — server.js
 * Serves the app, persists data to data.json, sends Telegram reminders.
 */

require('dotenv').config();
const express = require('express');
const fs      = require('fs');
const path    = require('path');
const https   = require('https');

const app      = express();
const PORT     = process.env.PORT || 3000;
const BOT      = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID  = process.env.TELEGRAM_CHAT_ID;
const DATA     = path.join(__dirname, 'data.json');

app.use(express.json({ limit: '5mb' }));

// ── Serve app ───────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ── Data API ─────────────────────────────────────────────────────────────────
app.get('/api/data', (req, res) => {
  try {
    const raw = fs.existsSync(DATA) ? fs.readFileSync(DATA, 'utf8') : '{}';
    res.json(JSON.parse(raw));
  } catch (e) {
    res.json({});
  }
});

app.post('/api/data', (req, res) => {
  try {
    fs.writeFileSync(DATA, JSON.stringify(req.body, null, 2));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Telegram sender ──────────────────────────────────────────────────────────
function sendTelegram(text) {
  if (!BOT || !CHAT_ID) return;
  const body = JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML' });
  const req = https.request({
    hostname: 'api.telegram.org',
    path: `/bot${BOT}/sendMessage`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  }, res => {
    res.resume();
  });
  req.on('error', () => {});
  req.write(body);
  req.end();
}

// ── Reminder checker ─────────────────────────────────────────────────────────
const TIMING_DAYS = { today: 0, oneday: 1, threedays: 3, oneweek: 7 };

function checkReminders() {
  if (!fs.existsSync(DATA)) return;
  let data;
  try { data = JSON.parse(fs.readFileSync(DATA, 'utf8')); } catch { return; }

  const projects = data.projects || [];
  const now      = new Date();
  const todayStr = now.toDateString();
  let changed    = false;

  projects.forEach(p => {
    if (!p.reminder?.enabled || !p.due || p.progress >= 100) return;

    const due      = new Date(p.due + 'T23:59:00');
    const daysLeft = Math.ceil((due - now) / 86400000);
    const threshold = TIMING_DAYS[p.reminder.timing ?? 'oneday'] ?? 1;

    if (daysLeft > threshold) return;

    const lastSent = p.reminder.lastSent ? new Date(p.reminder.lastSent) : null;
    if (lastSent && lastSent.toDateString() === todayStr) return;

    let msg;
    if (daysLeft < 0)
      msg = `⚠️ <b>Overdue!</b>\n📌 "${p.name}"\nWas due ${Math.abs(daysLeft)} day${Math.abs(daysLeft)!==1?'s':''} ago · ${p.progress}% done`;
    else if (daysLeft === 0)
      msg = `📅 <b>Due today!</b>\n📌 "${p.name}"\n${p.progress}% done`;
    else
      msg = `⏰ <b>Reminder</b>\n📌 "${p.name}"\nDue in ${daysLeft} day${daysLeft!==1?'s':''} · ${p.progress}% done`;

    sendTelegram(msg);
    p.reminder.lastSent = now.toISOString();
    changed = true;
    console.log(`[reminder] Sent for "${p.name}" (${daysLeft}d left)`);
  });

  if (changed) {
    data.projects = projects;
    fs.writeFileSync(DATA, JSON.stringify(data, null, 2));
  }
}

// Check on startup and every 5 minutes
checkReminders();
setInterval(checkReminders, 5 * 60 * 1000);

// ── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  let localIP = 'localhost';
  for (const iface of Object.values(nets)) {
    for (const net of iface) {
      if (net.family === 'IPv4' && !net.internal) { localIP = net.address; break; }
    }
    if (localIP !== 'localhost') break;
  }
  console.log(`\n  Projects Center running\n`);
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Network: http://${localIP}:${PORT}  ← open this on your phone\n`);
});
