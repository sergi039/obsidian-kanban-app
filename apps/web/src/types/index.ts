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
  source_fingerprint: string | null;
  created_at: string;
  updated_at: string;
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
  columns: Column[];
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
  column_name?: string;
  position?: number;
  labels?: string[];
  priority?: string | null;
  due_date?: string | null;
  description?: string;
  checklist?: ChecklistItem[];
  links?: LinkItem[];
}
