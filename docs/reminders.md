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

- `in_app`
- `browser`
- `macos`
- `calendar`
- `email`

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

## macOS Delivery Plan

The current implementation provides the API/UI state needed for delivery. The next implementation step is a local macOS notifier:

1. A small local checker polls `/api/reminders/due?channel=macos`.
2. It sends a Notification Center alert with the card title and reminder message.
3. After successful delivery it calls `/api/reminders/:id/fire`.
4. Snooze/dismiss continue to happen through the Kanban UI first; native notification actions can be added later.

For launch scheduling, use a per-user `launchd` agent rather than `cron`.
