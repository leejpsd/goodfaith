import { describe, expect, it } from 'vitest';
import { listStatus, parseVouchList } from './vouch';

const SAMPLE = `# The list of vouched users.
#
alice
github:Bob   joined through a discussion
-mallory
-github:eve spam
gitlab:carol
-gitlab:dave

  frank
`;

describe('parseVouchList', () => {
  const list = parseVouchList(SAMPLE);

  it('reads vouches, denouncements, prefixes and comments', () => {
    expect(listStatus(list, 'alice')).toBe('vouched');
    expect(listStatus(list, 'bob')).toBe('vouched');
    expect(listStatus(list, 'mallory')).toBe('denounced');
    expect(listStatus(list, 'eve')).toBe('denounced');
    expect(listStatus(list, 'frank')).toBe('vouched');
  });

  it('ignores other platforms', () => {
    expect(listStatus(list, 'carol')).toBe('unknown');
    expect(listStatus(list, 'dave')).toBe('unknown');
  });

  it('ignores case, since GitHub handles do', () => {
    expect(listStatus(list, 'ALICE')).toBe('vouched');
  });

  it('lets a denouncement win in either order', () => {
    expect(listStatus(parseVouchList('sam\n-sam'), 'sam')).toBe('denounced');
    expect(listStatus(parseVouchList('-sam\nsam'), 'sam')).toBe('denounced');
  });

  it('treats an empty list as unknown', () => {
    expect(listStatus(parseVouchList(''), 'anyone')).toBe('unknown');
  });
});
