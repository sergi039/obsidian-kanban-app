export interface PriorityDef {
  id: string;
  emoji: string;
  label: string;
  color: string;
  showOnCard?: boolean;
}

export interface CategoryDef {
  id: string;
  label: string;
  color: string;
  showOnCard: boolean;
}

export interface ChecklistItem {
  id: string;
  title: string;
  done: boolean;
}

export interface LinkItem {
  url: string;
  title: string;
}

export type CalendarProvider = 'google' | 'outlook';

/** A calendar the owner works in (configured per install in config.boards.json). */
export interface CalendarAccount {
  id: string;
  label: string;
  provider: CalendarProvider;
  email: string;
}

/** A calendar event linked to a card by the server's calendar sync; the calendar owns the event. */
export interface CalendarEvent {
  id: string;
  url: string;
  title: string;
  /** 'YYYY-MM-DD' for all-day, timezone-aware ISO datetime, or null when unknown. */
  start: string | null;
  /** Exclusive end in the same format as `start`; null when unknown. */
  end?: string | null;
  /** Calendar account id from the board's calendar accounts. */
  account: string | null;
}

export interface Card {
  id: string;
  seq_id: number | null;
  board_id: string;
  column_name: string;
  position: number;
  title: string;
  raw_line: string;
  line_number: number;
  is_done: boolean;
  priority: string | null;
  labels: string[];
  due_date: string | null;
  sub_items: string[];
  description: string;
  checklist: ChecklistItem[];
  links: LinkItem[];
  calendar_events: CalendarEvent[];
  source_fingerprint: string | null;
  source: string | null;
  source_uid: string | null;
  source_url: string | null;
  source_meta: Record<string, unknown>;
  /** ISO UTC timestamp when the card was moved to the trash; null for live cards. */
  deleted_at?: string | null;
  /** Number of comments; sent with the board detail (used by the has:comments filter). */
  comment_count?: number;
  created_at: string;
  updated_at: string;
}

export type ReminderKind = 'due' | 'follow_up' | 'custom';
export type ReminderChannel = 'in_app' | 'browser' | 'macos' | 'calendar' | 'email';
export type ReminderStatus = 'scheduled' | 'snoozed' | 'fired' | 'dismissed';

export interface Reminder {
  id: string;
  card_id: string;
  board_id: string;
  kind: ReminderKind;
  channel: ReminderChannel;
  status: ReminderStatus;
  trigger_at: string;
  timezone: string;
  message: string;
  snoozed_until: string | null;
  last_fired_at: string | null;
  dismissed_at: string | null;
  source: string | null;
  source_uid: string | null;
  source_url: string | null;
  source_meta: Record<string, unknown>;
  card_title?: string;
  card_column_name?: string;
  card_is_done?: boolean;
  effective_at?: string;
  created_at: string;
  updated_at: string;
}

export interface CreateReminderRequest {
  card_id: string;
  kind?: ReminderKind;
  channel?: ReminderChannel;
  trigger_at: string;
  timezone?: string;
  message?: string;
  source?: string | null;
  source_uid?: string | null;
  source_url?: string | null;
  source_meta?: Record<string, unknown>;
}

export interface UpdateReminderRequest {
  kind?: ReminderKind;
  channel?: ReminderChannel;
  status?: ReminderStatus;
  trigger_at?: string;
  timezone?: string;
  message?: string;
  snoozed_until?: string | null;
  last_fired_at?: string | null;
  dismissed_at?: string | null;
  source?: string | null;
  source_uid?: string | null;
  source_url?: string | null;
  source_meta?: Record<string, unknown>;
}

export interface SnoozeReminderRequest {
  until?: string;
  minutes?: number;
}

export interface Comment {
  id: string;
  card_id: string;
  author: string;
  text: string;
  created_at: string;
  updated_at: string;
}

export interface Column {
  name: string;
  cards: Card[];
}

export interface BoardSummary {
  id: string;
  name: string;
  file: string;
  columns: string[];
  priorities: PriorityDef[];
  categories: CategoryDef[];
  archived?: boolean;
  totalCards: number;
  columnCounts: Record<string, number>;
}

export interface BoardDetail {
  id: string;
  name: string;
  file: string;
  priorities: PriorityDef[];
  categories: CategoryDef[];
  /** Board's default calendar account, null when none is configured. */
  calendarAccount: CalendarAccount | null;
  calendarAccounts: CalendarAccount[];
  /** Public base URL of this Kanban, used for card links inside calendar events. */
  publicUrl?: string | null;
  columns: Column[];
  trashCount: number;
}

export interface View {
  id: string;
  board_id: string;
  name: string;
  layout: 'board' | 'table';
  filter_query: string;
  sort_field: string;
  sort_dir: 'ASC' | 'DESC';
  group_by: string;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

export interface Field {
  id: string;
  board_id: string;
  name: string;
  type: 'TEXT' | 'NUMBER' | 'DATE' | 'SINGLE_SELECT' | 'ITERATION';
  options: Array<{ id: string; name: string; color?: string }>;
  position: number;
  created_at: string;
}

export interface FieldValue {
  field_id: string;
  field_name: string;
  field_type: string;
  options: Array<{ id: string; name: string; color?: string }>;
  value: string | null;
}

// Automation types
export type TriggerType = 'card.moved' | 'card.created';

export interface TriggerCardMoved {
  type: 'card.moved';
  from_column?: string;
  to_column?: string;
  board_id?: string;
}

export interface TriggerCardCreated {
  type: 'card.created';
  column?: string;
  board_id?: string;
}

export type Trigger = TriggerCardMoved | TriggerCardCreated;

export interface ActionSetField {
  type: 'set_field';
  field_id: string;
  value: string | null;
}

export interface ActionAddComment {
  type: 'add_comment';
  text: string;
  author?: string;
}

export interface ActionSetDueDate {
  type: 'set_due_date';
  days_from_now: number;
}

export type AutomationAction = ActionSetField | ActionAddComment | ActionSetDueDate;

export interface AutomationRule {
  id: string;
  board_id: string;
  name: string;
  enabled: boolean;
  trigger: Trigger;
  actions: AutomationAction[];
  created_at: string;
  updated_at: string;
}

export interface MoveCardRequest {
  column: string;
  position: number;
}

export interface PatchCardRequest {
  title?: string;
  column_name?: string;
  position?: number;
  labels?: string[];
  priority?: string | null;
  due_date?: string | null;
  description?: string;
  checklist?: ChecklistItem[];
  links?: LinkItem[];
}
