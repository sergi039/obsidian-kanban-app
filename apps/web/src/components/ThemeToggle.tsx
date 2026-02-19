interface Props {
  theme: 'light' | 'dark' | 'system';
  onCycle: () => void;
}

const ICONS: Record<string, string> = {
  system: '💻',
  light: '☀️',
  dark: '🌙',
};

const LABELS: Record<string, string> = {
  system: 'System theme',
  light: 'Light theme',
  dark: 'Dark theme',
};

export function ThemeToggle({ theme, onCycle }: Props) {
  return (
    <button
      onClick={onCycle}
      aria-label={LABELS[theme]}
      title={`${LABELS[theme]} — click to cycle`}
      className="px-2 h-8 text-sm bg-board-column hover:bg-board-card border border-board-border rounded-md transition-colors"
    >
      {ICONS[theme]}
    </button>
  );
}
