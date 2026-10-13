import { Icon, type IconName } from './Icon';

interface Props {
  theme: 'light' | 'dark' | 'system';
  onCycle: () => void;
}

const ICONS: Record<Props['theme'], IconName> = {
  system: 'monitor',
  light: 'sun',
  dark: 'moon',
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
      className="px-2 h-8 inline-flex items-center bg-board-column hover:bg-board-card border border-board-border rounded-md text-board-text-muted hover:text-board-text transition-colors"
    >
      <Icon name={ICONS[theme]} size={16} />
    </button>
  );
}
