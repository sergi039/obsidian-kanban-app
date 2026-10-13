import { Icon } from './Icon';

interface Props {
  layout: 'board' | 'table';
  onLayoutChange: (layout: 'board' | 'table') => void;
}

export function ViewSwitcher({ layout, onLayoutChange }: Props) {
  return (
    <div className="flex items-center bg-board-column rounded-md border border-board-border overflow-hidden h-8">
      <button
        onClick={() => onLayoutChange('board')}
        aria-pressed={layout === 'board'}
        className={`px-2.5 h-8 text-xs font-medium inline-flex items-center gap-1.5 whitespace-nowrap transition-colors ${
          layout === 'board'
            ? 'bg-board-card text-board-text shadow-sm'
            : 'text-board-text-muted hover:text-board-text'
        }`}
        title="Board view"
      >
        <Icon name="board" size={14} /> Board
      </button>
      <button
        onClick={() => onLayoutChange('table')}
        aria-pressed={layout === 'table'}
        className={`px-2.5 h-8 text-xs font-medium inline-flex items-center gap-1.5 whitespace-nowrap transition-colors ${
          layout === 'table'
            ? 'bg-board-card text-board-text shadow-sm'
            : 'text-board-text-muted hover:text-board-text'
        }`}
        title="Table view"
      >
        <Icon name="table" size={14} /> Table
      </button>
    </div>
  );
}
