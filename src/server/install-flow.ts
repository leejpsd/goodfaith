import { githubFor, installationFor, type GitHub } from '@/lib/github/client';
import { checkSettings, DEFAULT_SETTINGS, type ProjectSettings } from '@/lib/github/config';
import { parseVouchList } from '@/lib/vouch';

export interface InstallCheck {
  installed: boolean;
  settings: { found: boolean; problems: string[]; applied: ProjectSettings };
  vouchList: { found: boolean; vouched: number; denounced: number };
}

// Each check costs a few GitHub requests, so the page has a daily ceiling.
const DAILY_LIMIT = 300;
let day = '';
let used = 0;

// Reads what the gate will read when a stranger opens a pull request, and says what it finds.
export async function checkInstall(
  owner: string,
  repo: string,
  lookup: { installationFor: (owner: string, repo: string) => Promise<number | null>; githubFor: (installationId: number) => Pick<GitHub, 'isPrivate' | 'settingsFile' | 'vouchFile'> } = { installationFor, githubFor },
): Promise<InstallCheck | { refused: 'limit' }> {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== day) {
    day = today;
    used = 0;
  }
  if (++used > DAILY_LIMIT) return { refused: 'limit' };

  const notInstalled: InstallCheck = { installed: false, settings: { found: false, problems: [], applied: DEFAULT_SETTINGS }, vouchList: { found: false, vouched: 0, denounced: 0 } };
  const installationId = await lookup.installationFor(owner, repo);
  if (!installationId) return notInstalled;
  const github = lookup.githubFor(installationId);
  // Anyone can ask, so a private repository answers exactly as one without the app, and shows
  // neither the install nor its settings.
  if (await github.isPrivate(owner, repo)) return notInstalled;
  const [settingsText, vouchText] = await Promise.all([github.settingsFile(owner, repo), github.vouchFile(owner, repo)]);
  const checked = settingsText === null ? { settings: DEFAULT_SETTINGS, problems: [] } : checkSettings(settingsText);
  const entries = [...parseVouchList(vouchText ?? '').values()];
  return {
    installed: true,
    settings: { found: settingsText !== null, problems: checked.problems, applied: checked.settings },
    vouchList: { found: vouchText !== null, vouched: entries.filter((e) => e === 'vouched').length, denounced: entries.filter((e) => e === 'denounced').length },
  };
}
