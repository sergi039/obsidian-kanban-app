import { useState } from 'react';
import type { Card } from '../types';

interface Props {
  cards: Card[];
  onCardClick: (card: Card) => void;
}

type SortField = 'title' | 'column_name' | 'priority' | 'due_date' | 'is_done' | 'updated_at';
type SortDir = 'ASC' | 'DESC';

const PRIORITY_ORDER: Record<string, number> = { urgent: 0, high: 1 };

function comparePriority(a: string | null, b: string | null): number {
  const av = a ? (PRIORITY_ORDER[a] ?? 2) : 3;
  const bv = b ? (PRIORITY_ORDER[b] ?? 2) : 3;
  return av - bv;
}

export function TableView({ cards, onCardClick }: Props) {
  const [sortField, setSortField] = useState<SortField>('title');
  const [sortDir, setSortDir] = useState<SortDir>('ASC');

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === 'ASC' ? 'DESC' : 'ASC'));
    } else {
      setSortField(field);
      setSortDir('ASC');
    }
  };

  const sorted = [...cards].sort((a, b) => {
    let cmp = 0;
    switch (sortField) {
      case 'title':
        cmp = a.title.localeCompare(b.title);
        break;
      case 'column_name':
        cmp = a.column_name.localeCompare(b.column_name);
        break;
      case 'priority':
        cmp = comparePriority(a.priority, b.priority);
        break;
      case 'due_date':
        cmp = (a.due_date || '9999').localeCompare(b.due_date || '9999');
        break;
      case 'is_done':
        cmp = Number(a.is_done) - Number(b.is_done);
        break;
      case 'updated_at':
        cmp = a.updated_at.localeCompare(b.updated_at);
        break;
    }
    return sortDir === 'DESC' ? -cmp : cmp;
  });

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return <span className="text-board-text-muted/30 ml-0.5">↕</span>;
    return <span className="ml-0.5">{sortDir === 'ASC' ? '↑' : '↓'}</span>;
  };

  const priorityBadge = (p: string | null) => {
    if (!p) return <span className="text-board-text-muted text-xs">—</span>;
    if (p === 'urgent') return <span className="text-red-500 text-xs font-medium">🔺 Urgent</span>;
    return <span className="text-orange-500 text-xs font-medium">⏫ High</span>;
  };

  const statusBadge = (col: string) => {
    const colors: Record<string, string> = {
      Backlog: 'bg-gray-400',
      'In Progress': 'bg-blue-500',
      Blocked: 'bg-red-500',
      Done: 'bg-green-500',
      Review: 'bg-purple-500',
    };
    return (
      <span className="flex items-center gap-1.5 text-xs">
        <span className={`w-2 h-2 rounded-full ${colors[col] || 'bg-gray-400'}`} />
        {col}
      </span>
    );
  };

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-board-border text-left">
            {[
              { field: 'title' as SortField, label: 'Title', width: '' },
              { field: 'column_name' as SortField, label: 'Status', width: 'w-32' },
              { field: 'priority' as SortField, label: 'Priority', width: 'w-28' },
              { field: 'due_date' as SortField, label: 'Due', width: 'w-28' },
              { field: 'is_done' as SortField, label: 'Done', width: 'w-16' },
              { field: 'updated_at' as SortField, label: 'Updated', width: 'w-32' },
            ].map((col) => (
              <th
                key={col.field}
                className={`px-3 py-2 text-xs font-medium text-board-text-muted uppercase tracking-wider cursor-pointer hover:text-board-text transition-colors select-none ${col.width}`}
                onClick={() => handleSort(col.field)}
              >
                <span className="flex items-center">
                  {col.label}
                  <SortIcon field={col.field} />
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((card) => (
            <tr
              key={card.id}
              onClick={() => onCardClick(card)}
              className="border-b border-board-border/50 hover:bg-board-column cursor-pointer transition-colors"
            >
              <td className="px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <span className={`text-board-text ${card.is_done ? 'line-through opacity-60' : ''}`}>
                    {card.title.length > 80 ? card.title.slice(0, 80) + '…' : card.title}
                  </span>
                  {card.labels.length > 0 && (
                    <span className="flex gap-1">
                      {card.labels.slice(0, 3).map((l, i) => (
                        <span key={i} className="text-[10px] px-1.5 py-0.5 rounded-full bg-board-column text-board-text-muted border border-board-border">
                          {l}
                        </span>
                      ))}
                    </span>
                  )}
                  {card.description && <span className="text-board-text-muted text-[10px]">📝</span>}
                </div>
              </td>
              <td className="px-3 py-2.5">{statusBadge(card.column_name)}</td>
              <td className="px-3 py-2.5">{priorityBadge(card.priority)}</td>
              <td className="px-3 py-2.5 text-xs text-board-text-muted">
                {card.due_date || '—'}
              </td>
              <td className="px-3 py-2.5 text-center">
                {card.is_done ? '✓' : ''}
              </td>
              <td className="px-3 py-2.5 text-xs text-board-text-muted">
                {new Date(card.updated_at).toLocaleDateString()}
              </td>
            </tr>
          ))}
          {sorted.length === 0 && (
            <tr>
              <td colSpan={6} className="px-3 py-8 text-center text-board-text-muted text-sm">
                No cards match the current filter
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
