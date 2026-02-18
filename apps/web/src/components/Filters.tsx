interface Props {
  searchText: string;
  onSearchChange: (text: string) => void;
  priorityFilter: string;
  onPriorityChange: (priority: string) => void;
}

export function Filters({ searchText, onSearchChange, priorityFilter, onPriorityChange }: Props) {
  return (
    <div className="flex items-center gap-2">
      <label htmlFor="task-search" className="sr-only">Search tasks</label>
      <input
        id="task-search"
        type="text"
        placeholder="Search tasks…"
        value={searchText}
        onChange={(e) => onSearchChange(e.target.value)}
        className="px-3 py-1.5 text-sm bg-board-column border border-board-border rounded-md text-board-text placeholder:text-board-text-muted/50 focus:outline-none focus:ring-2 focus:ring-board-accent/50 focus:border-board-accent/50 w-48"
      />
      <label htmlFor="priority-filter" className="sr-only">Filter by priority</label>
      <select
        id="priority-filter"
        value={priorityFilter}
        onChange={(e) => onPriorityChange(e.target.value)}
        className="px-2 py-1.5 text-sm bg-board-column border border-board-border rounded-md text-board-text-muted focus:outline-none focus:ring-2 focus:ring-board-accent/50 focus:border-board-accent/50 appearance-none cursor-pointer"
      >
        <option value="">All priorities</option>
        <option value="urgent">🔺 Urgent</option>
        <option value="high">⏫ High</option>
      </select>
    </div>
  );
}
