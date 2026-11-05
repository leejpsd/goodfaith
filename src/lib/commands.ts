// Comment commands. `!vouch` matches the vouch project's command. Only the first command
// in a comment counts, and text inside code fences or quotes is never a command, so a
// pull request cannot smuggle one in through quoted text.
export type Command =
  | { name: 'vouch'; target?: string }
  | { name: 'unvouch'; target?: string }
  | { name: 'forfeit'; reason: string }
  | { name: 'appeal'; reason: string }
  | { name: 'release' }
  | { name: 'uphold' }
  | { name: 'reverse'; reason: string };

export type ParseResult = Command | { name: 'invalid'; command: string; problem: 'missing_reason' | 'bad_target' } | null;

const HANDLE = /^@?([a-z\d](?:[a-z\d-]{0,38}))$/i;

export function parseCommand(body: string): ParseResult {
  let fenced = false;
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('```') || line.startsWith('~~~')) {
      fenced = !fenced;
      continue;
    }
    if (fenced || line.startsWith('>') || !line.startsWith('!')) continue;
    const match = line.match(/^!([a-z]+)(?:\s+(.*))?$/i);
    if (!match) continue;
    const name = (match[1] ?? '').toLowerCase();
    const rest = (match[2] ?? '').trim();
    switch (name) {
      case 'vouch':
      case 'unvouch': {
        if (!rest) return { name };
        const handle = rest.match(HANDLE);
        return handle ? { name, target: handle[1] } : { name: 'invalid', command: name, problem: 'bad_target' };
      }
      case 'forfeit':
      case 'appeal':
      case 'reverse':
        return rest ? { name, reason: rest } : { name: 'invalid', command: name, problem: 'missing_reason' };
      case 'release':
      case 'uphold':
        return { name };
      default:
        continue;
    }
  }
  return null;
}

// Who may use a command. Being a maintainer means write access, which the caller checks
// through GitHub's permission endpoint. `author_association` alone is not enough.
export function mayUse(command: Command, actor: { isMaintainer: boolean; isHoldOwner: boolean }): boolean {
  return command.name === 'appeal' ? actor.isHoldOwner : actor.isMaintainer;
}
