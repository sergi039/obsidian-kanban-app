import { useState, useRef, useEffect } from 'react';

interface Props {
  boardId: string;
  columnName: string;
  onAdd: (title: string) => Promise<void>;
}

export function AddCard({ boardId, columnName, onAdd }: Props) {
  const [isEditing, setIsEditing] = useState(false);
  const [title, setTitle] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus();
    }
  }, [isEditing]);

  const handleSubmit = async () => {
    const trimmed = title.trim();
    if (!trimmed) {
      setIsEditing(false);
      setTitle('');
      return;
    }

    setSubmitting(true);
    try {
      await onAdd(trimmed);
      setTitle('');
      // Keep editing mode open for quick multi-add
      inputRef.current?.focus();
    } catch (err) {
      console.error('Failed to add card:', err);
    } finally {
      setSubmitting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
    if (e.key === 'Escape') {
      setIsEditing(false);
      setTitle('');
    }
  };

  if (!isEditing) {
    return (
      <button
        onClick={() => setIsEditing(true)}
        className="w-full text-left px-3 py-2 text-sm text-board-text-muted hover:text-board-text rounded-lg hover:bg-board-card transition-colors flex items-center gap-1.5"
      >
        <span className="text-lg leading-none">+</span> Add item
      </button>
    );
  }

  return (
    <div className="bg-board-card border border-board-border rounded-lg p-2">
      <textarea
        ref={inputRef}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          if (!title.trim()) {
            setIsEditing(false);
            setTitle('');
          }
        }}
        placeholder="Enter a title…"
        rows={2}
        disabled={submitting}
        className="w-full bg-transparent text-sm text-board-text placeholder:text-board-text-muted resize-none focus:outline-none"
      />
      <div className="flex items-center gap-2 mt-1.5">
        <button
          onClick={handleSubmit}
          disabled={submitting || !title.trim()}
          className="px-3 py-1 text-xs font-medium rounded text-white disabled:opacity-50 transition-colors"
          style={{ backgroundColor: 'var(--board-accent)' }}
        >
          {submitting ? 'Adding…' : 'Add'}
        </button>
        <button
          onClick={() => { setIsEditing(false); setTitle(''); }}
          className="text-board-text-muted hover:text-board-text text-sm px-1"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
