import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import type { PriorityDef, CategoryDef } from '../types';

interface Props {
  filterQuery: string;
  onFilterChange: (query: string) => void;
  columns: string[];
  priorities: PriorityDef[];
  categories: CategoryDef[];
}

interface SuggestionItem {
  value: string;
  display: string;
  desc?: string;
  color?: string;
  emoji?: string;
}

interface TokenContext {
  qualifier: string | null;
  negated: boolean;
  partial: string;
  tokenStart: number;
  tokenEnd: number;
  afterColon: boolean;
}

const QUALIFIER_DEFS: { value: string; desc: string }[] = [
  { value: 'status:', desc: 'Filter by column' },
  { value: 'priority:', desc: 'Filter by priority' },
  { value: 'label:', desc: 'Filter by label' },
  { value: 'due:', desc: 'Due date filter' },
  { value: 'done:', desc: 'Completion status' },
  { value: 'has:', desc: 'Has property' },
];

const DUE_VALUES: SuggestionItem[] = [
  { value: 'overdue', display: 'overdue', desc: 'Past due date' },
  { value: 'today', display: 'today', desc: 'Due today' },
  { value: 'tomorrow', display: 'tomorrow', desc: 'Due tomorrow' },
  { value: 'this-week', display: 'this-week', desc: 'Due within 7 days' },
  { value: 'this-month', display: 'this-month', desc: 'Due within 30 days' },
  { value: 'none', display: 'none', desc: 'No due date' },
  { value: 'any', display: 'any', desc: 'Has a due date' },
];

const DONE_VALUES: SuggestionItem[] = [
  { value: 'yes', display: 'yes', desc: 'Completed tasks' },
  { value: 'no', display: 'no', desc: 'Incomplete tasks' },
];

const HAS_VALUES: SuggestionItem[] = [
  { value: 'description', display: 'description', desc: 'Has description' },
  { value: 'comments', display: 'comments', desc: 'Has comments' },
  { value: 'labels', display: 'labels', desc: 'Has labels' },
  { value: 'due', display: 'due', desc: 'Has due date' },
  { value: 'priority', display: 'priority', desc: 'Has priority' },
];

function getTokenAtCursor(query: string, cursorPos: number): TokenContext | null {
  // Walk backwards from cursor to find token start (stop at whitespace outside quotes)
  let tokenStart = cursorPos;
  let inQuote = false;
  let qChar = '';
  for (let i = cursorPos - 1; i >= 0; i--) {
    const ch = query[i];
    if (inQuote) {
      if (ch === qChar) inQuote = false;
      tokenStart = i;
    } else if (ch === '"' || ch === "'") {
      inQuote = true;
      qChar = ch;
      tokenStart = i;
    } else if (ch === ' ' || ch === '\t') {
      break;
    } else {
      tokenStart = i;
    }
  }

  // Walk forward to find token end
  let tokenEnd = cursorPos;
  inQuote = false;
  qChar = '';
  for (let i = cursorPos; i < query.length; i++) {
    const ch = query[i];
    if (inQuote) {
      tokenEnd = i + 1;
      if (ch === qChar) break;
    } else if (ch === '"' || ch === "'") {
      inQuote = true;
      qChar = ch;
      tokenEnd = i + 1;
    } else if (ch === ' ' || ch === '\t') {
      break;
    } else {
      tokenEnd = i + 1;
    }
  }

  const token = query.slice(tokenStart, tokenEnd);
  if (!token && cursorPos > 0 && query[cursorPos - 1] !== ' ') return null;

  // Parse: optional negation + qualifier:value
  const m = token.match(/^(-?)([a-zA-Z_]+):(.*)$/);
  if (m) {
    const afterColonRaw = m[3];
    // Handle comma-separated: use text after last comma as partial
    const lastComma = afterColonRaw.lastIndexOf(',');
    const partial = lastComma >= 0 ? afterColonRaw.slice(lastComma + 1) : afterColonRaw;
    return {
      qualifier: m[2].toLowerCase(),
      negated: m[1] === '-',
      partial,
      tokenStart,
      tokenEnd,
      afterColon: true,
    };
  }

  // No colon — partial qualifier or free text
  const nm = token.match(/^(-?)(.*)$/);
  return {
    qualifier: null,
    negated: nm ? nm[1] === '-' : false,
    partial: nm ? nm[2] : token,
    tokenStart,
    tokenEnd,
    afterColon: false,
  };
}

function getSuggestions(
  ctx: TokenContext,
  columns: string[],
  priorities: PriorityDef[],
  categories: CategoryDef[],
): SuggestionItem[] {
  const filter = (items: SuggestionItem[], partial: string): SuggestionItem[] => {
    if (!partial) return items;
    const lp = partial.toLowerCase();
    return items.filter((i) => i.value.toLowerCase().startsWith(lp) || i.display.toLowerCase().startsWith(lp));
  };

  if (!ctx.afterColon || !ctx.qualifier) {
    // Show qualifier names
    const prefix = ctx.negated ? '-' : '';
    const qualifiers: SuggestionItem[] = QUALIFIER_DEFS.map((q) => ({
      value: prefix + q.value,
      display: prefix + q.value,
      desc: q.desc,
    }));
    if (!ctx.partial) return qualifiers;
    const lp = ctx.partial.toLowerCase();
    return qualifiers.filter((q) => q.display.toLowerCase().startsWith(lp) || q.display.slice(prefix.length).toLowerCase().startsWith(lp));
  }

  const KNOWN = new Set(['status', 'priority', 'label', 'due', 'done', 'has']);
  if (!KNOWN.has(ctx.qualifier)) return [];

  switch (ctx.qualifier) {
    case 'status':
      return filter(
        columns.map((c) => ({ value: c, display: c, desc: 'Column' })),
        ctx.partial,
      );
    case 'priority':
      return filter(
        [
          ...priorities.map((p) => ({
            value: p.id,
            display: p.label,
            desc: p.id,
            color: p.color,
            emoji: p.emoji,
          })),
          { value: 'none', display: 'none', desc: 'No priority set' },
        ],
        ctx.partial,
      );
    case 'label':
      return filter(
        categories.map((c) => ({
          value: c.label,
          display: c.label,
          color: c.color,
        })),
        ctx.partial,
      );
    case 'due':
      return filter(DUE_VALUES, ctx.partial);
    case 'done':
      return filter(DONE_VALUES, ctx.partial);
    case 'has':
      return filter(HAS_VALUES, ctx.partial);
    default:
      return [];
  }
}

function needsQuotes(value: string): boolean {
  return /\s/.test(value);
}

export function Filters({ filterQuery, onFilterChange, columns, priorities, categories }: Props) {
  const [showAutocomplete, setShowAutocomplete] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const suggestionsRef = useRef<SuggestionItem[]>([]);
  const tokenContextRef = useRef<TokenContext | null>(null);

  const updateSuggestions = useCallback(() => {
    const input = inputRef.current;
    if (!input) return;

    // Only show autocomplete when the input is focused
    if (document.activeElement !== input) {
      suggestionsRef.current = [];
      setShowAutocomplete(false);
      return;
    }

    const cursor = input.selectionStart ?? filterQuery.length;
    const ctx = getTokenAtCursor(filterQuery, cursor);
    tokenContextRef.current = ctx;

    if (!ctx) {
      suggestionsRef.current = [];
      setShowAutocomplete(false);
      return;
    }

    const items = getSuggestions(ctx, columns, priorities, categories);
    suggestionsRef.current = items;
    setShowAutocomplete(items.length > 0);
    setSelectedIndex(0);
  }, [filterQuery, columns, priorities, categories]);

  // Recalculate suggestions when query or data changes
  useEffect(() => {
    // Small delay to let cursor position settle after onChange
    const id = requestAnimationFrame(updateSuggestions);
    return () => cancelAnimationFrame(id);
  }, [updateSuggestions]);

  // Close on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (
        dropdownRef.current && !dropdownRef.current.contains(e.target as Node) &&
        inputRef.current && !inputRef.current.contains(e.target as Node)
      ) {
        setShowAutocomplete(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  // Scroll selected item into view
  useEffect(() => {
    if (!showAutocomplete || !dropdownRef.current) return;
    const item = dropdownRef.current.querySelector(`[data-idx="${selectedIndex}"]`);
    item?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex, showAutocomplete]);

  const insertSuggestion = useCallback((item: SuggestionItem) => {
    const ctx = tokenContextRef.current;
    if (!ctx) return;

    const isQualifier = item.value.endsWith(':');
    let newQuery: string;
    let newCursorPos: number;

    if (isQualifier) {
      // Replace entire token with the qualifier
      newQuery = filterQuery.slice(0, ctx.tokenStart) + item.value + filterQuery.slice(ctx.tokenEnd);
      newCursorPos = ctx.tokenStart + item.value.length;
    } else {
      // Inserting a value after colon
      // Find the colon position in the token
      const tokenText = filterQuery.slice(ctx.tokenStart, ctx.tokenEnd);
      const colonIdx = tokenText.indexOf(':');
      if (colonIdx < 0) {
        // No colon — just replace token
        const val = needsQuotes(item.value) ? `"${item.value}"` : item.value;
        newQuery = filterQuery.slice(0, ctx.tokenStart) + val + filterQuery.slice(ctx.tokenEnd);
        newCursorPos = ctx.tokenStart + val.length;
      } else {
        // Replace the partial after the last comma (or after colon if no comma)
        const beforeColon = tokenText.slice(0, colonIdx + 1);
        const afterColon = tokenText.slice(colonIdx + 1);
        const lastComma = afterColon.lastIndexOf(',');
        const beforePartial = lastComma >= 0 ? afterColon.slice(0, lastComma + 1) : '';
        const val = needsQuotes(item.value) ? `"${item.value}"` : item.value;
        const replacement = beforeColon + beforePartial + val;
        newQuery = filterQuery.slice(0, ctx.tokenStart) + replacement + filterQuery.slice(ctx.tokenEnd);
        newCursorPos = ctx.tokenStart + replacement.length;
      }
    }

    onFilterChange(newQuery);

    // Position cursor
    requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(newCursorPos, newCursorPos);
    });
  }, [filterQuery, onFilterChange]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    const items = suggestionsRef.current;

    if (showAutocomplete && items.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((i) => (i + 1) % items.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((i) => (i - 1 + items.length) % items.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        insertSuggestion(items[selectedIndex]);
        return;
      }
    }

    if (e.key === 'Escape') {
      setShowAutocomplete(false);
      inputRef.current?.blur();
    }
  };

  const handleShowAll = () => {
    // Show all qualifier suggestions
    tokenContextRef.current = {
      qualifier: null,
      negated: false,
      partial: '',
      tokenStart: filterQuery.length,
      tokenEnd: filterQuery.length,
      afterColon: false,
    };
    const items = getSuggestions(tokenContextRef.current, columns, priorities, categories);
    suggestionsRef.current = items;
    setSelectedIndex(0);
    setShowAutocomplete(true);
    inputRef.current?.focus();
  };

  // Compute header text
  const headerText = useMemo(() => {
    const ctx = tokenContextRef.current;
    if (!ctx || !ctx.afterColon || !ctx.qualifier) return 'Filter qualifiers';
    const labels: Record<string, string> = {
      status: 'status values',
      priority: 'priority values',
      label: 'label values',
      due: 'due date values',
      done: 'done values',
      has: 'has values',
    };
    return labels[ctx.qualifier] ?? 'Filter qualifiers';
  }, [showAutocomplete, selectedIndex]); // recalc when dropdown updates

  return (
    <div className="relative">
      <div className="flex items-center gap-1.5">
        <label htmlFor="filter-query" className="sr-only">Filter tasks</label>
        <div className="relative">
          <input
            ref={inputRef}
            id="filter-query"
            type="text"
            placeholder="Filter: status:Done priority:high text…"
            value={filterQuery}
            onChange={(e) => onFilterChange(e.target.value)}
            onFocus={updateSuggestions}
            onClick={updateSuggestions}
            onKeyDown={handleKeyDown}
            className="px-3 h-8 text-sm bg-board-column border border-board-border rounded-md text-board-text placeholder:text-board-text-muted/40 focus:outline-none focus:ring-2 focus:ring-board-accent/50 focus:border-board-accent/50 w-80"
          />
          {filterQuery && (
            <button
              onClick={() => { onFilterChange(''); setShowAutocomplete(false); }}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-board-text-muted hover:text-board-text text-xs"
              title="Clear filter"
            >
              ✕
            </button>
          )}
        </div>
        <button
          onClick={handleShowAll}
          className="text-board-text-muted hover:text-board-text text-sm px-1.5 h-8 rounded hover:bg-board-column transition-colors"
          title="Show filter options"
        >
          ?
        </button>
      </div>

      {/* Autocomplete dropdown */}
      {showAutocomplete && suggestionsRef.current.length > 0 && (
        <div
          ref={dropdownRef}
          className="absolute top-full mt-1 right-0 bg-board-bg border border-board-border rounded-lg shadow-xl z-50 w-80 py-1 max-h-72 overflow-y-auto"
        >
          <div className="px-3 py-1.5 text-[10px] text-board-text-muted uppercase tracking-wider border-b border-board-border">
            {headerText}
          </div>
          {suggestionsRef.current.map((item, idx) => (
            <button
              key={item.value + idx}
              data-idx={idx}
              onClick={() => insertSuggestion(item)}
              onMouseEnter={() => setSelectedIndex(idx)}
              className={`w-full text-left px-3 py-1.5 transition-colors flex items-center gap-2 ${
                idx === selectedIndex ? 'bg-board-column' : 'hover:bg-board-column/50'
              }`}
            >
              {item.color && (
                <span
                  className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                  style={{ backgroundColor: item.color }}
                />
              )}
              {item.emoji && <span className="text-xs flex-shrink-0">{item.emoji}</span>}
              <code className="text-xs font-mono px-1 py-0.5 bg-board-column rounded" style={{ color: 'var(--board-accent)' }}>
                {item.display}
              </code>
              {item.desc && <span className="text-xs text-board-text-muted truncate">{item.desc}</span>}
            </button>
          ))}
          <div className="px-3 py-1.5 border-t border-board-border text-[10px] text-board-text-muted flex gap-3">
            <span><kbd className="px-1 bg-board-column rounded">Tab</kbd>/<kbd className="px-1 bg-board-column rounded">Enter</kbd> select</span>
            <span><kbd className="px-1 bg-board-column rounded">Esc</kbd> dismiss</span>
          </div>
        </div>
      )}
    </div>
  );
}
