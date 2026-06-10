# Reminders

Reminders are Kanban-owned runtime metadata stored in SQLite. They are intentionally separate from `cards.due_date`:

- `due_date` is a date-level deadline shown on the card.
- `reminders.trigger_at` is a timezone-aware datetime used for in-app and desktop notification workflows.

Reminders are not written back to Obsidian Markdown files.

## Data Contract

Reminder status values:

- `scheduled` — active, waiting for `trigger_at`
- `snoozed` — active, waiting for `snoozed_until`
- `fired` — delivered by a notification agent
- `dismissed` — manually dismissed

Reminder channel values:

- `in_app` — shown inside the Kanban UI.
- `browser` — delivered by the open Kanban browser tab through the Web Notifications API.
- `macos` — delivered by the local macOS reminder agent through Notification Center.
- `calendar` — handed off by the local macOS reminder agent as an `.ics` Calendar event.
- `email` — delivered by the local macOS reminder agent through Mail.app.

`trigger_at`, `snoozed_until`, `last_fired_at`, and `dismissed_at` are stored as ISO datetimes. Incoming datetime values must include `Z` or an explicit offset.

## API

List board reminders:

```http
GET /api/reminders?board_id=work
```

List card reminders:

```http
GET /api/reminders?card_id=<card-id>
```

Create a reminder:

```http
POST /api/reminders
Content-Type: application/json

{
  "card_id": "<card-id>",
  "kind": "follow_up",
  "channel": "macos",
  "trigger_at": "2026-06-05T09:00:00+02:00",
  "timezone": "Europe/Madrid",
  "message": "Check whether the customer replied"
}
```

Poll due reminders:

```http
GET /api/reminders/due?before=2026-06-05T09:00:00Z&channel=macos&limit=50
```

Snooze:

```http
POST /api/reminders/<id>/snooze
Content-Type: application/json

{ "minutes": 60 }
```

Dismiss:

```http
POST /api/reminders/<id>/dismiss
Content-Type: application/json

{}
```

Mark as delivered:

```http
POST /api/reminders/<id>/fire
Content-Type: application/json

{}
```

## Email Follow-Up Identity

Email reminders should use stable source identity:

```json
{
  "source": "email",
  "source_uid": "email:gmail:me@example.com:thread:abc123",
  "source_url": "https://mail.google.com/mail/u/0/#all/abc123",
  "source_meta": {
    "provider": "gmail",
    "thread_id": "abc123"
  }
}
```

For the same `card_id`, `source`, and `source_uid`, repeated create calls return the existing reminder. This keeps Claude/email workflows safe to retry.

## Delivery Channels

### In-App

In-app reminders are visible in the Kanban UI as card badges, the header reminder counter, and the reminders panel. They do not require any external service.

### Browser

Browser reminders work while the Kanban web app is open. The app polls:

```http
GET /api/reminders/due?channel=browser&board_id=<active-board-id>
```

When the browser permission is granted, due reminders are shown with `new Notification(...)`; clicking the notification focuses Kanban and opens the card. After display, the app calls `/api/reminders/:id/fire`.

### macOS, Calendar, Email

These channels are delivered by `scripts/reminder-agent.mjs`.

Run once:

```bash
pnpm reminders:agent
```

Install as a per-user `launchd` job:

```bash
KANBAN_API_URL=http://127.0.0.1:4000 \
KANBAN_APP_URL=http://127.0.0.1:4000 \
KANBAN_REMINDER_CALENDAR_NAME="Sergi Sinyugin" \
KANBAN_REMINDER_EMAIL_TO=you@example.com \
pnpm reminders:macos:install
```

The installer writes:

```text
~/Library/LaunchAgents/com.obsidian-kanban.reminders.plist
```

Logs:

```text
~/Library/Logs/ObsidianKanban/reminders.out.log
~/Library/Logs/ObsidianKanban/reminders.err.log
```

Agent behavior:

- `macos`: polls due reminders with `channel=macos`, sends a Notification Center notification, then calls `/fire`. If `terminal-notifier` is installed, notification clicks open the card URL; otherwise the agent falls back to a plain `osascript` notification.
- `email`: polls due reminders with `channel=email`, sends through Mail.app, then calls `/fire`. The recipient comes from `source_meta.email_to`, `source_meta.to`, or `KANBAN_REMINDER_EMAIL_TO`.
- `calendar`: syncs scheduled/snoozed reminders with `channel=calendar`. If `KANBAN_REMINDER_CALENDAR_NAME` or `source_meta.calendar_name` is set, the agent creates the event directly in that Calendar.app calendar. Otherwise it falls back to creating an `.ics` file and opening it with Calendar.app. After handoff, it calls `/fire`; in Kanban, `fired` means "handed off to Calendar.app", and Calendar owns the final alert.

Mail.app delivery from `launchd` depends on macOS Automation privacy permissions. If logs show `Not authorised to send Apple events to Mail. (-1743)`, grant Mail automation access for the Node/osascript process in System Settings > Privacy & Security > Automation, or run `pnpm reminders:agent` from an interactive user session for one-off delivery.

The agent stores a local delivery ledger at:

```text
data/reminder-delivery.json
```

This prevents duplicate OS/email/calendar delivery if the process crashes after local delivery but before `/fire`.

If `API_TOKEN` is enabled for the Kanban API, set `KANBAN_API_TOKEN` for the agent. Do not commit tokens to the repository.
