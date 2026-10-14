import { useState, useEffect, useCallback, useRef, useMemo, type FormEvent } from 'react';
import {
  clearApiToken,
  fetchBoards,
  fetchBoard,
  isAuthError,
  reloadSync,
  createCard,
  addColumn,
  renameColumn,
  deleteColumn,
  fetchFields,
  setApiToken,
  updateBoardPriorities,
  updateBoardCategories,
  fetchBoardReminders,
  fetchDueReminders,
  fireReminder,
  bulkMoveCards,
  moveCard,
  trashCard,
} from './api/client';
import type { BoardSummary, BoardDetail, Field, PriorityDef, CategoryDef, Reminder } from './types';
import { BoardSwitcher } from './components/BoardSwitcher';
import { Board } from './components/Board';

import { TableView } from './components/TableView';
import { ViewSwitcher } from './components/ViewSwitcher';
import { Icon } from './components/Icon';
import { Filters } from './components/Filters';
import { CardDetail } from './components/CardDetail';
import { useWebSocket } from './hooks/useWebSocket';
import { useTheme } from './hooks/useTheme';
import { ThemeToggle } from './components/ThemeToggle';
import { AutomationsPanel } from './components/AutomationsPanel';
import { RemindersPanel } from './components/RemindersPanel';
import { TrashPanel } from './components/TrashPanel';
import { ErrorBoundary } from './components/ErrorBoundary';
import { BulkActionsBar } from './components/BulkActionsBar';
import { BoardSort } from './components/BoardSort';
import type { BoardSortField } from './components/BoardSort';
import type { Card } from './types';
import { isDueReminder } from './lib/reminder-utils';
import { filterCards as filterBoardCards } from './lib/card-filter';
import { doneTargetColumn, openTargetColumn, toggleDoneTargetColumn } from './lib/done-utils';
import { CalendarSettingsContext, NO_CALENDAR_SETTINGS, type CalendarSettings } from './lib/calendar-context';
import { dropDeepLinkParams, loadActiveBoard, pickInitialBoard, storeActiveBoard } from './lib/active-board';
import { browserStorage } from './lib/browser-storage';

const FALLBACK_PRIORITIES: PriorityDef[] = [
  { id: 'urgent', emoji: '🔺', label: 'Urgent', color: '#ef4444' },
  { id: 'high', emoji: '⏫', label: 'High', color: '#f59e0b' },
];

const BROWSER_NOTIFIED_STORAGE_KEY = 'kanban:browser-reminders:notified';

function loadBrowserNotifiedIds(storage: Storage | undefined): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    return new Set(JSON.parse(storage?.getItem(BROWSER_NOTIFIED_STORAGE_KEY) || '[]'));
  } catch {
    return new Set();
  }
}

function storeBrowserNotifiedIds(storage: Storage | undefined, ids: Set<string>): void {
  try {
    storage?.setItem(BROWSER_NOTIFIED_STORAGE_KEY, JSON.stringify([...ids].slice(-200)));
  } catch {
    // Storage can be unavailable in private/locked-down browser contexts.
  }
}

function claimBrowserNotification(reminderId: string, fallback: Set<string>): boolean {
  const storage = browserStorage();
  const ids = loadBrowserNotifiedIds(storage);
  if (ids.has(reminderId) || fallback.has(reminderId)) return false;
  ids.add(reminderId);
  fallback.add(reminderId);
  storeBrowserNotifiedIds(storage, ids);
  return true;
}

function releaseBrowserNotification(reminderId: string, fallback: Set<string>): void {
  const storage = browserStorage();
  const ids = loadBrowserNotifiedIds(storage);
  ids.delete(reminderId);
  fallback.delete(reminderId);
  storeBrowserNotifiedIds(storage, ids);
}

export default function App() {
  const [boards, setBoards] = useState<BoardSummary[]>([]);
  const [activeBoardId, setActiveBoardId] = useState<string | null>(null);
  const [boardDetail, setBoardDetail] = useState<BoardDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterQuery, setFilterQuery] = useState('');
  const [layout, setLayout] = useState<'board' | 'table'>('board');
  const [selectedCard, setSelectedCard] = useState<Card | null>(null);
  const [boardFields, setBoardFields] = useState<Field[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [showAutomations, setShowAutomations] = useState(false);
  const [showReminders, setShowReminders] = useState(false);
  const [showTrash, setShowTrash] = useState(false);
  const [boardSortField, setBoardSortField] = useState<BoardSortField>('position');
  const [boardReminders, setBoardReminders] = useState<Reminder[]>([]);
  const [selectedCardIds, setSelectedCardIds] = useState<Set<string>>(new Set());
  const [browserNotificationPermission, setBrowserNotificationPermission] = useState<NotificationPermission>(() =>
    typeof window !== 'undefined' && 'Notification' in window ? Notification.permission : 'denied',
  );
  const [authRequired, setAuthRequired] = useState(false);
  const [apiTokenInput, setApiTokenInput] = useState('');
  const openSettingsRef = useRef<(() => void) | null>(null);
  const openedCardParamRef = useRef<string | null>(null);
  const browserNotifiedRef = useRef<Set<string>>(loadBrowserNotifiedIds(browserStorage()));
  const { theme, cycleTheme } = useTheme();

  // Load boards list
  const loadBoardsList = useCallback(async () => {
    try {
      const data = await fetchBoards();
      setBoards(data);
      setActiveBoardId((current) => {
        if (current) return current;
        const boardParam = new URLSearchParams(window.location.search).get('board');
        return pickInitialBoard(data.map((board) => board.id), boardParam, loadActiveBoard(browserStorage()));
      });
      setAuthRequired(false);
      setError(null);
    } catch (err) {
      console.error('Failed to fetch boards:', err);
      if (isAuthError(err)) {
        clearApiToken();
        setAuthRequired(true);
        setError(null);
      } else {
        setError('Failed to load boards. Is the API running?');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadBoardsList();
  }, [loadBoardsList]);

  // Remember the open board so a reload returns to it
  useEffect(() => {
    if (activeBoardId) storeActiveBoard(browserStorage(), activeBoardId);
  }, [activeBoardId]);

  // Load active board detail + fields + reminders
  const loadBoard = useCallback(async (): Promise<BoardDetail | null> => {
    if (!activeBoardId) return null;
    try {
      const [detail, fields, reminders] = await Promise.all([
        fetchBoard(activeBoardId),
        fetchFields(activeBoardId),
        fetchBoardReminders(activeBoardId).catch((err) => {
          console.warn('Failed to fetch reminders:', err);
          return [] as Reminder[];
        }),
      ]);
      setBoardDetail(detail);
      setBoardFields(fields);
      setBoardReminders(reminders);
      setError(null);
      return detail;
    } catch (err) {
      console.error('Failed to fetch board:', err);
      if (isAuthError(err)) {
        clearApiToken();
        setAuthRequired(true);
        setError(null);
      } else {
        setError(`Failed to load board "${activeBoardId}".`);
      }
      return null;
    }
  }, [activeBoardId]);

  useEffect(() => {
    loadBoard();
  }, [loadBoard]);

  // WebSocket: auto-refresh when files change
  const handleWsUpdate = useCallback(
    (boardId?: string) => {
      if (!boardId || boardId === activeBoardId) {
        loadBoard();
      }
      fetchBoards()
        .then(setBoards)
        .catch((err) => {
          if (isAuthError(err)) {
            clearApiToken();
            setAuthRequired(true);
          }
        });
    },
    [activeBoardId, loadBoard],
  );
  useWebSocket(handleWsUpdate);

  const requestBrowserNotifications = useCallback(async () => {
    if (!('Notification' in window)) return;
    const permission = await Notification.requestPermission();
    setBrowserNotificationPermission(permission);
  }, []);

  const handleBoardChange = (boardId: string) => {
    dropDeepLinkParams(window);
    setActiveBoardId(boardId);
    setFilterQuery('');
    setBoardReminders([]);
    setShowReminders(false);
    setShowTrash(false);
    setSelectedCardIds(new Set());
  };

  const toggleCardSelection = useCallback((cardId: string) => {
    setSelectedCardIds((prev) => {
      const next = new Set(prev);
      if (next.has(cardId)) next.delete(cardId);
      else next.add(cardId);
      return next;
    });
  }, []);

  const clearCardSelection = useCallback(() => setSelectedCardIds(new Set()), []);

  const handleLayoutChange = (newLayout: 'board' | 'table') => {
    setLayout(newLayout);
    setSelectedCardIds(new Set());
  };

  const handleBulkMove = async (column: string) => {
    if (selectedCardIds.size === 0) return;
    try {
      await bulkMoveCards([...selectedCardIds], column);
    } catch (err) {
      if (isAuthError(err)) {
        clearApiToken();
        setAuthRequired(true);
        return;
      }
      throw err;
    }
    setSelectedCardIds(new Set());
    await loadBoard();
    const updatedBoards = await fetchBoards();
    setBoards(updatedBoards);
  };

  const handleToggleDone = async (card: Card) => {
    if (!boardDetail) return;
    const target = toggleDoneTargetColumn(card.is_done, boardDetail.columns.map((c) => c.name));
    if (!target) {
      setError(`Board "${boardDetail.name}" has no column to move this card to.`);
      return;
    }
    try {
      await moveCard(card.id, { column: target, position: 0 });
    } catch (err) {
      console.error('Toggle done failed:', err);
      if (isAuthError(err)) {
        clearApiToken();
        setAuthRequired(true);
        return;
      }
      setError(`Failed to move card to "${target}": ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    await loadBoard();
    const updatedBoards = await fetchBoards();
    setBoards(updatedBoards);
  };

  const boardColumnNames = boardDetail?.columns.map((c) => c.name) ?? [];
  const canToggleDone = doneTargetColumn(boardColumnNames) !== null && openTargetColumn(boardColumnNames) !== null;

  const handleCardTrash = async (cardId: string) => {
    try {
      await trashCard(cardId);
    } catch (err) {
      if (isAuthError(err)) {
        clearApiToken();
        setAuthRequired(true);
        return;
      }
      throw err;
    }
    setSelectedCard(null);
    await loadBoard();
    const updatedBoards = await fetchBoards();
    setBoards(updatedBoards);
  };

  const handleReload = async () => {
    setSyncing(true);
    try {
      await reloadSync();
      await loadBoard();
      const updatedBoards = await fetchBoards();
      setBoards(updatedBoards);
      setError(null);
    } catch (err) {
      console.error('Sync failed:', err);
      if (isAuthError(err)) {
        clearApiToken();
        setAuthRequired(true);
        setError(null);
      } else {
        setError('Sync failed. Check server logs.');
      }
    } finally {
      setSyncing(false);
    }
  };

  const handleAuthSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const token = apiTokenInput.trim();
    if (!token) return;

    setApiToken(token);
    setAuthRequired(false);
    setLoading(true);
    await loadBoardsList();
  };

  const handleCardMove = async () => {
    try {
      await loadBoard();
    } catch {
      // loadBoard already handles errors
    }
  };

  const handleCardAdd = async (title: string, column: string) => {
    if (!activeBoardId) return;
    await createCard(activeBoardId, title, column);
    await loadBoard();
    const updatedBoards = await fetchBoards();
    setBoards(updatedBoards);
  };

  const handleColumnAdd = async (name: string) => {
    if (!activeBoardId) return;
    await addColumn(activeBoardId, name);
    await loadBoard();
  };

  const handleColumnRename = async (oldName: string, newName: string) => {
    if (!activeBoardId) return;
    await renameColumn(activeBoardId, oldName, newName);
    await loadBoard();
  };

  const handleColumnDelete = async (name: string) => {
    if (!activeBoardId) return;
    if (!confirm(`Delete column "${name}"? Cards will be moved to another column.`)) return;
    await deleteColumn(activeBoardId, name);
    await loadBoard();
  };

  const handlePrioritiesChange = async (priorities: PriorityDef[]) => {
    if (!activeBoardId) return;
    await updateBoardPriorities(activeBoardId, priorities);
    await loadBoard();
    const updatedBoards = await fetchBoards();
    setBoards(updatedBoards);
  };

  const handleCategoriesChange = async (categories: CategoryDef[]) => {
    if (!activeBoardId) return;
    await updateBoardCategories(activeBoardId, categories);
    await loadBoard();
    const updatedBoards = await fetchBoards();
    setBoards(updatedBoards);
  };

  const allCards = useMemo(
    () => boardDetail?.columns.flatMap((col) => col.cards) ?? [],
    [boardDetail],
  );

  const remindersByCard = useMemo(() => {
    const map = new Map<string, Reminder[]>();
    for (const reminder of boardReminders) {
      const existing = map.get(reminder.card_id) ?? [];
      existing.push(reminder);
      map.set(reminder.card_id, existing);
    }
    return map;
  }, [boardReminders]);

  const dueReminderCount = useMemo(
    () => boardReminders.filter((reminder) => isDueReminder(reminder)).length,
    [boardReminders],
  );

  // Drop selection entries for cards that no longer exist after a reload
  useEffect(() => {
    setSelectedCardIds((prev) => {
      if (prev.size === 0) return prev;
      const existing = new Set(allCards.map((card) => card.id));
      const next = new Set([...prev].filter((id) => existing.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [allCards]);

  useEffect(() => {
    const cardParam = new URLSearchParams(window.location.search).get('card');
    if (!cardParam || openedCardParamRef.current === cardParam || allCards.length === 0) return;
    const card = allCards.find((candidate) => candidate.id === cardParam);
    if (card) {
      setSelectedCard(card);
      openedCardParamRef.current = cardParam;
    }
  }, [allCards]);

  useEffect(() => {
    if (!activeBoardId) return;
    if (!('Notification' in window) || browserNotificationPermission !== 'granted') return;

    let stopped = false;
    const poll = async () => {
      try {
        const due = await fetchDueReminders({
          board_id: activeBoardId,
          channel: 'browser',
          before: new Date().toISOString(),
          limit: 20,
        });
        for (const reminder of due) {
          if (stopped || !claimBrowserNotification(reminder.id, browserNotifiedRef.current)) continue;
          const card = allCards.find((candidate) => candidate.id === reminder.card_id);
          try {
            const notification = new Notification(`Kanban: ${card?.title || reminder.card_title || 'Reminder'}`, {
              body: reminder.message || `Board: ${reminder.board_id}`,
              tag: `kanban-reminder-${reminder.id}`,
              requireInteraction: true,
            });
            notification.onclick = () => {
              window.focus();
              if (card) setSelectedCard(card);
              notification.close();
            };
            await fireReminder(reminder.id);
          } catch (err) {
            releaseBrowserNotification(reminder.id, browserNotifiedRef.current);
            throw err;
          }
        }
        if (due.length > 0) await loadBoard();
      } catch (err) {
        console.warn('Browser reminder delivery failed:', err);
      }
    };

    poll();
    const timer = window.setInterval(poll, 30_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [activeBoardId, allCards, browserNotificationPermission, loadBoard]);

  const filterCards = useCallback(
    (cards: Card[]) => filterBoardCards(cards, filterQuery, remindersByCard),
    [filterQuery, remindersByCard],
  );

  const calendarSettings = useMemo<CalendarSettings>(
    () => boardDetail
      ? {
        accounts: boardDetail.calendarAccounts ?? [],
        defaultAccountId: boardDetail.calendarAccount?.id ?? null,
        publicUrl: boardDetail.publicUrl ?? null,
      }
      : NO_CALENDAR_SETTINGS,
    [boardDetail],
  );

  const boardPriorities = boardDetail && Array.isArray(boardDetail.priorities)
    ? boardDetail.priorities
    : FALLBACK_PRIORITIES;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-board-bg">
        <div className="text-board-text-muted text-lg">Loading boards…</div>
      </div>
    );
  }

  if (authRequired) {
    return (
      <ErrorBoundary>
        <div className="min-h-screen bg-board-bg flex items-center justify-center px-6">
          <form
            onSubmit={handleAuthSubmit}
            className="w-full max-w-sm border border-board-border bg-board-column rounded-lg p-5 shadow-lg"
          >
            <h1 className="text-base font-semibold text-board-text mb-4">API token required</h1>
            <label className="block text-sm text-board-text-muted mb-2" htmlFor="api-token">
              Token
            </label>
            <input
              id="api-token"
              type="password"
              value={apiTokenInput}
              onChange={(event) => setApiTokenInput(event.target.value)}
              autoFocus
              className="w-full h-9 px-3 rounded-md border border-board-border bg-board-bg text-board-text outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              type="submit"
              disabled={!apiTokenInput.trim()}
              className="mt-4 w-full h-9 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Continue
            </button>
          </form>
        </div>
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
    {/* Viewport-high page: the board scrolls inside <main>, so a long column never stretches the page */}
    <div className="h-dvh bg-board-bg flex flex-col">
      {/* Header */}
      {/* Wraps onto a second row on narrow windows instead of squeezing buttons into two-line stacks */}
      <header className="border-b border-board-border px-6 py-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex items-center gap-4 min-w-0">
          <h1 className="text-lg font-semibold text-board-text flex items-center gap-2 whitespace-nowrap">
            <Icon name="diamond" size={14} className="text-purple-500" /> Obsidian Kanban
          </h1>
          <a
            href="/about"
            className="flex items-center text-board-text-muted hover:text-board-text transition-colors"
            title="About this project"
            aria-label="About this project"
          >
            <Icon name="help" size={14} />
          </a>
          <BoardSwitcher
            boards={boards}
            activeBoardId={activeBoardId}
            onSelect={handleBoardChange}
            onBoardsChanged={async () => {
              const updated = await fetchBoards();
              setBoards(updated);
              if (updated.length > 0 && !updated.find((b) => b.id === activeBoardId)) {
                setActiveBoardId(updated[0].id);
              }
            }}
          />
        </div>
        <div className="flex grow flex-wrap items-center justify-end gap-2">
          <Filters
            filterQuery={filterQuery}
            onFilterChange={setFilterQuery}
            columns={boardDetail?.columns.map(c => c.name) ?? []}
            priorities={boardPriorities}
            categories={boardDetail?.categories ?? []}
          />
          <ViewSwitcher layout={layout} onLayoutChange={handleLayoutChange} />
          {layout === 'board' && (
            <BoardSort value={boardSortField} onChange={setBoardSortField} />
          )}
          <button
            onClick={() => setShowAutomations(true)}
            className="px-3 h-8 text-sm inline-flex items-center gap-1.5 whitespace-nowrap bg-board-column hover:bg-board-card border border-board-border rounded-md text-board-text-muted hover:text-board-text transition-colors"
            title="Automations"
          >
            <Icon name="zap" /> Auto
          </button>
          <button
            onClick={() => setShowReminders((value) => !value)}
            className={`px-3 h-8 text-sm inline-flex items-center gap-1.5 whitespace-nowrap border border-board-border rounded-md transition-colors ${
              dueReminderCount > 0
                ? 'bg-amber-500/15 text-amber-500 hover:bg-amber-500/20'
                : 'bg-board-column hover:bg-board-card text-board-text-muted hover:text-board-text'
            }`}
            title="Reminders"
          >
            <Icon name="alarm" /> {dueReminderCount}
          </button>
          <button
            onClick={() => setShowTrash((value) => !value)}
            disabled={!boardDetail}
            className="px-3 h-8 text-sm inline-flex items-center gap-1.5 whitespace-nowrap bg-board-column hover:bg-board-card border border-board-border rounded-md text-board-text-muted hover:text-board-text transition-colors disabled:opacity-50"
            title="Trash — deleted cards you can restore"
          >
            <Icon name="trash" /> {boardDetail?.trashCount ?? 0}
          </button>
          {'Notification' in window && browserNotificationPermission !== 'granted' && (
            <button
              onClick={requestBrowserNotifications}
              disabled={browserNotificationPermission === 'denied'}
              className="px-3 h-8 text-sm inline-flex items-center gap-1.5 whitespace-nowrap bg-board-column hover:bg-board-card border border-board-border rounded-md text-board-text-muted hover:text-board-text transition-colors disabled:opacity-50"
              title={browserNotificationPermission === 'denied' ? 'Browser notifications are blocked in browser settings' : 'Enable browser notifications'}
            >
              <Icon name="bell" /> Browser
            </button>
          )}
          <button
            onClick={handleReload}
            disabled={syncing}
            className="px-3 h-8 text-sm inline-flex items-center gap-1.5 whitespace-nowrap bg-board-column hover:bg-board-card border border-board-border rounded-md text-board-text-muted hover:text-board-text transition-colors disabled:opacity-50"
            title="Reload from files"
          >
            <Icon name="refresh" className={syncing ? 'animate-spin' : ''} /> {syncing ? 'Syncing…' : 'Sync'}
          </button>
          <ThemeToggle theme={theme} onCycle={cycleTheme} />
        </div>
      </header>

      {/* Error banner */}
      {error && (
        <div className="bg-red-100 dark:bg-red-900/30 border-b border-red-300 dark:border-red-700/50 px-6 py-2 text-sm text-red-700 dark:text-red-400 flex items-center gap-2">
          <Icon name="alert" />
          <span>{error}</span>
          <button
            onClick={() => setError(null)}
            className="ml-1 text-red-500 hover:text-red-300"
            aria-label="Dismiss error"
          >
            <Icon name="x" />
          </button>
        </div>
      )}

      <CalendarSettingsContext.Provider value={calendarSettings}>
      {/* Board */}
      <main className="flex-1 min-h-0 overflow-auto p-6">
        {boardDetail ? (
          layout === 'board' ? (
            <Board
              board={{ ...boardDetail, priorities: boardPriorities }}
              sortField={boardSortField}
              filterCards={filterCards}
              remindersByCard={remindersByCard}
              selectedCardIds={selectedCardIds}
              onToggleSelect={toggleCardSelection}
              onToggleDone={canToggleDone ? handleToggleDone : undefined}
              onCardMove={handleCardMove}
              onCardClick={setSelectedCard}
              onCardAdd={handleCardAdd}
              onColumnAdd={handleColumnAdd}
              onColumnRename={handleColumnRename}
              onColumnDelete={handleColumnDelete}
              onPrioritiesChange={handlePrioritiesChange}
              onCategoriesChange={handleCategoriesChange}
              openSettingsRef={openSettingsRef}
            />
          ) : (
            <TableView
              cards={filterCards(allCards)}
              columns={boardDetail.columns.map((c) => c.name)}
              priorities={boardPriorities}
              categories={boardDetail?.categories ?? []}
              boardId={boardDetail.id}
              onCardClick={setSelectedCard}
              onCardAdd={handleCardAdd}
              onRefresh={loadBoard}
            />
          )
        ) : (
          <div className="text-board-text-muted text-center mt-20">Select a board</div>
        )}
      </main>

      {/* Bulk actions bar (board view, while cards are selected) */}
      {layout === 'board' && selectedCardIds.size > 0 && boardDetail && (
        <BulkActionsBar
          count={selectedCardIds.size}
          columns={boardDetail.columns.map((c) => c.name)}
          onMove={handleBulkMove}
          onClear={clearCardSelection}
        />
      )}

      {/* Card detail modal */}
      {selectedCard && (
        <CardDetail
          card={selectedCard}
          columns={boardDetail?.columns.map((c) => c.name) || []}
          priorities={boardPriorities}
          categories={boardDetail?.categories ?? []}
          fields={boardFields}
          onClose={() => setSelectedCard(null)}
          onUpdate={async () => {
            const detail = await loadBoard();
            const updatedBoards = await fetchBoards();
            setBoards(updatedBoards);
            if (detail) {
              setSelectedCard((prev) => {
                if (!prev) return prev;
                return detail.columns.flatMap((c) => c.cards).find((c) => c.id === prev.id) ?? prev;
              });
            }
          }}
          onRemindersChanged={async () => {
            await loadBoard();
          }}
          onManageCategories={() => {
            setSelectedCard(null);
            setTimeout(() => openSettingsRef.current?.(), 50);
          }}
          onTrash={() => handleCardTrash(selectedCard.id)}
        />
      )}

      </CalendarSettingsContext.Provider>

      {/* Automations panel */}
      {showAutomations && activeBoardId && (
        <AutomationsPanel
          boardId={activeBoardId}
          columns={boardDetail?.columns.map((c) => c.name) || []}
          fields={boardFields}
          onClose={() => setShowAutomations(false)}
        />
      )}

      {showTrash && boardDetail && (
        <TrashPanel
          boardId={boardDetail.id}
          trashCount={boardDetail.trashCount}
          onClose={() => setShowTrash(false)}
          onRestored={async () => {
            await loadBoard();
            const updatedBoards = await fetchBoards();
            setBoards(updatedBoards);
          }}
        />
      )}

      {showReminders && (
        <RemindersPanel
          reminders={boardReminders}
          cards={allCards}
          onClose={() => setShowReminders(false)}
          onOpenCard={setSelectedCard}
          onRefresh={async () => {
            await loadBoard();
          }}
        />
      )}
    </div>
    </ErrorBoundary>
  );
}
