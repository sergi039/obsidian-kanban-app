import { useState, useEffect, useCallback } from 'react';
import { fetchAutomations, createAutomation, updateAutomation, deleteAutomation } from '../api/client';
import type { AutomationRule, Trigger, AutomationAction, Field } from '../types';

interface Props {
  boardId: string;
  columns: string[];
  fields: Field[];
  onClose: () => void;
}

const TRIGGER_LABELS: Record<string, string> = {
  'card.moved': '📦 Card moved',
  'card.created': '✨ Card created',
};

const ACTION_LABELS: Record<string, string> = {
  'set_field': '🏷️ Set field',
  'add_comment': '💬 Add comment',
  'set_due_date': '📅 Set due date',
};

function triggerSummary(t: Trigger, columns: string[]): string {
  if (t.type === 'card.moved') {
    const parts: string[] = [];
    if (t.from_column) parts.push(`from "${t.from_column}"`);
    if (t.to_column) parts.push(`to "${t.to_column}"`);
    return parts.length ? `Card moved ${parts.join(' ')}` : 'Card moved (any column)';
  }
  if (t.type === 'card.created') {
    return t.column ? `Card created in "${t.column}"` : 'Card created (any column)';
  }
  return 'Unknown trigger';
}

function actionSummary(a: AutomationAction, fields: Field[]): string {
  if (a.type === 'set_field') {
    const field = fields.find((f) => f.id === a.field_id);
    return `Set "${field?.name ?? a.field_id}" → ${a.value ?? '(clear)'}`;
  }
  if (a.type === 'add_comment') {
    return `Comment: "${a.text.length > 40 ? a.text.slice(0, 40) + '…' : a.text}"`;
  }
  if (a.type === 'set_due_date') {
    return `Due in ${a.days_from_now} day${a.days_from_now !== 1 ? 's' : ''}`;
  }
  return 'Unknown action';
}

function RuleCard({ rule, columns, fields, onToggle, onDelete }: {
  rule: AutomationRule;
  columns: string[];
  fields: Field[];
  onToggle: () => void;
  onDelete: () => void;
}) {
  return (
    <div className={`border rounded-lg p-3 transition-colors ${rule.enabled ? 'border-board-border bg-board-column' : 'border-board-border/50 bg-board-column/50 opacity-60'}`}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <button
            onClick={onToggle}
            className={`w-9 h-5 rounded-full transition-colors relative ${rule.enabled ? 'bg-green-500' : 'bg-gray-400'}`}
            title={rule.enabled ? 'Disable' : 'Enable'}
          >
            <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${rule.enabled ? 'left-[18px]' : 'left-0.5'}`} />
          </button>
          <span className="text-sm font-medium text-board-text">{rule.name}</span>
        </div>
        <button
          onClick={onDelete}
          className="text-xs text-board-text-muted hover:text-red-400 transition-colors px-1"
          title="Delete"
        >
          🗑️
        </button>
      </div>
      <div className="text-xs text-board-text-muted space-y-1">
        <div>⚡ {triggerSummary(rule.trigger, columns)}</div>
        {rule.actions.map((a, i) => (
          <div key={i} className="pl-3">→ {actionSummary(a, fields)}</div>
        ))}
      </div>
    </div>
  );
}

export function AutomationsPanel({ boardId, columns, fields, onClose }: Props) {
  const [rules, setRules] = useState<AutomationRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);

  // Create form state
  const [name, setName] = useState('');
  const [triggerType, setTriggerType] = useState<'card.moved' | 'card.created'>('card.moved');
  const [fromColumn, setFromColumn] = useState('');
  const [toColumn, setToColumn] = useState('');
  const [createdInColumn, setCreatedInColumn] = useState('');
  const [actionType, setActionType] = useState<'set_field' | 'add_comment' | 'set_due_date'>('add_comment');
  const [actionFieldId, setActionFieldId] = useState('');
  const [actionFieldValue, setActionFieldValue] = useState('');
  const [actionCommentText, setActionCommentText] = useState('');
  const [actionDaysFromNow, setActionDaysFromNow] = useState(7);
  const [creating, setCreating] = useState(false);

  const loadRules = useCallback(async () => {
    try {
      const data = await fetchAutomations(boardId);
      setRules(data);
    } catch (err) {
      console.error('Failed to load automations:', err);
    } finally {
      setLoading(false);
    }
  }, [boardId]);

  useEffect(() => { loadRules(); }, [loadRules]);

  const handleToggle = async (rule: AutomationRule) => {
    try {
      await updateAutomation(rule.id, { enabled: !rule.enabled });
      await loadRules();
    } catch (err) {
      console.error('Failed to toggle automation:', err);
    }
  };

  const handleDelete = async (rule: AutomationRule) => {
    try {
      await deleteAutomation(rule.id);
      setRules((prev) => prev.filter((r) => r.id !== rule.id));
    } catch (err) {
      console.error('Failed to delete automation:', err);
    }
  };

  const handleCreate = async () => {
    if (!name.trim()) return;

    const trigger: Trigger = triggerType === 'card.moved'
      ? { type: 'card.moved', ...(fromColumn ? { from_column: fromColumn } : {}), ...(toColumn ? { to_column: toColumn } : {}) }
      : { type: 'card.created', ...(createdInColumn ? { column: createdInColumn } : {}) };

    let action: AutomationAction;
    switch (actionType) {
      case 'set_field':
        if (!actionFieldId) return;
        action = { type: 'set_field', field_id: actionFieldId, value: actionFieldValue || null };
        break;
      case 'add_comment':
        if (!actionCommentText.trim()) return;
        action = { type: 'add_comment', text: actionCommentText, author: 'automation' };
        break;
      case 'set_due_date':
        action = { type: 'set_due_date', days_from_now: actionDaysFromNow };
        break;
    }

    setCreating(true);
    try {
      await createAutomation({
        board_id: boardId,
        name: name.trim(),
        trigger,
        actions: [action],
      });
      // Reset form
      setName('');
      setFromColumn('');
      setToColumn('');
      setCreatedInColumn('');
      setActionCommentText('');
      setActionFieldValue('');
      setShowCreate(false);
      await loadRules();
    } catch (err) {
      console.error('Failed to create automation:', err);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-40 flex items-start justify-center pt-[5vh] pb-[5vh] overflow-y-auto" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-board-bg border border-board-border rounded-xl shadow-2xl w-full max-w-2xl my-auto"
      >
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-board-border">
          <h2 className="text-lg font-semibold text-board-text flex items-center gap-2">
            ⚡ Automations
          </h2>
          <button onClick={onClose} className="text-board-text-muted hover:text-board-text text-xl p-1 rounded-lg hover:bg-board-column">
            ✕
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* Existing rules */}
          {loading ? (
            <div className="text-sm text-board-text-muted animate-pulse">Loading…</div>
          ) : rules.length === 0 && !showCreate ? (
            <div className="text-center py-8">
              <div className="text-3xl mb-2">⚡</div>
              <p className="text-sm text-board-text-muted mb-3">No automations yet</p>
              <p className="text-xs text-board-text-muted mb-4">
                Automate repetitive tasks — add comments, set due dates, or update fields when cards move or are created.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {rules.map((rule) => (
                <RuleCard
                  key={rule.id}
                  rule={rule}
                  columns={columns}
                  fields={fields}
                  onToggle={() => handleToggle(rule)}
                  onDelete={() => handleDelete(rule)}
                />
              ))}
            </div>
          )}

          {/* Create form */}
          {showCreate ? (
            <div className="border border-board-border rounded-lg p-4 space-y-3 bg-board-column">
              <h3 className="text-sm font-medium text-board-text">New Automation</h3>

              {/* Name */}
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Rule name…"
                className="w-full text-sm bg-board-bg border border-board-border rounded-md px-3 py-1.5 text-board-text focus:outline-none"
              />

              {/* Trigger */}
              <div>
                <label className="text-xs font-medium text-board-text-muted uppercase tracking-wider block mb-1">When</label>
                <select
                  value={triggerType}
                  onChange={(e) => setTriggerType(e.target.value as 'card.moved' | 'card.created')}
                  className="w-full text-sm bg-board-bg border border-board-border rounded-md px-2 py-1.5 text-board-text focus:outline-none cursor-pointer"
                >
                  <option value="card.moved">📦 Card is moved</option>
                  <option value="card.created">✨ Card is created</option>
                </select>

                {triggerType === 'card.moved' && (
                  <div className="grid grid-cols-2 gap-2 mt-2">
                    <div>
                      <label className="text-[11px] text-board-text-muted block mb-0.5">From column (optional)</label>
                      <select value={fromColumn} onChange={(e) => setFromColumn(e.target.value)}
                        className="w-full text-sm bg-board-bg border border-board-border rounded-md px-2 py-1 text-board-text focus:outline-none">
                        <option value="">Any</option>
                        {columns.map((col) => <option key={col} value={col}>{col}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="text-[11px] text-board-text-muted block mb-0.5">To column (optional)</label>
                      <select value={toColumn} onChange={(e) => setToColumn(e.target.value)}
                        className="w-full text-sm bg-board-bg border border-board-border rounded-md px-2 py-1 text-board-text focus:outline-none">
                        <option value="">Any</option>
                        {columns.map((col) => <option key={col} value={col}>{col}</option>)}
                      </select>
                    </div>
                  </div>
                )}

                {triggerType === 'card.created' && (
                  <div className="mt-2">
                    <label className="text-[11px] text-board-text-muted block mb-0.5">In column (optional)</label>
                    <select value={createdInColumn} onChange={(e) => setCreatedInColumn(e.target.value)}
                      className="w-full text-sm bg-board-bg border border-board-border rounded-md px-2 py-1 text-board-text focus:outline-none">
                      <option value="">Any</option>
                      {columns.map((col) => <option key={col} value={col}>{col}</option>)}
                    </select>
                  </div>
                )}
              </div>

              {/* Action */}
              <div>
                <label className="text-xs font-medium text-board-text-muted uppercase tracking-wider block mb-1">Then</label>
                <select
                  value={actionType}
                  onChange={(e) => setActionType(e.target.value as 'set_field' | 'add_comment' | 'set_due_date')}
                  className="w-full text-sm bg-board-bg border border-board-border rounded-md px-2 py-1.5 text-board-text focus:outline-none cursor-pointer"
                >
                  <option value="add_comment">💬 Add a comment</option>
                  <option value="set_due_date">📅 Set due date</option>
                  {fields.length > 0 && <option value="set_field">🏷️ Set a field value</option>}
                </select>

                {actionType === 'add_comment' && (
                  <div className="mt-2">
                    <textarea
                      value={actionCommentText}
                      onChange={(e) => setActionCommentText(e.target.value)}
                      placeholder="Comment text… (use {{title}}, {{column}}, {{date}} for placeholders)"
                      rows={2}
                      className="w-full text-sm bg-board-bg border border-board-border rounded-md px-3 py-2 text-board-text focus:outline-none resize-none"
                    />
                  </div>
                )}

                {actionType === 'set_due_date' && (
                  <div className="mt-2 flex items-center gap-2">
                    <span className="text-sm text-board-text">Due in</span>
                    <input
                      type="number"
                      min={0}
                      value={actionDaysFromNow}
                      onChange={(e) => setActionDaysFromNow(Number(e.target.value))}
                      className="w-20 text-sm bg-board-bg border border-board-border rounded-md px-2 py-1 text-board-text focus:outline-none"
                    />
                    <span className="text-sm text-board-text">days</span>
                  </div>
                )}

                {actionType === 'set_field' && fields.length > 0 && (
                  <div className="grid grid-cols-2 gap-2 mt-2">
                    <div>
                      <label className="text-[11px] text-board-text-muted block mb-0.5">Field</label>
                      <select value={actionFieldId} onChange={(e) => setActionFieldId(e.target.value)}
                        className="w-full text-sm bg-board-bg border border-board-border rounded-md px-2 py-1 text-board-text focus:outline-none">
                        <option value="">Select field…</option>
                        {fields.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="text-[11px] text-board-text-muted block mb-0.5">Value</label>
                      <input
                        type="text"
                        value={actionFieldValue}
                        onChange={(e) => setActionFieldValue(e.target.value)}
                        placeholder="Value…"
                        className="w-full text-sm bg-board-bg border border-board-border rounded-md px-2 py-1 text-board-text focus:outline-none"
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* Buttons */}
              <div className="flex items-center gap-2 pt-1">
                <button
                  onClick={handleCreate}
                  disabled={creating || !name.trim()}
                  className="px-4 py-1.5 text-xs font-medium text-white rounded-md transition-colors disabled:opacity-50"
                  style={{ backgroundColor: 'var(--board-accent)' }}
                >
                  {creating ? 'Creating…' : 'Create'}
                </button>
                <button
                  onClick={() => setShowCreate(false)}
                  className="px-4 py-1.5 text-xs text-board-text-muted hover:text-board-text transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setShowCreate(true)}
              className="w-full py-2 text-sm font-medium rounded-lg border-2 border-dashed border-board-border text-board-text-muted hover:text-board-text hover:border-board-text-muted transition-colors"
            >
              + New Automation
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
