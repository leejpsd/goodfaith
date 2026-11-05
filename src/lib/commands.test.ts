import { describe, expect, it } from 'vitest';
import { mayUse, parseCommand } from './commands';

describe('parseCommand', () => {
  it('reads each command', () => {
    expect(parseCommand('!vouch')).toEqual({ name: 'vouch' });
    expect(parseCommand('!vouch @new-person')).toEqual({ name: 'vouch', target: 'new-person' });
    expect(parseCommand('!forfeit unrelated generated diff')).toEqual({ name: 'forfeit', reason: 'unrelated generated diff' });
    expect(parseCommand('!appeal I wrote this by hand')).toEqual({ name: 'appeal', reason: 'I wrote this by hand' });
    expect(parseCommand('!release')).toEqual({ name: 'release' });
    expect(parseCommand('!uphold')).toEqual({ name: 'uphold' });
    expect(parseCommand('!reverse my mistake')).toEqual({ name: 'reverse', reason: 'my mistake' });
  });

  it('requires a reason where one is owed', () => {
    expect(parseCommand('!forfeit')).toEqual({ name: 'invalid', command: 'forfeit', problem: 'missing_reason' });
    expect(parseCommand('!appeal   ')).toEqual({ name: 'invalid', command: 'appeal', problem: 'missing_reason' });
  });

  it('rejects a bad vouch target', () => {
    expect(parseCommand('!vouch two words')).toEqual({ name: 'invalid', command: 'vouch', problem: 'bad_target' });
  });

  it('finds a command after ordinary text', () => {
    expect(parseCommand('Thanks for this.\n\n!release')).toEqual({ name: 'release' });
  });

  it('ignores commands in quotes and code fences', () => {
    expect(parseCommand('> !forfeit quoted')).toBeNull();
    expect(parseCommand('```\n!forfeit in a fence\n```')).toBeNull();
    expect(parseCommand('~~~\n!vouch\n~~~\nplain text')).toBeNull();
  });

  it('ignores mentions in a sentence and unknown commands', () => {
    expect(parseCommand('please do not !forfeit this')).toBeNull();
    expect(parseCommand('!waive the deposit')).toBeNull();
    expect(parseCommand('no commands here')).toBeNull();
  });
});

describe('mayUse', () => {
  const stranger = { isMaintainer: false, isHoldOwner: false };
  const owner = { isMaintainer: false, isHoldOwner: true };
  const maintainer = { isMaintainer: true, isHoldOwner: false };

  it('keeps money commands with maintainers', () => {
    expect(mayUse({ name: 'forfeit', reason: 'x' }, maintainer)).toBe(true);
    expect(mayUse({ name: 'forfeit', reason: 'x' }, owner)).toBe(false);
    expect(mayUse({ name: 'vouch' }, stranger)).toBe(false);
    expect(mayUse({ name: 'release' }, owner)).toBe(false);
  });

  it('keeps appeals with the hold owner', () => {
    expect(mayUse({ name: 'appeal', reason: 'x' }, owner)).toBe(true);
    expect(mayUse({ name: 'appeal', reason: 'x' }, stranger)).toBe(false);
  });
});
