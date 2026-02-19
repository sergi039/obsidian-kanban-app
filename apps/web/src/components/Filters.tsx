import { useState, useRef, useEffect } from 'react';

interface Props {
  filterQuery: string;
  onFilterChange: (query: string) => void;
}

const SUGGESTIONS = [
  { label: 'status:', desc: 'Filter by column (e.g. status:Done)' },
  { label: 'priority:', desc: 'high, urgent, or none' },
  { label: 'label:', desc: 'Filter by label' },
  { label: 'due:', desc: 'overdue, today, this-week, none' },
  { label: 'done:', desc: 'yes or no' },
  { label: 'has:', desc: 'description, comments, priority, labels' },
  { label: '-status:', desc: 'Exclude column' },
  { label: '-label:', desc: 'Exclude label' },
];

export function Filters({ filterQuery, onFilterChange }: Props) {
  const [showHelp, setShowHelp] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const helpRef = useRef<HTMLDivElement>(null);

  // Close help on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (helpRef.current && !helpRef.current.contains(e.target as Node) &&
          inputRef.current && !inputRef.current.contains(e.target as Node)) {
        setShowHelp(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setShowHelp(false);
      inputRef.current?.blur();
    }
  };

  const insertSuggestion = (label: string) => {
    const current = filterQuery;
    const newQuery = current ? `${current} ${label}` : label;
    onFilterChange(newQuery);
    inputRef.current?.focus();
    setShowHelp(false);
  };

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
            onFocus={() => setShowHelp(true)}
            onKeyDown={handleKeyDown}
            className="px-3 h-8 text-sm bg-board-column border border-board-border rounded-md text-board-text placeholder:text-board-text-muted/40 focus:outline-none focus:ring-2 focus:ring-board-accent/50 focus:border-board-accent/50 w-80"
          />
          {filterQuery && (
            <button
              onClick={() => onFilterChange('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-board-text-muted hover:text-board-text text-xs"
              title="Clear filter"
            >
              ✕
            </button>
          )}
        </div>
        <button
          onClick={() => setShowHelp(!showHelp)}
          className="text-board-text-muted hover:text-board-text text-sm px-1.5 h-8 rounded hover:bg-board-column transition-colors"
          title="Filter help"
        >
          ?
        </button>
      </div>

      {/* Help dropdown */}
      {showHelp && (
        <div
          ref={helpRef}
          className="absolute top-full mt-1 right-0 bg-board-bg border border-board-border rounded-lg shadow-xl z-50 w-80 py-1"
        >
          <div className="px-3 py-1.5 text-[10px] text-board-text-muted uppercase tracking-wider border-b border-board-border">
            Filter syntax
          </div>
          {SUGGESTIONS.map((s) => (
            <button
              key={s.label}
              onClick={() => insertSuggestion(s.label)}
              className="w-full text-left px-3 py-1.5 hover:bg-board-column transition-colors flex items-center gap-2"
            >
              <code className="text-xs font-mono px-1 py-0.5 bg-board-column rounded" style={{ color: 'var(--board-accent)' }}>
                {s.label}
              </code>
              <span className="text-xs text-board-text-muted">{s.desc}</span>
            </button>
          ))}
          <div className="px-3 py-1.5 border-t border-board-border text-[10px] text-board-text-muted">
            Prefix with <code className="px-0.5">-</code> to negate. Free text searches titles.
          </div>
        </div>
      )}
    </div>
  );
}
