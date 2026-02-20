import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BoardSettingsModal } from '../components/BoardSettings';
import type { PriorityDef, CategoryDef } from '../types';

const twoPriorities: PriorityDef[] = [
  { id: 'high', label: 'High', emoji: '🔴', color: '#ef4444' },
  { id: 'low', label: 'Low', emoji: '🟢', color: '#22c55e' },
];

const twoCategories: CategoryDef[] = [
  { id: 'bug', label: 'Bug', color: '#ef4444', showOnCard: true },
  { id: 'feature', label: 'Feature', color: '#3b82f6', showOnCard: false },
];

function defaults(overrides: Partial<Parameters<typeof BoardSettingsModal>[0]> = {}) {
  return {
    open: true,
    boardName: 'My Board',
    columns: ['Backlog', 'In Progress', 'Done'],
    priorities: twoPriorities,
    categories: [] as CategoryDef[],
    onClose: vi.fn(),
    onSavePriorities: vi.fn().mockResolvedValue(undefined),
    onSaveCategories: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ── Render ──────────────────────────────────────────────────────────

describe('render', () => {
  it('returns null when open=false', () => {
    const { container } = render(<BoardSettingsModal {...defaults({ open: false })} />);
    expect(container.innerHTML).toBe('');
  });

  it('shows board name header', () => {
    render(<BoardSettingsModal {...defaults()} />);
    expect(screen.getByText('My Board \u00B7 Board settings')).toBeInTheDocument();
  });

  it('displays column badges', () => {
    render(<BoardSettingsModal {...defaults()} />);
    expect(screen.getByText('Backlog')).toBeInTheDocument();
    expect(screen.getByText('In Progress')).toBeInTheDocument();
    expect(screen.getByText('Done')).toBeInTheDocument();
  });

  it('renders priority rows with inputs', () => {
    render(<BoardSettingsModal {...defaults()} />);
    const labels = screen.getAllByPlaceholderText('Priority label');
    expect(labels).toHaveLength(2);
    expect(labels[0]).toHaveValue('High');
    expect(labels[1]).toHaveValue('Low');
  });

  it('shows empty state when no priorities', () => {
    render(<BoardSettingsModal {...defaults({ priorities: [] })} />);
    expect(screen.getByText(/No priorities configured/)).toBeInTheDocument();
  });
});

// ── Add ─────────────────────────────────────────────────────────────

describe('add priority', () => {
  it('appends a row with defaults', async () => {
    const user = userEvent.setup();
    render(<BoardSettingsModal {...defaults({ priorities: [] })} />);
    await user.click(screen.getByText('+ Add priority'));
    expect(screen.getByPlaceholderText('Priority label')).toHaveValue('New priority');
  });

  it('second add generates unique ID', async () => {
    const user = userEvent.setup();
    render(<BoardSettingsModal {...defaults({ priorities: [] })} />);
    await user.click(screen.getByText('+ Add priority'));
    await user.click(screen.getByText('+ Add priority'));
    const labels = screen.getAllByPlaceholderText('Priority label');
    expect(labels).toHaveLength(2);
    // both should exist (unique IDs prevent key collision)
    expect(screen.getByText('new-priority')).toBeInTheDocument();
    expect(screen.getByText('new-priority-2')).toBeInTheDocument();
  });
});

// ── Edit ────────────────────────────────────────────────────────────

describe('edit priority', () => {
  it('typing in label input updates value', async () => {
    const user = userEvent.setup();
    render(<BoardSettingsModal {...defaults()} />);
    const label = screen.getAllByPlaceholderText('Priority label')[0];
    await user.clear(label);
    await user.type(label, 'Critical');
    expect(label).toHaveValue('Critical');
  });

  it('typing in emoji input updates value', async () => {
    const user = userEvent.setup();
    render(<BoardSettingsModal {...defaults()} />);
    const emoji = screen.getAllByPlaceholderText('🔺')[0];
    await user.clear(emoji);
    await user.type(emoji, '🚨');
    expect(emoji).toHaveValue('🚨');
  });

  it('typing in color input updates value', async () => {
    const user = userEvent.setup();
    render(<BoardSettingsModal {...defaults()} />);
    const color = screen.getAllByPlaceholderText('#ef4444')[0];
    await user.clear(color);
    await user.type(color, '#abc');
    expect(color).toHaveValue('#abc');
  });
});

// ── Delete ──────────────────────────────────────────────────────────

describe('delete priority', () => {
  it('removes a row', async () => {
    const user = userEvent.setup();
    render(<BoardSettingsModal {...defaults()} />);
    const deleteButtons = screen.getAllByTitle('Delete priority');
    await user.click(deleteButtons[0]);
    expect(screen.getAllByPlaceholderText('Priority label')).toHaveLength(1);
  });

  it('removing all shows empty state', async () => {
    const user = userEvent.setup();
    render(<BoardSettingsModal {...defaults()} />);
    const deleteButtons = screen.getAllByTitle('Delete priority');
    await user.click(deleteButtons[0]);
    await user.click(screen.getByTitle('Delete priority'));
    expect(screen.getByText(/No priorities configured/)).toBeInTheDocument();
  });
});

// ── Reorder ─────────────────────────────────────────────────────────

describe('reorder', () => {
  it('up disabled on first row', () => {
    render(<BoardSettingsModal {...defaults()} />);
    const upButtons = screen.getAllByTitle('Move up');
    expect(upButtons[0]).toBeDisabled();
  });

  it('down disabled on last row', () => {
    render(<BoardSettingsModal {...defaults()} />);
    const downButtons = screen.getAllByTitle('Move down');
    expect(downButtons[downButtons.length - 1]).toBeDisabled();
  });

  it('down on first swaps with second', async () => {
    const user = userEvent.setup();
    render(<BoardSettingsModal {...defaults()} />);
    const downButtons = screen.getAllByTitle('Move down');
    await user.click(downButtons[0]);
    const labels = screen.getAllByPlaceholderText('Priority label');
    expect(labels[0]).toHaveValue('Low');
    expect(labels[1]).toHaveValue('High');
  });
});

// ── Save validation ─────────────────────────────────────────────────

describe('save validation', () => {
  it('empty label shows error', async () => {
    const user = userEvent.setup();
    const onSavePriorities = vi.fn();
    render(<BoardSettingsModal {...defaults({ onSavePriorities })} />);
    const label = screen.getAllByPlaceholderText('Priority label')[0];
    await user.clear(label);
    await user.click(screen.getByText('Save settings'));
    expect(screen.getByText('Priority label cannot be empty.')).toBeInTheDocument();
    expect(onSavePriorities).not.toHaveBeenCalled();
  });

  it('empty emoji shows error', async () => {
    const user = userEvent.setup();
    const onSavePriorities = vi.fn();
    render(<BoardSettingsModal {...defaults({ onSavePriorities })} />);
    const emoji = screen.getAllByPlaceholderText('🔺')[0];
    await user.clear(emoji);
    await user.click(screen.getByText('Save settings'));
    expect(screen.getByText('Priority emoji cannot be empty.')).toBeInTheDocument();
    expect(onSavePriorities).not.toHaveBeenCalled();
  });
});

// ── Save success ────────────────────────────────────────────────────

describe('save success', () => {
  it('calls onSavePriorities with cleaned data', async () => {
    const user = userEvent.setup();
    const onSavePriorities = vi.fn().mockResolvedValue(undefined);
    render(<BoardSettingsModal {...defaults({ onSavePriorities })} />);
    // Change a label to trigger dirty state
    const label = screen.getAllByPlaceholderText('Priority label')[0];
    await user.clear(label);
    await user.type(label, 'Critical');
    await user.click(screen.getByText('Save settings'));
    expect(onSavePriorities).toHaveBeenCalledOnce();
    const saved = onSavePriorities.mock.calls[0][0];
    expect(saved[0].label).toBe('Critical');
    expect(saved[0].color).toBe('#ef4444');
  });

  it('button shows Saving... while saving', async () => {
    const user = userEvent.setup();
    let resolveSave!: () => void;
    const onSavePriorities = vi.fn(
      () => new Promise<void>((r) => { resolveSave = r; }),
    );
    render(<BoardSettingsModal {...defaults({ onSavePriorities })} />);
    // Change to trigger dirty
    const label = screen.getAllByPlaceholderText('Priority label')[0];
    await user.clear(label);
    await user.type(label, 'X');
    await user.click(screen.getByText('Save settings'));
    expect(screen.getByText('Saving...')).toBeInTheDocument();
    resolveSave();
  });
});

// ── Save error ──────────────────────────────────────────────────────

describe('save error', () => {
  it('rejected onSavePriorities shows error', async () => {
    const user = userEvent.setup();
    const onSavePriorities = vi.fn().mockRejectedValue('Server error');
    render(<BoardSettingsModal {...defaults({ onSavePriorities })} />);
    // Change to trigger dirty
    const label = screen.getAllByPlaceholderText('Priority label')[0];
    await user.clear(label);
    await user.type(label, 'X');
    await user.click(screen.getByText('Save settings'));
    expect(await screen.findByText('Server error')).toBeInTheDocument();
  });
});

// ── Close ───────────────────────────────────────────────────────────

describe('close', () => {
  it('close button calls onClose', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<BoardSettingsModal {...defaults({ onClose })} />);
    await user.click(screen.getByLabelText('Close settings'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('Cancel button calls onClose', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<BoardSettingsModal {...defaults({ onClose })} />);
    await user.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

// ── Color normalization ─────────────────────────────────────────────

describe('color normalization', () => {
  it('#abc normalizes to #aabbcc in saved output', async () => {
    const user = userEvent.setup();
    const onSavePriorities = vi.fn().mockResolvedValue(undefined);
    render(<BoardSettingsModal {...defaults({ onSavePriorities })} />);
    const color = screen.getAllByPlaceholderText('#ef4444')[0];
    await user.clear(color);
    await user.type(color, '#abc');
    await user.click(screen.getByText('Save settings'));
    const saved = onSavePriorities.mock.calls[0][0];
    expect(saved[0].color).toBe('#aabbcc');
  });

  it('invalid color falls back to #6b7280', async () => {
    const user = userEvent.setup();
    const onSavePriorities = vi.fn().mockResolvedValue(undefined);
    render(<BoardSettingsModal {...defaults({ onSavePriorities })} />);
    const color = screen.getAllByPlaceholderText('#ef4444')[0];
    await user.clear(color);
    await user.type(color, 'nope');
    await user.click(screen.getByText('Save settings'));
    const saved = onSavePriorities.mock.calls[0][0];
    expect(saved[0].color).toBe('#6b7280');
  });
});

// ── Categories section ──────────────────────────────────────────────

describe('categories section', () => {
  it('shows empty state when no categories', () => {
    render(<BoardSettingsModal {...defaults()} />);
    expect(screen.getByText(/No categories defined/)).toBeInTheDocument();
  });

  it('renders category rows when provided', () => {
    render(<BoardSettingsModal {...defaults({ categories: twoCategories })} />);
    const labels = screen.getAllByPlaceholderText('Category label');
    expect(labels).toHaveLength(2);
    expect(labels[0]).toHaveValue('Bug');
    expect(labels[1]).toHaveValue('Feature');
  });

  it('add category appends a row', async () => {
    const user = userEvent.setup();
    render(<BoardSettingsModal {...defaults()} />);
    await user.click(screen.getByText('+ Add category'));
    expect(screen.getByPlaceholderText('Category label')).toHaveValue('New category');
  });

  it('delete category removes a row', async () => {
    const user = userEvent.setup();
    render(<BoardSettingsModal {...defaults({ categories: twoCategories })} />);
    const deleteButtons = screen.getAllByTitle('Delete category');
    await user.click(deleteButtons[0]);
    expect(screen.getAllByPlaceholderText('Category label')).toHaveLength(1);
  });

  it('showOnCard checkbox toggles', async () => {
    const user = userEvent.setup();
    render(<BoardSettingsModal {...defaults({ categories: twoCategories })} />);
    const checkboxes = screen.getAllByRole('checkbox');
    // First category has showOnCard=true
    expect(checkboxes[0]).toBeChecked();
    // Second has showOnCard=false
    expect(checkboxes[1]).not.toBeChecked();
    await user.click(checkboxes[1]);
    expect(checkboxes[1]).toBeChecked();
  });

  it('saving categories calls onSaveCategories', async () => {
    const user = userEvent.setup();
    const onSaveCategories = vi.fn().mockResolvedValue(undefined);
    render(<BoardSettingsModal {...defaults({ categories: twoCategories, onSaveCategories })} />);
    // Toggle showOnCard on second category to trigger dirty
    const checkboxes = screen.getAllByRole('checkbox');
    await user.click(checkboxes[1]);
    await user.click(screen.getByText('Save settings'));
    expect(onSaveCategories).toHaveBeenCalledOnce();
    const saved = onSaveCategories.mock.calls[0][0] as CategoryDef[];
    expect(saved).toHaveLength(2);
    expect(saved[1].showOnCard).toBe(true);
  });

  it('empty category label shows error', async () => {
    const user = userEvent.setup();
    render(<BoardSettingsModal {...defaults({ categories: twoCategories })} />);
    const label = screen.getAllByPlaceholderText('Category label')[0];
    await user.clear(label);
    await user.click(screen.getByText('Save settings'));
    expect(screen.getByText('Category label cannot be empty.')).toBeInTheDocument();
  });

  it('reorder categories with move buttons', async () => {
    const user = userEvent.setup();
    render(<BoardSettingsModal {...defaults({ categories: twoCategories })} />);
    // Move first category down
    const downButtons = screen.getAllByTitle('Move down');
    // There are down buttons for priorities and categories.
    // The last two are for categories (since priorities have 2 down buttons too).
    // Actually priorities have 2 rows and categories have 2 rows, so 4 total down buttons.
    // Priorities: buttons at 0,1. Categories: buttons at 2,3.
    await user.click(downButtons[2]);
    const labels = screen.getAllByPlaceholderText('Category label');
    expect(labels[0]).toHaveValue('Feature');
    expect(labels[1]).toHaveValue('Bug');
  });
});
