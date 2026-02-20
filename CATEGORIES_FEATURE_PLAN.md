# Categories Feature Plan (MVP)

## Audience
- Architect: validates scope, contracts, risks, acceptance.
- Programmer: implementation checklist by files/phases.

## Goal
Upgrade existing `labels: string[]` into a full Categories feature:
- board-level category definitions (`id`, `label`, `color`, `showOnCard`)
- multi-select assignment per card (stored in existing `labels`)
- colored category badges on cards with visibility toggle
- category management UI in board settings

## Scope Decision (Agreed)
- Keep one per-card field: `labels` (no `category_ids` alias in MVP).
- Keep existing filter syntax (`label:`); no `category:` alias in MVP.
- Add:
  - color normalization/validation reuse
  - bulk cleanup when category removed from board definitions
  - card badge cap: max 3 visible + `+N`
- Phase 2 (out of MVP):
  - markdown round-trip markers (`kb:cat=...`)
  - DB normalization (`card_categories` junction table)

## Data Model
`CategoryDef` (board-level):

```ts
interface CategoryDef {
  id: string;          // stable slug, unique per board
  label: string;       // display name
  color: string;       // #RRGGBB
  showOnCard: boolean; // render on kanban card front
}
```

- Stored as `board.categories?: CategoryDef[]` in `config.boards.json`.
- Card assignments remain `cards.labels` (JSON array of category IDs).

## Backend Changes (apps/api)

### 1) `src/config.ts`
- Add/export `CategoryDefSchema`.
- Extend `BoardSchema` with optional `categories`.
- Export `CategoryDef` type.
- Extend `updateBoardInConfig()` patch typing to support `categories`.

### 2) `src/routes/boards.ts`
- Extend PATCH board schema with `categories`.
- Validation rules:
  - unique `id`
  - `label` non-empty
  - `color` valid hex (`#RRGGBB`; normalize if needed before persist)
- Return `categories: board.categories ?? []` in:
  - `GET /api/boards`
  - `GET /api/boards/:id`

### 3) `src/routes/cards.ts`
- Keep `labels` as assignment field.
- Add runtime validation for `labels` on PATCH:
  - every value must exist in `board.categories[].id`
  - reject unknown IDs with `400`

### 4) Bulk Cleanup on Category Delete
- Trigger cleanup when board categories are updated (PATCH board):
  - detect removed IDs = `oldIds - newIds`
  - for all cards in board, remove removed IDs from `labels`
- IMPORTANT: do exact-match cleanup on parsed JSON arrays.
  - Do **not** use `LIKE '%id%'` substring matching.
  - Safe approach:
    - read affected cards (`id`, `labels`) by `board_id`
    - parse JSON
    - filter exact IDs
    - update only changed rows
  - wrap in transaction.

## Frontend Changes (apps/web)

### 1) `src/types/index.ts`
- Add `CategoryDef`.
- Add `categories: CategoryDef[]` to `BoardSummary` and `BoardDetail`.

### 2) `src/api/client.ts`
- Add `updateBoardCategories(boardId, categories)` (PATCH board).

### 3) `src/components/BoardSettings.tsx`
- Add Categories section after Priorities:
  - add/edit/delete/reorder
  - fields: color, label, showOnCard
  - auto slug/id generation from label
  - unique ID + non-empty label validation
  - color normalize to `#RRGGBB`
- Add callback `onSaveCategories`.

### 4) `src/components/Card.tsx`
- Resolve category defs by `card.labels`.
- Render only categories where `showOnCard === true`.
- Display cap:
  - show first 3 badges
  - if more: show `+N` badge
- Style:
  - bg = `${color}26`
  - text color = `color`

### 5) `src/components/CardDetail.tsx`
- Replace read-only labels with interactive category chips.
- All board categories shown.
- Active/inactive visual states.
- Toggle chip -> `patchCard(card.id, { labels: updatedIds })` immediate save.

### 6) Prop Threading
- `App.tsx` -> `Board.tsx` -> `Column.tsx` -> `DraggableCard.tsx` -> `Card.tsx`
- `App.tsx` -> `CardDetail.tsx`

### 7) `src/App.tsx`
- Add `onCategoriesChange` handler:
  - call `updateBoardCategories`
  - reload board + boards list

## UX Rules
- Category chip text always visible (not color-only).
- Keep chips short (truncate long labels in card view if needed).
- Card detail shows full list and full labels.
- Keep behavior consistent with existing priority patterns.

## Testing Plan

### Frontend
- `src/__tests__/BoardSettings.test.tsx`
  - renders categories section
  - add category
  - edit label/color
  - toggle `showOnCard`
  - delete category
  - reorder categories
  - validation errors (empty label, duplicate ID)
  - save callback payload correctness

- Card rendering tests (new or existing test file):
  - `showOnCard=false` not rendered
  - 3 + `+N` cap works
  - color styles applied

### Backend (recommended for this feature)
- board PATCH categories validation
- card PATCH rejects unknown label IDs
- category removal cleanup removes IDs from card `labels` exactly (no partial matches)

## Acceptance Criteria
1. Board Settings allows full categories CRUD and reorder.
2. Category definitions persist and re-load from board API.
3. CardDetail can assign/unassign categories and persists.
4. Kanban card shows only `showOnCard=true` categories.
5. If more than 3 visible categories, card shows `+N`.
6. Removing a category from board definitions removes it from all board cards.
7. Existing features (priorities, drag/drop, filters, comments) remain unaffected.

## Execution Phases

### Phase 1: Data + API
- `config.ts`, `boards.ts`, `cards.ts` support categories and validation.
- Implement exact-match bulk cleanup transaction.

### Phase 2: UI + wiring
- Types/client updates.
- BoardSettings categories section.
- Card/CardDetail rendering + interaction.
- Prop threading and handlers.

### Phase 3: QA
- Add/adjust tests.
- Run:
  - `npm test --workspace apps/api`
  - `npm test --workspace apps/web`
  - `npm exec --workspace apps/api tsc --noEmit`
  - `npm exec --workspace apps/web tsc --noEmit`
  - `npm exec --workspace apps/web vite build`

## Non-Goals (MVP)
- `category:` filter alias
- API dual naming (`labels` + `category_ids`)
- markdown writeback/recovery for categories
- DB schema redesign to normalized relation
