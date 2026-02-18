interface Props {
  layout: 'board' | 'table';
  onLayoutChange: (layout: 'board' | 'table') => void;
}

export function ViewSwitcher({ layout, onLayoutChange }: Props) {
  return (
    <div className="flex items-center bg-board-column rounded-md border border-board-border overflow-hidden">
      <button
        onClick={() => onLayoutChange('board')}
        aria-pressed={layout === 'board'}
        className={`px-2.5 py-1 text-xs font-medium transition-colors ${
          layout === 'board'
            ? 'bg-board-card text-board-text shadow-sm'
            : 'text-board-text-muted hover:text-board-text'
        }`}
        title="Board view"
      >
        ▦ Board
      </button>
      <button
        onClick={() => onLayoutChange('table')}
        aria-pressed={layout === 'table'}
        className={`px-2.5 py-1 text-xs font-medium transition-colors ${
          layout === 'table'
            ? 'bg-board-card text-board-text shadow-sm'
            : 'text-board-text-muted hover:text-board-text'
        }`}
        title="Table view"
      >
        ☰ Table
      </button>
    </div>
  );
}
