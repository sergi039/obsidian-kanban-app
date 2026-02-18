/**
 * Filter Engine: parse query strings like "status:Done priority:high -label:bug some text"
 * into SQL WHERE clauses for SQLite.
 *
 * Grammar:
 *   query       = (expression | freeText)*
 *   expression  = negation? qualifier ":" value
 *   negation    = "-"
 *   qualifier   = "status" | "priority" | "label" | "due" | "done" | "has"
 *   value       = word | word,word,...  (comma-separated multi-value)
 *   freeText    = any word not matching qualifier:value pattern
 *
 * Examples:
 *   status:Done                    → column_name = 'Done'
 *   priority:high,urgent           → priority IN ('high', 'urgent')
 *   -label:bug                     → labels NOT LIKE '%"bug"%'
 *   due:overdue                    → due_date < date('now')
 *   due:this-week                  → due_date BETWEEN ...
 *   done:yes                       → is_done = 1
 *   has:description                → description != ''
 *   has:comments                   → EXISTS (SELECT 1 FROM comments ...)
 *   some text                      → title LIKE '%some%' AND title LIKE '%text%'
 *   -status:Backlog priority:high  → column_name != 'Backlog' AND priority = 'high'
 */

export interface FilterToken {
  negated: boolean;
  qualifier: string;
  values: string[];
}

export interface ParsedFilter {
  tokens: FilterToken[];
  freeText: string[];
}

export interface SqlFilter {
  where: string;
  params: unknown[];
}

const QUALIFIER_RE = /^(-?)([a-zA-Z_]+):(.+)$/;

const KNOWN_QUALIFIERS = new Set([
  'status', 'priority', 'label', 'due', 'done', 'has', 'board',
]);

/**
 * Parse a filter query string into structured tokens + free text.
 */
export function parseFilterQuery(query: string): ParsedFilter {
  const tokens: FilterToken[] = [];
  const freeText: string[] = [];

  if (!query || !query.trim()) {
    return { tokens, freeText };
  }

  // Split by whitespace, but respect quoted strings
  const parts = splitQuery(query.trim());

  for (const part of parts) {
    const match = part.match(QUALIFIER_RE);
    if (match) {
      const negated = match[1] === '-';
      const qualifier = match[2].toLowerCase();
      const rawValue = match[3];

      if (KNOWN_QUALIFIERS.has(qualifier)) {
        const values = rawValue.split(',').map((v) => v.trim()).filter(Boolean);
        tokens.push({ negated, qualifier, values });
        continue;
      }
    }
    // Not a qualifier:value — treat as free text
    freeText.push(part);
  }

  return { tokens, freeText };
}

/**
 * Split query string by whitespace, preserving quoted strings.
 */
function splitQuery(query: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inQuote = false;
  let quoteChar = '';

  for (const ch of query) {
    if (inQuote) {
      if (ch === quoteChar) {
        inQuote = false;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = true;
      quoteChar = ch;
    } else if (ch === ' ' || ch === '\t') {
      if (current) {
        parts.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);
  return parts;
}

/**
 * Compile parsed filter into SQL WHERE clause + params for SQLite.
 * Assumes base query already has `WHERE board_id = ?`.
 */
export function compileFilter(parsed: ParsedFilter): SqlFilter {
  const conditions: string[] = [];
  const params: unknown[] = [];

  for (const token of parsed.tokens) {
    const clause = compileToken(token, params);
    if (clause) conditions.push(clause);
  }

  // Free text → title LIKE '%word%' for each word
  for (const word of parsed.freeText) {
    conditions.push('title LIKE ?');
    params.push(`%${word}%`);
  }

  return {
    where: conditions.length > 0 ? conditions.join(' AND ') : '1=1',
    params,
  };
}

function compileToken(token: FilterToken, params: unknown[]): string | null {
  const { negated, qualifier, values } = token;
  const op = negated ? 'NOT' : '';
  const eq = negated ? '!=' : '=';
  const like = negated ? 'NOT LIKE' : 'LIKE';

  switch (qualifier) {
    case 'status': {
      if (values.length === 1) {
        params.push(values[0]);
        return `column_name ${eq} ?`;
      }
      const ph = values.map(() => '?').join(',');
      params.push(...values);
      return `column_name ${negated ? 'NOT ' : ''}IN (${ph})`;
    }

    case 'priority': {
      if (values.length === 1) {
        if (values[0] === 'none') {
          return negated ? 'priority IS NOT NULL' : 'priority IS NULL';
        }
        params.push(values[0]);
        return `priority ${eq} ?`;
      }
      const ph = values.map(() => '?').join(',');
      params.push(...values);
      return `priority ${negated ? 'NOT ' : ''}IN (${ph})`;
    }

    case 'label': {
      // labels is JSON array stored as string: '["bug","feature"]'
      // Use LIKE for each value
      const clauses = values.map((v) => {
        params.push(`%"${v}"%`);
        return `labels ${like} ?`;
      });
      if (negated) {
        return `(${clauses.join(' AND ')})`;
      }
      return `(${clauses.join(' OR ')})`;
    }

    case 'due': {
      return compileDueFilter(values[0], negated, params);
    }

    case 'done': {
      const isDone = ['yes', 'true', '1'].includes(values[0]?.toLowerCase());
      const val = isDone ? 1 : 0;
      if (negated) {
        params.push(val);
        return `is_done != ?`;
      }
      params.push(val);
      return `is_done = ?`;
    }

    case 'has': {
      return compileHasFilter(values[0], negated);
    }

    case 'board': {
      if (values.length === 1) {
        params.push(values[0]);
        return `board_id ${eq} ?`;
      }
      return null;
    }

    default:
      return null;
  }
}

function compileDueFilter(value: string | undefined, negated: boolean, params: unknown[]): string | null {
  if (!value) return null;

  const prefix = negated ? 'NOT ' : '';
  const v = value.toLowerCase();

  switch (v) {
    case 'overdue':
      return `${prefix}(due_date IS NOT NULL AND due_date < date('now'))`;
    case 'today':
      return `${prefix}(due_date = date('now'))`;
    case 'tomorrow':
      return `${prefix}(due_date = date('now', '+1 day'))`;
    case 'this-week':
      return `${prefix}(due_date BETWEEN date('now') AND date('now', '+7 days'))`;
    case 'this-month':
      return `${prefix}(due_date BETWEEN date('now') AND date('now', '+30 days'))`;
    case 'none':
      return negated ? 'due_date IS NOT NULL' : 'due_date IS NULL';
    case 'any':
      return negated ? 'due_date IS NULL' : 'due_date IS NOT NULL';
    default:
      // Try as literal date: due:2026-03-01
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
        params.push(v);
        return `due_date ${negated ? '!=' : '='} ?`;
      }
      return null;
  }
}

function compileHasFilter(value: string | undefined, negated: boolean): string | null {
  if (!value) return null;

  const v = value.toLowerCase();
  const not = negated ? 'NOT ' : '';

  switch (v) {
    case 'description':
      return negated
        ? "(description IS NULL OR description = '')"
        : "(description IS NOT NULL AND description != '')";
    case 'comments':
      return `${not}EXISTS (SELECT 1 FROM comments WHERE comments.card_id = cards.id)`;
    case 'label':
    case 'labels':
      return negated
        ? "(labels IS NULL OR labels = '[]')"
        : "(labels IS NOT NULL AND labels != '[]')";
    case 'due':
    case 'due_date':
      return negated ? 'due_date IS NULL' : 'due_date IS NOT NULL';
    case 'priority':
      return negated ? 'priority IS NULL' : 'priority IS NOT NULL';
    default:
      return null;
  }
}
