import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BoardSettingsModal } from '../components/BoardSettings';
import type { PriorityDef } from '../types';

const twoPriorities: PriorityDef[] = [
  { id: 'high', label: 'High', emoji: '🔴', color: '#ef4444' },
  { id: 'low', label: 'Low', emoji: '🟢', color: '#22c55e' },
];

function defaults(overrides: Partial<Parameters<typeof BoardSettingsModal>[0]> = {}) {
  return {
    open: true,
    boardName: 'My Board',
    columns: ['Backlog', 'In Progress', 'Done'],
    priorities: twoPriorities,
    onClose: vi.fn(),
    onSave: vi.fn<[PriorityDef[]], Promise<void>>().mockResolvedValue(undefined),
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
    expect(screen.getByText('My Board · Board settings')).toBeInTheDocument();
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
    const onSave = vi.fn();
    render(<BoardSettingsModal {...defaults({ onSave })} />);
    const label = screen.getAllByPlaceholderText('Priority label')[0];
    await user.clear(label);
    await user.click(screen.getByText('Save priorities'));
    expect(screen.getByText('Priority label cannot be empty.')).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('empty emoji shows error', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<BoardSettingsModal {...defaults({ onSave })} />);
    const emoji = screen.getAllByPlaceholderText('🔺')[0];
    await user.clear(emoji);
    await user.click(screen.getByText('Save priorities'));
    expect(screen.getByText('Priority emoji cannot be empty.')).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });
});

// ── Save success ────────────────────────────────────────────────────

describe('save success', () => {
  it('calls onSave with cleaned data', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn<[PriorityDef[]], Promise<void>>().mockResolvedValue(undefined);
    render(<BoardSettingsModal {...defaults({ onSave })} />);
    await user.click(screen.getByText('Save priorities'));
    expect(onSave).toHaveBeenCalledOnce();
    const saved = onSave.mock.calls[0][0];
    expect(saved[0].label).toBe('High');
    expect(saved[0].color).toBe('#ef4444');
  });

  it('button shows Saving... while saving', async () => {
    const user = userEvent.setup();
    let resolveSave!: () => void;
    const onSave = vi.fn<[PriorityDef[]], Promise<void>>(
      () => new Promise((r) => { resolveSave = r; }),
    );
    render(<BoardSettingsModal {...defaults({ onSave })} />);
    await user.click(screen.getByText('Save priorities'));
    expect(screen.getByText('Saving\u2026')).toBeInTheDocument();
    resolveSave();
  });
});

// ── Save error ──────────────────────────────────────────────────────

describe('save error', () => {
  it('rejected onSave shows error', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn<[PriorityDef[]], Promise<void>>().mockRejectedValue('Server error');
    render(<BoardSettingsModal {...defaults({ onSave })} />);
    await user.click(screen.getByText('Save priorities'));
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
    const onSave = vi.fn<[PriorityDef[]], Promise<void>>().mockResolvedValue(undefined);
    render(<BoardSettingsModal {...defaults({ onSave })} />);
    const color = screen.getAllByPlaceholderText('#ef4444')[0];
    await user.clear(color);
    await user.type(color, '#abc');
    await user.click(screen.getByText('Save priorities'));
    const saved = onSave.mock.calls[0][0];
    expect(saved[0].color).toBe('#aabbcc');
  });

  it('invalid color falls back to #6b7280', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn<[PriorityDef[]], Promise<void>>().mockResolvedValue(undefined);
    render(<BoardSettingsModal {...defaults({ onSave })} />);
    const color = screen.getAllByPlaceholderText('#ef4444')[0];
    await user.clear(color);
    await user.type(color, 'nope');
    await user.click(screen.getByText('Save priorities'));
    const saved = onSave.mock.calls[0][0];
    expect(saved[0].color).toBe('#6b7280');
  });
});
