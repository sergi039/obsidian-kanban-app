import type { AppConfig } from './config.js';

/**
 * Kanban card links (`<publicUrl>/?board=<board>&card=<id>`) quoted in free text —
 * calendar event bodies, Obsidian notes. Only the public host and loopback count, so a
 * look-alike URL on another host never links anything.
 */

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);

export interface CardLinkRef {
  board: string | null;
  card: string;
}

export function decodeEntities(text: string): string {
  return text.replace(/&amp;/gi, '&').replace(/&#0?38;/g, '&');
}

/** Card ids referenced from text through a Kanban card link on a trusted host. */
export function cardLinksInText(text: string, trustedHosts: Set<string>): CardLinkRef[] {
  const refs: CardLinkRef[] = [];
  // `)` and `]` end the URL: board and card ids never contain them, a Markdown link `[x](url)` does.
  for (const match of decodeEntities(text).matchAll(/https?:\/\/[^\s"'<>)\]]+/g)) {
    let url: URL;
    try {
      url = new URL(match[0]);
    } catch {
      continue;
    }
    if (!trustedHosts.has(url.host.toLowerCase()) && !LOCAL_HOSTS.has(url.hostname.toLowerCase())) continue;
    const card = url.searchParams.get('card');
    if (card) refs.push({ board: url.searchParams.get('board'), card });
  }
  return refs;
}

export function trustedHostsFor(config: Pick<AppConfig, 'publicUrl'>): Set<string> {
  const hosts = new Set<string>();
  if (config.publicUrl) hosts.add(new URL(config.publicUrl).host.toLowerCase());
  return hosts;
}

/** The card's deep link on the public address; same shape as the web's `cardDeepLink`. */
export function cardUrl(publicUrl: string, boardId: string, cardId: string): string {
  const query = new URLSearchParams([['board', boardId], ['card', cardId]]);
  return `${publicUrl.replace(/\/+$/, '')}/?${query.toString()}`;
}
