// Reads the list format used by mitchellh/vouch (.github/VOUCHED.td), so a project
// already running vouch keeps its list. One handle per line, an optional `platform:`
// prefix, `-` to denounce, and anything after a space is a comment.
export type ListStatus = 'vouched' | 'denounced' | 'unknown';

export function parseVouchList(text: string, platform = 'github'): Map<string, 'vouched' | 'denounced'> {
  const entries = new Map<string, 'vouched' | 'denounced'>();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const token = line.split(/\s+/)[0] ?? '';
    const denounced = token.startsWith('-');
    const body = denounced ? token.slice(1) : token;
    const colon = body.indexOf(':');
    if (colon !== -1 && body.slice(0, colon).toLowerCase() !== platform) continue;
    const handle = (colon === -1 ? body : body.slice(colon + 1)).replace(/^@/, '').toLowerCase();
    if (!handle) continue;
    // A denouncement wins over a vouch for the same handle, whatever the order.
    if (entries.get(handle) === 'denounced') continue;
    entries.set(handle, denounced ? 'denounced' : 'vouched');
  }
  return entries;
}

export function listStatus(entries: Map<string, 'vouched' | 'denounced'>, handle: string): ListStatus {
  return entries.get(handle.toLowerCase()) ?? 'unknown';
}
