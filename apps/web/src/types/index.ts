export interface Card {
  id: string;
  board_id: string;
  column_name: string;
  position: number;
  title: string;
  raw_line: string;
  line_number: number;
  is_done: boolean;
  priority: 'high' | 'urgent' | null;
  labels: string[];
  due_date: string | null;
  sub_items: string[];
  description: string;
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
  totalCards: number;
  columnCounts: Record<string, number>;
}

export interface BoardDetail {
  id: string;
  name: string;
  file: string;
  columns: Column[];
}

export interface MoveCardRequest {
  column: string;
  position: number;
}

export interface PatchCardRequest {
  column_name?: string;
  position?: number;
  labels?: string[];
  priority?: 'high' | 'urgent' | null;
  due_date?: string | null;
  description?: string;
}
