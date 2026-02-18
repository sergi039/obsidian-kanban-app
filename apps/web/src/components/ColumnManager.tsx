import { useState, useRef, useEffect } from 'react';

interface ColumnMenuProps {
  name: string;
  onRename: (oldName: string, newName: string) => Promise<void>;
  onDelete: (name: string) => Promise<void>;
}

export function ColumnMenu({ name, onRename, onDelete }: ColumnMenuProps) {
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState(name);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming) inputRef.current?.focus();
  }, [renaming]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleRename = async () => {
    const trimmed = newName.trim();
    if (trimmed && trimmed !== name) {
      await onRename(name, trimmed);
    }
    setRenaming(false);
    setOpen(false);
  };

  if (renaming) {
    return (
      <input
        ref={inputRef}
        value={newName}
        onChange={(e) => setNewName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') handleRename();
          if (e.key === 'Escape') { setRenaming(false); setNewName(name); }
        }}
        onBlur={handleRename}
        className="text-sm font-medium bg-transparent border-b text-board-text focus:outline-none w-24"
        style={{ borderColor: 'var(--board-accent)' }}
      />
    );
  }

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setOpen(!open)}
        className="text-board-text-muted hover:text-board-text opacity-0 group-hover:opacity-100 transition-opacity text-xs px-1"
        aria-label={`Column options for ${name}`}
      >
        ⋯
      </button>
      {open && (
        <div className="absolute right-0 top-6 bg-board-bg border border-board-border rounded-lg shadow-xl py-1 z-30 min-w-[140px]">
          <button
            onClick={() => { setRenaming(true); setOpen(false); }}
            className="w-full text-left px-3 py-1.5 text-sm text-board-text hover:bg-board-column transition-colors"
          >
            ✏️ Rename
          </button>
          <button
            onClick={async () => { setOpen(false); await onDelete(name); }}
            className="w-full text-left px-3 py-1.5 text-sm text-red-500 hover:bg-board-column transition-colors"
          >
            🗑 Delete
          </button>
        </div>
      )}
    </div>
  );
}

interface AddColumnProps {
  onAdd: (name: string) => Promise<void>;
}

export function AddColumnButton({ onAdd }: AddColumnProps) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const handleSubmit = async () => {
    const trimmed = name.trim();
    if (trimmed) {
      await onAdd(trimmed);
    }
    setName('');
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="w-80 min-w-[320px] shrink-0">
        <div className="bg-board-column rounded-lg p-3">
          <input
            ref={inputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSubmit();
              if (e.key === 'Escape') { setEditing(false); setName(''); }
            }}
            onBlur={() => { if (!name.trim()) { setEditing(false); setName(''); } }}
            placeholder="Column name…"
            className="w-full text-sm bg-transparent text-board-text placeholder:text-board-text-muted focus:outline-none"
          />
          <div className="flex gap-2 mt-2">
            <button
              onClick={handleSubmit}
              disabled={!name.trim()}
              className="px-3 py-1 text-xs font-medium text-white rounded disabled:opacity-50"
              style={{ backgroundColor: 'var(--board-accent)' }}
            >
              Add
            </button>
            <button
              onClick={() => { setEditing(false); setName(''); }}
              className="text-board-text-muted text-xs"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="shrink-0">
      <button
        onClick={() => setEditing(true)}
        className="flex items-center gap-1.5 px-4 py-2 text-sm text-board-text-muted hover:text-board-text hover:bg-board-column rounded-lg transition-colors whitespace-nowrap"
      >
        <span className="text-lg">+</span> Add column
      </button>
    </div>
  );
}
