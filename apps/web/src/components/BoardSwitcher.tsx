import { useState, useRef, useEffect } from 'react';
import type { BoardSummary } from '../types';
import { createBoard, archiveBoard, unarchiveBoard, renameBoard, deleteBoard, fetchArchivedBoards, searchVaultTasks } from '../api/client';
import type { VaultSearchResult } from '../api/client';

interface Props {
  boards: BoardSummary[];
  activeBoardId: string | null;
  onSelect: (id: string) => void;
  onBoardsChanged?: () => void;
}

export function BoardSwitcher({ boards, activeBoardId, onSelect, onBoardsChanged }: Props) {
  const [showCreate, setShowCreate] = useState(false);
  const [showArchive, setShowArchive] = useState(false);
  const [archivedBoards, setArchivedBoards] = useState<BoardSummary[]>([]);
  const [contextMenu, setContextMenu] = useState<{ boardId: string; x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [createName, setCreateName] = useState('');
  const [createFile, setCreateFile] = useState('');
  const [searchResults, setSearchResults] = useState<VaultSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout>>(null);
  const contextRef = useRef<HTMLDivElement>(null);
  const createRef = useRef<HTMLDivElement>(null);

  // Close context menu on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (contextRef.current && !contextRef.current.contains(e.target as Node)) setContextMenu(null);
      if (createRef.current && !createRef.current.contains(e.target as Node)) {
        setShowCreate(false);
        setShowResults(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const loadArchived = async () => {
    const archived = await fetchArchivedBoards();
    setArchivedBoards(archived);
  };

  const handleContextMenu = (e: React.MouseEvent, boardId: string) => {
    e.preventDefault();
    setContextMenu({ boardId, x: e.clientX, y: e.clientY });
  };

  const handleArchive = async (boardId: string) => {
    await archiveBoard(boardId);
    setContextMenu(null);
    onBoardsChanged?.();
  };

  const handleRename = async (boardId: string) => {
    setContextMenu(null);
    const board = boards.find((b) => b.id === boardId);
    if (board) {
      setRenaming(boardId);
      setRenameValue(board.name);
    }
  };

  const handleRenameSubmit = async (boardId: string) => {
    if (renameValue.trim()) {
      await renameBoard(boardId, renameValue.trim());
      onBoardsChanged?.();
    }
    setRenaming(null);
  };

  const handleDelete = async (boardId: string) => {
    const board = boards.find((b) => b.id === boardId);
    if (!confirm(`Delete board "${board?.name}"? Cards will be removed from DB but .md file will be kept.`)) return;
    await deleteBoard(boardId);
    setContextMenu(null);
    onBoardsChanged?.();
  };

  const handleUnarchive = async (boardId: string) => {
    await unarchiveBoard(boardId);
    setArchivedBoards((prev) => prev.filter((b) => b.id !== boardId));
    onBoardsChanged?.();
  };

  const handleCreate = async () => {
    if (!createName.trim()) return;
    await createBoard({
      name: createName.trim(),
      file: createFile.trim() || undefined,
    });
    setCreateName('');
    setCreateFile('');
    setShowCreate(false);
    setShowResults(false);
    onBoardsChanged?.();
  };

  const handleFileSearch = (value: string) => {
    setCreateFile(value);
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    if (value.trim().length < 2) {
      setSearchResults([]);
      setShowResults(false);
      return;
    }
    setSearching(true);
    searchTimeoutRef.current = setTimeout(async () => {
      try {
        const results = await searchVaultTasks(value.trim());
        setSearchResults(results);
        setShowResults(results.length > 0);
      } catch {
        setSearchResults([]);
        setShowResults(false);
      } finally {
        setSearching(false);
      }
    }, 300);
  };

  const handleSelectResult = (result: VaultSearchResult) => {
    setCreateFile(result.relativePath);
    if (!createName.trim()) setCreateName(result.fileName);
    setShowResults(false);
  };

  return (
    <nav className="flex gap-1 items-center relative">
      {boards.map((board) => {
        const isActive = board.id === activeBoardId;
        const isRenaming = renaming === board.id;

        if (isRenaming) {
          return (
            <input
              key={board.id}
              autoFocus
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleRenameSubmit(board.id);
                if (e.key === 'Escape') setRenaming(null);
              }}
              onBlur={() => handleRenameSubmit(board.id)}
              className="px-3 h-8 text-sm rounded-md border border-board-accent bg-board-card text-board-text outline-none w-32"
            />
          );
        }

        return (
          <button
            key={board.id}
            onClick={() => onSelect(board.id)}
            onContextMenu={(e) => handleContextMenu(e, board.id)}
            className={`px-3 h-8 text-sm rounded-md transition-colors border ${
              isActive
                ? 'text-board-accent border-board-accent font-medium'
                : 'text-board-text-muted hover:text-board-text hover:bg-board-column border-transparent'
            }`}
            style={isActive ? { backgroundColor: 'var(--board-accent-subtle)' } : undefined}
          >
            {board.name}
            <span className="ml-1.5 text-xs opacity-60">{board.totalCards}</span>
          </button>
        );
      })}

      {/* Add board button */}
      <button
        onClick={() => setShowCreate(true)}
        className="w-8 h-8 text-sm rounded-md transition-colors border border-dashed border-board-border text-board-text-muted hover:text-board-text hover:bg-board-column hover:border-board-text-muted flex items-center justify-center"
        title="Create new board"
      >
        +
      </button>

      {/* Archive button */}
      <button
        onClick={() => { setShowArchive((v) => !v); if (!showArchive) loadArchived(); }}
        className="w-8 h-8 text-sm rounded-md transition-colors border border-transparent text-board-text-muted hover:text-board-text hover:bg-board-column flex items-center justify-center"
        title="Archived boards"
      >
        📦
      </button>

      {/* Create board popover */}
      {showCreate && (
        <div ref={createRef} className="absolute top-full left-0 mt-2 z-50 bg-board-card border border-board-border rounded-lg shadow-xl p-4 w-80">
          <h3 className="text-sm font-medium text-board-text mb-3">New Board</h3>
          <input
            autoFocus
            placeholder="Board name"
            value={createName}
            onChange={(e) => setCreateName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            className="w-full px-3 py-1.5 text-sm rounded border border-board-border bg-board-bg text-board-text mb-2 outline-none focus:border-board-accent"
          />
          <div className="relative">
            <input
              placeholder="Search vault or enter path..."
              value={createFile}
              onChange={(e) => handleFileSearch(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !showResults && handleCreate()}
              onFocus={() => { if (searchResults.length > 0) setShowResults(true); }}
              className="w-full px-3 py-1.5 text-sm rounded border border-board-border bg-board-bg text-board-text outline-none focus:border-board-accent"
            />
            {searching && (
              <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-board-text-muted">...</span>
            )}
            {showResults && searchResults.length > 0 && (
              <div className="absolute left-0 right-0 top-full mt-1 bg-board-card border border-board-border rounded-lg shadow-xl max-h-64 overflow-y-auto z-50">
                {searchResults.map((r) => (
                  <button
                    key={r.relativePath}
                    onClick={() => handleSelectResult(r)}
                    className="w-full text-left px-3 py-2 hover:bg-board-column border-b border-board-border last:border-b-0 transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-board-text truncate">{r.fileName}</span>
                      {r.hasChecklist ? (
                        <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
                          {r.openTaskCount} task{r.openTaskCount !== 1 ? 's' : ''}
                        </span>
                      ) : (
                        <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-board-column text-board-text-muted">
                          No checklists
                        </span>
                      )}
                    </div>
                    {r.folder && (
                      <div className="text-[11px] text-board-text-muted truncate mt-0.5">{r.folder}</div>
                    )}
                    {r.sampleTasks.length > 0 && (
                      <div className="mt-1 space-y-0.5">
                        {r.sampleTasks.map((t, i) => (
                          <div key={i} className="text-[11px] text-board-text-muted truncate">
                            {'☐ '}{t}
                          </div>
                        ))}
                      </div>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="flex gap-2 justify-end mt-3">
            <button onClick={() => { setShowCreate(false); setShowResults(false); }} className="px-3 py-1 text-xs text-board-text-muted hover:text-board-text">Cancel</button>
            <button onClick={handleCreate} disabled={!createName.trim()} className="px-3 py-1 text-xs bg-board-accent text-white rounded disabled:opacity-50">Create</button>
          </div>
        </div>
      )}

      {/* Archived boards popover */}
      {showArchive && (
        <div className="absolute top-full right-0 mt-2 z-50 bg-board-card border border-board-border rounded-lg shadow-xl p-4 w-64">
          <h3 className="text-sm font-medium text-board-text mb-3">📦 Archived Boards</h3>
          {archivedBoards.length === 0 ? (
            <p className="text-xs text-board-text-muted">No archived boards</p>
          ) : (
            <div className="space-y-2">
              {archivedBoards.map((b) => (
                <div key={b.id} className="flex items-center justify-between">
                  <span className="text-sm text-board-text">{b.name} <span className="text-xs opacity-60">{b.totalCards}</span></span>
                  <button
                    onClick={() => handleUnarchive(b.id)}
                    className="text-xs text-board-accent hover:underline"
                  >
                    Restore
                  </button>
                </div>
              ))}
            </div>
          )}
          <button onClick={() => setShowArchive(false)} className="mt-3 text-xs text-board-text-muted hover:text-board-text">Close</button>
        </div>
      )}

      {/* Context menu */}
      {contextMenu && (
        <div
          ref={contextRef}
          className="fixed z-50 bg-board-card border border-board-border rounded-lg shadow-xl py-1 min-w-[140px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            onClick={() => handleRename(contextMenu.boardId)}
            className="w-full px-4 py-1.5 text-sm text-left text-board-text hover:bg-board-column"
          >
            ✏️ Rename
          </button>
          <button
            onClick={() => handleArchive(contextMenu.boardId)}
            className="w-full px-4 py-1.5 text-sm text-left text-board-text hover:bg-board-column"
          >
            📦 Archive
          </button>
          <hr className="my-1 border-board-border" />
          <button
            onClick={() => handleDelete(contextMenu.boardId)}
            className="w-full px-4 py-1.5 text-sm text-left text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20"
          >
            🗑 Delete
          </button>
        </div>
      )}
    </nav>
  );
}
