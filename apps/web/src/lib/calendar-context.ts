import { createContext, useContext } from 'react';
import type { CalendarAccount } from '../types';

export interface CalendarSettings {
  accounts: CalendarAccount[];
  /** The active board's default account id; null when the board has none. */
  defaultAccountId: string | null;
}

export const NO_CALENDAR_SETTINGS: CalendarSettings = { accounts: [], defaultAccountId: null };

/** Provided by App from the board detail so cards, the drag overlay and the detail modal resolve accounts alike. */
export const CalendarSettingsContext = createContext<CalendarSettings>(NO_CALENDAR_SETTINGS);

export function useCalendarSettings(): CalendarSettings {
  return useContext(CalendarSettingsContext);
}
