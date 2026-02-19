# Changelog

## 2026-02-19

### Board Management
- **Create boards** from UI — [+] button in header tabs
- **Archive/Restore** — right-click board tab → Archive, 📦 button to restore
- **Rename** — right-click → Rename (inline edit)
- **Delete** — removes from config, keeps .md file

### Recovery System
- **kb:col markers** — column assignments stored in .md files for disaster recovery
- **Safety guards** — reconciler refuses bulk deletes (>80% or all cards)
- **DB backups** — automatic on startup, keeps last 3
- **Test isolation** — fixed critical bug: tests were wiping production DB

### Documentation
- Comprehensive README with setup guide, Obsidian instructions, troubleshooting

## 2026-02-18

### Phase 5: Automations
- Rule engine with triggers (card.created, card.moved) and actions (set_field, add_comment, move_card)
- Automations panel UI

### Phase 4: Custom Fields
- Per-board custom fields (TEXT, NUMBER, SELECT, DATE, CHECKBOX)
- Field values API + validation

### Phase 3: Views
- Board view (Kanban) + Table view (spreadsheet)
- View switcher

### Phase 2: Filter Engine
- Query syntax with qualifiers (status, priority, label, due, done, has)
- Client + server-side filter parity

### Phase 1: Core
- DnD board with cross-column card moves
- Column management (add, rename, delete, reorder)
- Sequential IDs per board (#1, #2, #3)
- Markdown ↔ SQLite bidirectional sync
- Priority writeback (🔺/⏫)
- Real-time WebSocket updates
