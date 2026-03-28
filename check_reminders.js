/**
 * check_reminders.js
 * Run by GitHub Actions on weekday schedule slots.
 * Sends:
 * - 12:00 Tbilisi weekday daily-task brief
 * - 15:00 Tbilisi weekday weekly-task brief
 * - due-date reminders for projects nearing their deadline
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
const planner  = data.planner || {};
planner.dailyTasks = Array.isArray(planner.dailyTasks) ? planner.dailyTasks : [];
planner.weeklyTasks = Array.isArray(planner.weeklyTasks) ? planner.weeklyTasks : [];
planner.monthlyGoals = Array.isArray(planner.monthlyGoals) ? planner.monthlyGoals : [];
planner.dailyFocus = planner.dailyFocus || {};
planner.weeklyPlan = planner.weeklyPlan || {};
planner.telegramSchedule = planner.telegramSchedule || { timezone: 'Asia/Tbilisi', dailyWeekday: '12:00', weeklyWeekday: '15:00' };
planner.telegramLog = planner.telegramLog || {};

const now      = new Date();
const todayStr = now.toDateString();
const TIMING   = { today: 0, oneday: 1, threedays: 3, oneweek: 7 };
const TZ       = planner.telegramSchedule.timezone || 'Asia/Tbilisi';

function tzParts(date = new Date(), timeZone = TZ) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(date).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});

  return {
    weekday: parts.weekday,
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    timeKey: `${parts.hour}:${parts.minute}`
  };
}

function isWeekdayInTbilisi(date = new Date()) {
  return !['Sat', 'Sun'].includes(tzParts(date).weekday);
}

function buildDailyTaskDigest() {
  const dateLabel = now.toLocaleDateString('en-US', { timeZone: TZ, weekday: 'long', month: 'long', day: 'numeric' });
  const done = planner.dailyTasks.filter(t => t.done).length;
  const undone = planner.dailyTasks.filter(t => !t.done);
  const parts = [`☀️ <b>Daily Orbit — ${dateLabel}</b>`];
  if (planner.dailyFocus.mustDo)  parts.push(`\n🎯 <b>Must Do</b>\n${planner.dailyFocus.mustDo}`);
  if (planner.dailyFocus.stretch) parts.push(`\n🪐 <b>Stretch</b>\n${planner.dailyFocus.stretch}`);
  if (planner.dailyFocus.note)    parts.push(`\n📝 <b>Note</b>\n${planner.dailyFocus.note}`);
  parts.push(`\n✅ <b>Daily Tasks</b> (${done}/${planner.dailyTasks.length} done)`);
  parts.push(undone.length ? undone.map(t => `• ${t.text}`).join('\n') : 'All daily tasks complete.');
  return parts.join('\n');
}

function buildWeeklyTaskDigest() {
  const done = planner.weeklyTasks.filter(t => t.done).length;
  const undone = planner.weeklyTasks.filter(t => !t.done);
  const parts = [`🌌 <b>Weekly Compass</b>`];
  if (planner.weeklyPlan.theme) parts.push(`\n🧭 <b>Theme</b>\n${planner.weeklyPlan.theme}`);
  if (planner.weeklyPlan.win)   parts.push(`\n🏁 <b>Win</b>\n${planner.weeklyPlan.win}`);
  if (planner.weeklyPlan.risk)  parts.push(`\n⚠️ <b>Risk</b>\n${planner.weeklyPlan.risk}`);
  parts.push(`\n📅 <b>Weekly Tasks</b> (${done}/${planner.weeklyTasks.length} done)`);
  parts.push(undone.length ? undone.map(t => `• ${t.text}`).join('\n') : 'All weekly tasks complete.');
  return parts.join('\n');
}

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
  const tb = tzParts(now);

  if (isWeekdayInTbilisi(now)) {
    const dailyTime = planner.telegramSchedule.dailyWeekday || '12:00';
    const weeklyTime = planner.telegramSchedule.weeklyWeekday || '15:00';

    if (tb.timeKey === dailyTime && planner.telegramLog.dailyTaskDigestSentOn !== tb.dateKey) {
      await sendTelegram(buildDailyTaskDigest());
      planner.telegramLog.dailyTaskDigestSentOn = tb.dateKey;
      changed = true;
      console.log(`[digest] Sent weekday daily brief at ${tb.timeKey} ${TZ}`);
    }

    if (tb.timeKey === weeklyTime && planner.telegramLog.weeklyTaskDigestSentOn !== tb.dateKey) {
      await sendTelegram(buildWeeklyTaskDigest());
      planner.telegramLog.weeklyTaskDigestSentOn = tb.dateKey;
      changed = true;
      console.log(`[digest] Sent weekday weekly brief at ${tb.timeKey} ${TZ}`);
    }
  }

  // ── Due-date reminders ─────────────────────────────────────────────────────
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
    console.log(`[reminder] Sent for "${p.name}" (${daysLeft}d left)`);

    p.reminder.lastSent = now.toISOString();
    changed = true;
  }

  if (changed) {
    data.projects = projects;
    data.planner = planner;
    fs.writeFileSync('data.json', JSON.stringify(data, null, 2));
    console.log('Updated data.json with lastSent timestamps.');
  }
}

main().catch(console.error);
