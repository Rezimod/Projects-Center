/**
 * check_reminders.js
 * Run by GitHub Actions cron — reads data.json, sends Telegram reminders.
 * Commits updated lastSent timestamps back to repo.
 */

const fs    = require('fs');
const https = require('https');

const BOT     = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!BOT || !CHAT_ID) {
  console.log('No Telegram credentials — skipping.');
  process.exit(0);
}

let data;
try {
  data = JSON.parse(fs.readFileSync('data.json', 'utf8'));
} catch {
  console.log('data.json not found or invalid.');
  process.exit(0);
}

const projects = data.projects || [];
const now      = new Date();
const todayStr = now.toDateString();
const TIMING   = { today: 0, oneday: 1, threedays: 3, oneweek: 7 };

function sendTelegram(text) {
  return new Promise(resolve => {
    const body = JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML' });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${BOT}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => { res.resume(); resolve(); });
    req.on('error', () => resolve());
    req.write(body);
    req.end();
  });
}

async function main() {
  let changed = false;

  for (const p of projects) {
    if (!p.reminder?.enabled || !p.due || p.progress >= 100) continue;

    const due      = new Date(p.due + 'T23:59:00');
    const daysLeft = Math.ceil((due - now) / 86400000);
    const threshold = TIMING[p.reminder.timing ?? 'oneday'] ?? 1;

    if (daysLeft > threshold) continue;

    const lastSent = p.reminder.lastSent ? new Date(p.reminder.lastSent) : null;
    if (lastSent && lastSent.toDateString() === todayStr) continue;

    let msg;
    if      (daysLeft < 0)  msg = `⚠️ <b>Overdue!</b>\n📌 "${p.name}"\nWas due ${Math.abs(daysLeft)}d ago · ${p.progress}% done`;
    else if (daysLeft === 0) msg = `📅 <b>Due today!</b>\n📌 "${p.name}"\n${p.progress}% done`;
    else                     msg = `⏰ <b>Reminder</b>\n📌 "${p.name}"\nDue in ${daysLeft}d · ${p.progress}% done`;

    await sendTelegram(msg);
    console.log(`Sent reminder for "${p.name}" (${daysLeft}d left)`);

    p.reminder.lastSent = now.toISOString();
    changed = true;
  }

  if (changed) {
    data.projects = projects;
    fs.writeFileSync('data.json', JSON.stringify(data, null, 2));
    console.log('Updated data.json with lastSent timestamps.');
  } else {
    console.log('No reminders due today.');
  }
}

main().catch(console.error);
