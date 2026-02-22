export const MD_LINK_RE = /\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g;
export const BARE_URL_RE = /https?:\/\/[^\s)\]<]+/g;

export function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

export function safeHostname(raw: string): string {
  try { return new URL(normalizeUrl(raw)).hostname; } catch { return raw; }
}

export function extractLinks(text: string): { text: string; url: string }[] {
  const links: { text: string; url: string }[] = [];
  const seen = new Set<string>();
  const mdRe = new RegExp(MD_LINK_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = mdRe.exec(text)) !== null) {
    if (!seen.has(m[2])) { links.push({ text: m[1] || m[2], url: m[2] }); seen.add(m[2]); }
  }
  const bareRe = new RegExp(BARE_URL_RE.source, 'g');
  while ((m = bareRe.exec(text)) !== null) {
    if (!seen.has(m[0])) { links.push({ text: safeHostname(m[0]), url: m[0] }); seen.add(m[0]); }
  }
  return links;
}

export type TextSegment = string | { url: string; text: string };

export function linkifyText(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  // Combine markdown links and bare URLs into a single pass
  const combinedRe = /\[([^\]]*)\]\((https?:\/\/[^)]+)\)|https?:\/\/[^\s)\]<]+/g;
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = combinedRe.exec(text)) !== null) {
    if (m.index > lastIndex) {
      segments.push(text.slice(lastIndex, m.index));
    }
    if (m[2]) {
      // Markdown link [text](url)
      segments.push({ url: m[2], text: m[1] || m[2] });
    } else {
      // Bare URL
      segments.push({ url: m[0], text: m[0] });
    }
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < text.length) {
    segments.push(text.slice(lastIndex));
  }
  return segments;
}
