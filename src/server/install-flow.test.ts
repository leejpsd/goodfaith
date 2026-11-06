import { describe, expect, it } from 'vitest';
import { checkInstall } from './install-flow';

const lookup = (files: { private?: boolean; settings?: string | null; vouch?: string | null; installed?: boolean }) => ({
  installationFor: async () => (files.installed === false ? null : 7),
  githubFor: () => ({
    isPrivate: async () => files.private ?? false,
    settingsFile: async () => files.settings ?? null,
    vouchFile: async () => files.vouch ?? null,
  }),
});

describe('checking an install', () => {
  it('reads the settings and the vouch list the gate will read', async () => {
    const result = await checkInstall('o', 'r', lookup({ settings: '{"min_cents":300,"default_cents":400,"max_cents":900}', vouch: 'github:someone\n-github:spammer\n' }));
    expect(result).toMatchObject({ installed: true, settings: { found: true, problems: [], applied: { minCents: 300, defaultCents: 400, maxCents: 900 } }, vouchList: { found: true, vouched: 1, denounced: 1 } });
  });

  it('says why a settings file would be ignored', async () => {
    const result = await checkInstall('o', 'r', lookup({ settings: '{"max_cents":999999}' }));
    expect('settings' in result && result.settings.problems.join(' ')).toContain('at most 10000');
  });

  it('answers for a private repository exactly as for one without the app', async () => {
    const hidden = await checkInstall('o', 'secret', lookup({ private: true, settings: '{"payout_receiver":"owner@example.com"}' }));
    const absent = await checkInstall('o', 'none', lookup({ installed: false }));
    expect(hidden).toEqual(absent);
    expect(JSON.stringify(hidden)).not.toContain('owner@example.com');
  });
});
