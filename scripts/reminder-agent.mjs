#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const API_URL = (process.env.KANBAN_API_URL || 'http://127.0.0.1:4000').replace(/\/$/, '');
const APP_URL = (process.env.KANBAN_APP_URL || API_URL).replace(/\/$/, '');
const API_TOKEN = process.env.KANBAN_API_TOKEN || process.env.API_TOKEN || '';
const LIMIT = Number.parseInt(process.env.KANBAN_REMINDER_LIMIT || '50', 10);
const INTERVAL_MS = Number.parseInt(process.env.KANBAN_REMINDER_INTERVAL_MS || '60000', 10);
const EMAIL_TO = process.env.KANBAN_REMINDER_EMAIL_TO || '';
const CALENDAR_NAME = process.env.KANBAN_REMINDER_CALENDAR_NAME || '';
const CALENDAR_DIR = process.env.KANBAN_REMINDER_CALENDAR_DIR ||
  path.join(homedir(), 'Library', 'Application Support', 'ObsidianKanban', 'calendar-reminders');
const STATE_PATH = process.env.KANBAN_REMINDER_STATE_PATH ||
  path.join(process.cwd(), 'data', 'reminder-delivery.json');

const args = new Set(process.argv.slice(2));

function log(message) {
  console.log(`[reminder-agent] ${new Date().toISOString()} ${message}`);
}

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveState(state) {
  mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

function effectiveAt(reminder) {
  return reminder.status === 'snoozed' && reminder.snoozed_until
    ? reminder.snoozed_until
    : reminder.trigger_at;
}

function deliveryKey(reminder) {
  return `${reminder.id}:${reminder.channel}:${effectiveAt(reminder)}`;
}

function commandExists(command) {
  const result = spawnSync('which', [command], { stdio: 'ignore' });
  return result.status === 0;
}

function runCommand(command, args) {
  try {
    execFileSync(command, args, { timeout: 20_000 });
  } catch (err) {
    const stdout = err.stdout?.toString().trim();
    const stderr = err.stderr?.toString().trim();
    const details = [stderr, stdout].filter(Boolean).join('\n');
    throw new Error(details || err.message || `Command failed: ${command}`);
  }
}

function appleString(value) {
  return `"${String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r\n?|\n/g, ' ')}"`;
}

function cardUrl(reminder) {
  const params = new URLSearchParams({
    board: String(reminder.board_id),
    card: String(reminder.card_id),
  });
  return `${APP_URL}/?${params.toString()}`;
}

function reminderTitle(reminder) {
  return reminder.card_title || `Kanban reminder ${reminder.id}`;
}

function reminderBody(reminder) {
  const parts = [];
  if (reminder.message) parts.push(reminder.message);
  parts.push(`Board: ${reminder.board_id}`);
  parts.push(`Card: ${cardUrl(reminder)}`);
  if (reminder.source_url) parts.push(`Source: ${reminder.source_url}`);
  return parts.join('\n');
}

async function api(pathname, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(init.headers || {}),
  };
  if (API_TOKEN) headers.Authorization = `Bearer ${API_TOKEN}`;

  const res = await fetch(`${API_URL}${pathname}`, {
    ...init,
    headers,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status} ${pathname}: ${text}`);
  }
  return res.json();
}

async function fireReminder(reminderId) {
  await api(`/api/reminders/${encodeURIComponent(reminderId)}/fire`, {
    method: 'POST',
    body: JSON.stringify({ at: new Date().toISOString() }),
  });
}

async function dueReminders(channel) {
  const params = new URLSearchParams({
    channel,
    before: new Date().toISOString(),
    limit: String(Number.isFinite(LIMIT) ? LIMIT : 50),
  });
  return api(`/api/reminders/due?${params.toString()}`);
}

async function remindersByChannel(channel, status) {
  const params = new URLSearchParams({
    channel,
    status,
    limit: String(Number.isFinite(LIMIT) ? LIMIT : 50),
  });
  return api(`/api/reminders?${params.toString()}`);
}

function notifyMacOS(reminder) {
  const title = `Kanban: ${reminderTitle(reminder)}`;
  const message = reminder.message || `Reminder for ${reminder.board_id}`;
  const openUrl = cardUrl(reminder);

  if (commandExists('terminal-notifier')) {
    runCommand('terminal-notifier', [
      '-title', title,
      '-message', message,
      '-subtitle', reminder.board_id,
      '-group', `obsidian-kanban-${reminder.id}`,
      '-open', openUrl,
    ]);
    return;
  }

  const script = `display notification ${appleString(message)} with title ${appleString(title)} subtitle ${appleString(reminder.board_id)} sound name "Glass"`;
  runCommand('osascript', ['-e', script]);
}

function sendMail(reminder) {
  const sourceMeta = reminder.source_meta && typeof reminder.source_meta === 'object' ? reminder.source_meta : {};
  const to = sourceMeta.email_to || sourceMeta.to || EMAIL_TO;
  if (!to) {
    throw new Error('KANBAN_REMINDER_EMAIL_TO is required for email reminders');
  }

  const subject = `Kanban reminder: ${reminderTitle(reminder)}`;
  const content = reminderBody(reminder);
  const script = `
tell application "Mail"
  set newMessage to make new outgoing message with properties {subject:${appleString(subject)}, content:${appleString(content)}, visible:false}
  tell newMessage
    make new to recipient at end of to recipients with properties {address:${appleString(to)}}
    send
  end tell
end tell`;

  runCommand('osascript', ['-e', script]);
}

function icsDate(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function icsEscape(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

function calendarTime(reminder) {
  return new Date(effectiveAt(reminder));
}

function appleDateAssignment(varName, date) {
  const seconds = date.getHours() * 60 * 60 + date.getMinutes() * 60 + date.getSeconds();
  return `
set ${varName} to current date
set year of ${varName} to ${date.getFullYear()}
set month of ${varName} to ${date.getMonth() + 1}
set day of ${varName} to ${date.getDate()}
set time of ${varName} to ${seconds}`;
}

function createCalendarAppEvent(reminder, calendarName) {
  const start = calendarTime(reminder);
  if (Number.isNaN(start.getTime())) {
    throw new Error(`Invalid calendar reminder time for ${reminder.id}`);
  }
  const end = new Date(start.getTime() + 30 * 60_000);
  const title = `Kanban: ${reminderTitle(reminder)}`;
  const description = reminderBody(reminder);
  const script = `
${appleDateAssignment('startDate', start)}
${appleDateAssignment('endDate', end)}
tell application "Calendar"
  if not (exists calendar ${appleString(calendarName)}) then error "Calendar not found: " & ${appleString(calendarName)}
  tell calendar ${appleString(calendarName)}
    set newEvent to make new event with properties {summary:${appleString(title)}, start date:startDate, end date:endDate, description:${appleString(description)}, url:${appleString(cardUrl(reminder))}}
    tell newEvent
      make new display alarm at end of display alarms with properties {trigger interval:0}
    end tell
  end tell
end tell`;

  runCommand('osascript', ['-e', script]);
  return `Calendar.app:${calendarName}`;
}

function createCalendarEvent(reminder) {
  const sourceMeta = reminder.source_meta && typeof reminder.source_meta === 'object' ? reminder.source_meta : {};
  const calendarName = sourceMeta.calendar_name || CALENDAR_NAME;
  if (calendarName) {
    return createCalendarAppEvent(reminder, calendarName);
  }

  const start = calendarTime(reminder);
  if (Number.isNaN(start.getTime())) {
    throw new Error(`Invalid calendar reminder time for ${reminder.id}`);
  }
  const end = new Date(start.getTime() + 30 * 60_000);
  const uid = `obsidian-kanban-${reminder.id}@local`;
  const filePath = path.join(CALENDAR_DIR, `${reminder.id}.ics`);

  mkdirSync(CALENDAR_DIR, { recursive: true });
  if (!existsSync(filePath)) {
    const body = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Obsidian Kanban//Reminders//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'BEGIN:VEVENT',
      `UID:${uid}`,
      `DTSTAMP:${icsDate(new Date())}`,
      `DTSTART:${icsDate(start)}`,
      `DTEND:${icsDate(end)}`,
      `SUMMARY:${icsEscape(`Kanban: ${reminderTitle(reminder)}`)}`,
      `DESCRIPTION:${icsEscape(reminderBody(reminder))}`,
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `DESCRIPTION:${icsEscape(reminder.message || reminderTitle(reminder))}`,
      'TRIGGER:-PT0M',
      'END:VALARM',
      'END:VEVENT',
      'END:VCALENDAR',
      '',
    ].join('\r\n');
    writeFileSync(filePath, body, 'utf8');
  }

  if (process.env.KANBAN_REMINDER_CALENDAR_OPEN !== '0') {
    runCommand('open', [filePath]);
  }
  return filePath;
}

async function deliverDue(channel, deliver) {
  const reminders = await dueReminders(channel);
  const state = loadState();
  for (const reminder of reminders) {
    const key = deliveryKey(reminder);
    try {
      if (!state[key]?.deliveredAt) {
        const latest = await api(`/api/reminders/${encodeURIComponent(reminder.id)}`);
        if (!['scheduled', 'snoozed'].includes(latest.status)) continue;
        deliver(latest);
        state[key] = { deliveredAt: new Date().toISOString() };
        saveState(state);
      }
      await fireReminder(reminder.id);
      state[key] = { ...state[key], firedAt: new Date().toISOString() };
      saveState(state);
      log(`${channel} delivered ${reminder.id}`);
    } catch (err) {
      console.error(`[reminder-agent] ${channel} failed ${reminder.id}:`, err.message || err);
    }
  }
}

async function syncCalendar() {
  const scheduled = await remindersByChannel('calendar', 'scheduled');
  const snoozed = await remindersByChannel('calendar', 'snoozed');
  const state = loadState();
  for (const reminder of [...scheduled, ...snoozed]) {
    const key = deliveryKey(reminder);
    try {
      let filePath = state[key]?.filePath;
      if (!state[key]?.deliveredAt) {
        const latest = await api(`/api/reminders/${encodeURIComponent(reminder.id)}`);
        if (!['scheduled', 'snoozed'].includes(latest.status)) continue;
        filePath = createCalendarEvent(latest);
        state[key] = { deliveredAt: new Date().toISOString(), filePath };
        saveState(state);
      }
      await fireReminder(reminder.id);
      state[key] = { ...state[key], firedAt: new Date().toISOString(), filePath };
      saveState(state);
      log(`calendar handed off ${reminder.id} -> ${filePath}`);
    } catch (err) {
      console.error(`[reminder-agent] calendar failed ${reminder.id}:`, err.message || err);
    }
  }
}

async function runOnce() {
  await deliverDue('macos', notifyMacOS);
  await deliverDue('email', sendMail);
  await syncCalendar();
}

if (args.has('--help')) {
  console.log(`Usage:
  node scripts/reminder-agent.mjs --once
  node scripts/reminder-agent.mjs --loop

Environment:
  KANBAN_API_URL=http://127.0.0.1:4000
  KANBAN_APP_URL=http://127.0.0.1:4000
  KANBAN_API_TOKEN=<optional API token>
  KANBAN_REMINDER_EMAIL_TO=<required for email channel>
  KANBAN_REMINDER_CALENDAR_NAME=<Calendar.app calendar name, e.g. "My Calendar">
  KANBAN_REMINDER_CALENDAR_OPEN=0 # write .ics without opening Calendar
`);
  process.exit(0);
}

if (args.has('--loop')) {
  const delay = Number.isFinite(INTERVAL_MS) ? INTERVAL_MS : 60000;
  const runLoop = async () => {
    try {
      await runOnce();
    } catch (err) {
      console.error('[reminder-agent] loop failed:', err);
    } finally {
      setTimeout(runLoop, delay);
    }
  };
  runLoop();
} else {
  try {
    await runOnce();
  } catch (err) {
    console.error('[reminder-agent] once failed:', err);
    process.exitCode = 1;
  } finally {
    process.exit(process.exitCode || 0);
  }
}
