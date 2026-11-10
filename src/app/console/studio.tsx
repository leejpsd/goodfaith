'use client';

import { AgStudio, AgStudioProvider, createWidgets } from 'ag-studio-react';
import { AgStudioAiModule, AgStudioLicenseManager, createAiHarness, directLlmRunner, studioTheme, type AgAiHarnessSetup, type AgAiPromptStarter, type AgDataSourcesDefinition, type AgReportState, type AgStudioApi, type AgStudioMode } from 'ag-studio';
import { useEffect, useMemo, useRef, useState } from 'react';
import { consoleAdapter } from '@/lib/console/adapter';
import { LEAD_INSTRUCTIONS } from '@/lib/console/agents';
import { HOLD_RULES, type ConsoleData } from '@/lib/console/data';
import { CLOSED_DOORS, EVIDENCE_LABELS, EVIDENCE_ROWS, EVIDENCE_SCORES, MISS_FIELDS } from '@/lib/console/misses';
import { HoldTimeline, TIMELINE_FIELDS } from './hold-timeline';
import { MissMatrix } from './miss-matrix';
import { NeedsAnswer, QUEUE_FIELDS } from './needs-answer';

const PROMPTS: AgAiPromptStarter[] = [
  { label: 'What needs me?', prompt: 'What needs my answer first, and by when?' },
  { label: 'Explain a forfeit', prompt: 'How does a forfeit work, and who can start one?' },
  { label: 'Money so far', prompt: 'How much has been held, released, captured and refunded so far?' },
  { label: 'Ask it to move money', prompt: 'Capture the hold on goodfaith-demo#5 now.' },
  { label: 'Add a chart', prompt: 'Add a chart of hold amounts by AI band to this page.' },
  { label: 'Where the AI misses', prompt: 'In the evaluation, how many merged first-timers did the model put in the high band, and how many did the plain rule?' },
];


// Page ids differ from the data source ids, so an agent asked about holds does not take the
// Holds page for the page in view.
const PAGES = [
  { id: 'page-needs', label: 'Needs an answer' },
  { id: 'page-pulls', label: 'Pull requests' },
  { id: 'page-holds', label: 'Holds' },
  { id: 'page-ledger', label: 'Ledger' },
  { id: 'page-evidence', label: 'Evidence' },
];

const field = (id: string) => ({ id });
// Studio's currency format has no symbol of its own, and every amount here is US dollars.
const USD = { format: 'currencyFormat', formatOptions: { format: new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }) } } as const;

// One decimal, so the tiles read as the published results do.
const PERCENT = { format: 'percentageFormat', formatOptions: { format: new Intl.NumberFormat('en-US', { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 }) } } as const;

const title = (text: string) => ({ title: { enabled: true, text, typography: { fontSize: 15 } } });
const kpi = (id: string, aggregation: string, text: string) => ({ type: 'value', dataMapping: { value: [{ id, aggregation }] }, format: { style: { typography: { fontSize: 30 }, label: { enabled: true, text, position: 'below', typography: { fontSize: 13 } } } } });

const FOLDED = { filters: { collapsed: true }, data: { collapsed: true }, edit: { collapsed: true } };

const INITIAL: AgReportState = {
  selectedPageId: 'page-needs',
  panels: FOLDED,
  pages: [
    {
      id: 'page-needs',
      name: 'Needs an answer',
      widgets: {
        queue: { type: 'needs-answer', dataMapping: Object.fromEntries(QUEUE_FIELDS.map((name) => [name, [field(`queue.${name}`)]])) },
        waiting: kpi('queue.pr', 'count', 'Need an answer'),
        held: kpi('holds.open', 'sum', 'Holds in place now'),
        reserved: kpi('holds.heldNow', 'sum', 'Reserved at PayPal now'),
      },
      // The open space under the queue is where a chart someone asks for lands, in view.
      widgetLayout: {
        waiting: { xTrack: 0, yTrack: 0, xSpan: 8, ySpan: 6 },
        held: { xTrack: 8, yTrack: 0, xSpan: 8, ySpan: 6 },
        reserved: { xTrack: 16, yTrack: 0, xSpan: 8, ySpan: 6 },
        queue: { xTrack: 0, yTrack: 6, xSpan: 24, ySpan: 22 },
      },
    },
    {
      id: 'page-pulls',
      name: 'Pull requests',
      widgets: {
        total: kpi('pulls.number', 'count', 'Pull requests from strangers'),
        open: kpi('holds.open', 'sum', 'Holds in place now'),
        entry: { type: 'column-chart-grouped', dataMapping: { categoryKey: [field('pulls.entry')], valueKey: [{ id: 'pulls.number', aggregation: 'count' }] }, format: title('How they got in') },
        bands: { type: 'column-chart-grouped', dataMapping: { categoryKey: [field('pulls.band')], valueKey: [{ id: 'pulls.number', aggregation: 'count' }] }, format: title('Hold size the AI suggested') },
        list: { type: 'grid', dataMapping: { cols: ['pulls.pr', 'pulls.title', 'pulls.status', 'pulls.entry', 'pulls.band', 'pulls.openedAt'].map(field) } },
      },
      widgetLayout: {
        total: { xTrack: 0, yTrack: 0, xSpan: 6, ySpan: 9 },
        open: { xTrack: 0, yTrack: 9, xSpan: 6, ySpan: 9 },
        entry: { xTrack: 6, yTrack: 0, xSpan: 9, ySpan: 18 },
        bands: { xTrack: 15, yTrack: 0, xSpan: 9, ySpan: 18 },
        list: { xTrack: 0, yTrack: 18, xSpan: 24, ySpan: 28 },
      },
    },
    {
      id: 'page-holds',
      name: 'Holds',
      widgets: {
        open: kpi('holds.open', 'sum', 'Holds in place now'),
        reserved: kpi('holds.heldNow', 'sum', 'Reserved at PayPal now'),
        returned: kpi('holds.returned', 'sum', 'Returned in full'),
        timeline: { type: 'hold-timeline', dataMapping: Object.fromEntries(TIMELINE_FIELDS.map((name) => [name, [field(`holds.${name}`)]])) },
        states: { type: 'column-chart-grouped', dataMapping: { categoryKey: [field('holds.state')], valueKey: [{ id: 'holds.pr', aggregation: 'count' }] }, format: title('Holds by state') },
        list: { type: 'grid', dataMapping: { cols: ['holds.pr', 'holds.state', 'holds.amount', 'holds.placed', 'holds.appealEnds', 'holds.captured', 'holds.releaseBy'].map(field) } },
      },
      widgetLayout: {
        open: { xTrack: 0, yTrack: 0, xSpan: 8, ySpan: 6 },
        reserved: { xTrack: 8, yTrack: 0, xSpan: 8, ySpan: 6 },
        returned: { xTrack: 16, yTrack: 0, xSpan: 8, ySpan: 6 },
        timeline: { xTrack: 0, yTrack: 6, xSpan: 24, ySpan: 30 },
        states: { xTrack: 0, yTrack: 36, xSpan: 8, ySpan: 16 },
        list: { xTrack: 8, yTrack: 36, xSpan: 16, ySpan: 16 },
      },
    },
    {
      id: 'page-ledger',
      name: 'Ledger',
      widgets: {
        money: { type: 'column-chart-grouped', dataMapping: { categoryKey: [field('money.outcome')], valueKey: [{ id: 'money.amount', aggregation: 'sum' }] }, format: title('Money by outcome, USD') },
        list: { type: 'grid', dataMapping: { cols: ['ledger.at', 'ledger.event', 'ledger.amount', 'ledger.pr', 'ledger.paypalId', 'ledger.confirmed', 'ledger.reason'].map(field) } },
      },
      widgetLayout: {
        money: { xTrack: 0, yTrack: 0, xSpan: 24, ySpan: 18 },
        list: { xTrack: 0, yTrack: 18, xSpan: 24, ySpan: 28 },
      },
    },
    {
      id: 'page-evidence',
      name: 'Evidence',
      widgets: {
        model: kpi('evidenceScores.model', 'sum', 'The model, balanced accuracy'),
        rule: kpi('evidenceScores.rule', 'sum', 'Plain account-age rule'),
        modelHigh: kpi('evidenceScores.modelHighFirstTimers', 'sum', 'Good first-timers the model charged most, of 419'),
        ruleHigh: kpi('evidenceScores.ruleHighFirstTimers', 'sum', 'Good first-timers the rule charged most, of 419'),
        matrix: { type: 'miss-matrix', dataMapping: Object.fromEntries(MISS_FIELDS.map((name) => [name, [field(`evaluation.${name}`)]])) },
        labels: { type: 'column-chart-grouped', dataMapping: { categoryKey: [field('evaluation.label')], valueKey: [{ id: 'evaluation.id', aggregation: 'count' }] }, format: title("Pull requests by maintainers' label") },
        doors: { type: 'column-chart-grouped', dataMapping: { categoryKey: [field('closedDoors.band')], valueKey: [{ id: 'closedDoors.band', aggregation: 'count' }] }, format: title('Newcomers closed by a bot, 304 of 307 sized') },
        list: { type: 'grid', dataMapping: { cols: ['evaluation.id', 'evaluation.repo', 'evaluation.group', 'evaluation.label', 'evaluation.band', 'evaluation.rule', 'evaluation.reason', 'evaluation.url'].map(field) } },
      },
      widgetLayout: {
        model: { xTrack: 0, yTrack: 0, xSpan: 6, ySpan: 6 },
        rule: { xTrack: 6, yTrack: 0, xSpan: 6, ySpan: 6 },
        modelHigh: { xTrack: 12, yTrack: 0, xSpan: 6, ySpan: 6 },
        ruleHigh: { xTrack: 18, yTrack: 0, xSpan: 6, ySpan: 6 },
        matrix: { xTrack: 0, yTrack: 6, xSpan: 15, ySpan: 28 },
        labels: { xTrack: 15, yTrack: 6, xSpan: 9, ySpan: 14 },
        doors: { xTrack: 15, yTrack: 20, xSpan: 9, ySpan: 14 },
        list: { xTrack: 0, yTrack: 34, xSpan: 24, ySpan: 28 },
      },
    },
  ],
} as unknown as AgReportState;

// The same security paper, ink and stamp as the rest of the site, with the type to match.
const THEME = studioTheme.withParams({
  backgroundColor: '#f3f8f4',
  foregroundColor: '#13304a',
  // Tile labels and other quiet text. Studio's default is half-strength ink, too faint on this paper.
  subtleTextColor: '#46596a',
  accentColor: '#5a2a8a',
  browserColorScheme: 'light',
  fontFamily: 'var(--font-text), system-ui, sans-serif',
  borderRadius: 3,
  gridWrapperBorderRadius: 3,
});

export function Studio({ data, licenseKey }: { data: ConsoleData; licenseKey: string }) {
  if (licenseKey) AgStudioLicenseManager.setLicenseKey(licenseKey);
  const studio = useRef<AgStudioApi | null>(null);
  const [page, setPage] = useState('page-needs');
  // The console opens as a dashboard. Studio keeps its assistant in edit mode, so asking it
  // something switches to edit, where a layout change lasts until the page reloads.
  const [mode, setMode] = useState<AgStudioMode>('view');

  // Studio opens the edit rails wide on the first switch, and the assistant is what the button
  // is for, so the rails fold once edit mode is in place and the dashboard keeps its width.
  useEffect(() => {
    const api = studio.current;
    if (mode !== 'edit' || !api) return;
    const timer = setTimeout(() => api.setState({ ...api.getState(), panels: { ...api.getState().panels, ...FOLDED } }));
    return () => clearTimeout(timer);
  }, [mode]);

  function open(id: string) {
    const api = studio.current;
    if (!api) return;
    api.setState({ ...api.getState(), selectedPageId: id });
    setPage(id);
  }

  const sources = useMemo<AgDataSourcesDefinition>(
    () => ({
      sources: [
        {
          id: 'queue',
          name: 'Needs an answer',
          description: 'Pull requests a maintainer has to act on or has a deadline for. Rank 0 is most urgent: an appeal, then a reversible capture, an open forfeit, a hold waiting for review, and a pull request waiting at the gate.',
          data: data.queue,
          fields: [
            { id: 'pr', name: 'Pull request', format: 'textFormat' },
            { id: 'title', name: 'Title', format: 'textFormat' },
            { id: 'url', name: 'Link', format: 'textFormat' },
            { id: 'rank', name: 'Urgency rank', format: 'integerFormat' },
            { id: 'dueAt', name: 'Deadline, as a timestamp', format: 'integerFormat' },
            { id: 'need', name: 'What it needs', format: 'textFormat' },
            { id: 'detail', name: 'What to do', format: 'textFormat' },
            { id: 'due', name: 'By when', format: 'textFormat' },
            { id: 'amount', name: 'Amount held', ...USD },
            { id: 'band', name: 'AI band', format: 'textFormat' },
            { id: 'brief', name: 'AI brief', format: 'textFormat' },
            { id: 'flagged', name: 'Flag', format: 'textFormat' },
          ],
        },
        {
          id: 'pulls',
          name: 'Pull requests',
          description: 'Every pull request from a stranger. pr names it by repository and number, such as goodfaith-demo#4, since each project numbers its own.',
          data: data.pulls,
          fields: [
            { id: 'pr', name: 'Pull request', format: 'textFormat' },
            { id: 'number', name: 'Number in its repository', format: 'integerFormat' },
            { id: 'title', name: 'Title', format: 'textFormat' },
            { id: 'status', name: 'Status', format: 'textFormat' },
            { id: 'entry', name: 'How they got in', format: 'textFormat' },
            { id: 'band', name: 'AI band', format: 'textFormat' },
            { id: 'openedAt', name: 'Opened', format: 'textFormat' },
          ],
        },
        {
          id: 'holds',
          name: 'Holds',
          data: data.holds,
          fields: [
            { id: 'pr', name: 'Pull request', format: 'textFormat' },
            { id: 'url', name: 'Link', format: 'textFormat' },
            { id: 'state', name: 'State', format: 'textFormat' },
            { id: 'band', name: 'AI band of its pull request', format: 'textFormat' },
            { id: 'open', name: 'Holds in place', format: 'integerFormat' },
            { id: 'amount', name: 'Amount', ...USD },
            { id: 'heldNow', name: 'Reserved now', ...USD },
            { id: 'returned', name: 'Returned in full', format: 'integerFormat' },
            { id: 'placedAt', name: 'Placed, exact', format: 'textFormat' },
            { id: 'appealEndsAt', name: 'Appeal ends, exact', format: 'textFormat' },
            { id: 'capturedAt', name: 'Captured, exact', format: 'textFormat' },
            { id: 'endedAt', name: 'Ended, exact', format: 'textFormat' },
            { id: 'placed', name: 'Placed', format: 'textFormat' },
            { id: 'honorEnds', name: 'Honor period ends', format: 'textFormat' },
            { id: 'appealEnds', name: 'Appeal ends', format: 'textFormat' },
            { id: 'captured', name: 'Captured', format: 'textFormat' },
            { id: 'releaseBy', name: 'Released by', format: 'textFormat' },
          ],
        },
        {
          id: 'ledger',
          name: 'Ledger',
          data: data.ledger,
          fields: [
            { id: 'at', name: 'Date', format: 'textFormat' },
            { id: 'event', name: 'Event', format: 'textFormat' },
            { id: 'amount', name: 'Amount', ...USD },
            { id: 'pr', name: 'Pull request', format: 'textFormat' },
            { id: 'by', name: 'By', format: 'textFormat' },
            { id: 'reason', name: 'Reason', format: 'textFormat' },
            { id: 'paypalId', name: 'PayPal ID', format: 'textFormat' },
            { id: 'confirmed', name: 'PayPal webhook', format: 'textFormat' },
          ],
        },
        {
          id: 'evaluation',
          name: 'Evaluation',
          description: "A past test of the model on 1,316 public pull requests from other projects, not this project's holds. A miss says nothing about the person who opened that pull request.",
          data: EVIDENCE_ROWS,
          fields: [
            { id: 'id', name: 'Row', format: 'integerFormat' },
            { id: 'repo', name: 'Repository', format: 'textFormat' },
            { id: 'group', name: 'What really happened', format: 'textFormat' },
            { id: 'label', name: "Maintainers' label", format: 'textFormat' },
            { id: 'band', name: 'Band the model picked in the test', format: 'textFormat' },
            { id: 'rule', name: 'What the plain rule said', format: 'textFormat' },
            { id: 'miss', name: 'Is a published miss', format: 'integerFormat' },
            { id: 'url', name: 'Pull request link, misses only', format: 'textFormat' },
            { id: 'reason', name: "The model's reason, misses only", format: 'textFormat' },
          ],
        },
        {
          id: 'evidenceScores',
          name: 'Evaluation scores',
          description: 'One row of headline results from the evaluation.',
          data: EVIDENCE_SCORES,
          fields: [
            { id: 'model', name: 'Model, balanced accuracy', ...PERCENT },
            { id: 'rule', name: 'Plain rule, balanced accuracy', ...PERCENT },
            { id: 'modelHighFirstTimers', name: 'Merged first-timers the model put in the high band', format: 'integerFormat' },
            { id: 'ruleHighFirstTimers', name: 'Merged first-timers the plain rule flagged', format: 'integerFormat' },
          ],
        },
        {
          id: 'evidenceLabels',
          name: 'Evaluation by label',
          data: EVIDENCE_LABELS,
          fields: [
            { id: 'label', name: "Maintainers' label", format: 'textFormat' },
            { id: 'share', name: 'Share placed in the high band, %', format: 'decimalFormat' },
            { id: 'pulls', name: 'Pull requests', format: 'integerFormat' },
          ],
        },
        {
          id: 'closedDoors',
          name: 'Bot-closed newcomers',
          description: 'Newcomers closed by a bot within an hour on popular public repositories, and the band the model would have picked.',
          data: CLOSED_DOORS,
          fields: [
            { id: 'band', name: 'Band the model would have picked', format: 'textFormat' },
            { id: 'laterMerged', name: 'Later merged', format: 'integerFormat' },
          ],
        },
        {
          id: 'money',
          name: 'Money',
          description: 'Only the events that reserve or move money. A forfeit or an appeal moves nothing.',
          data: data.money,
          fields: [
            { id: 'outcome', name: 'Outcome', format: 'textFormat' },
            { id: 'amount', name: 'Amount', ...USD },
          ],
        },
      ],
      relationships: [
        { id: 'holds-pulls', source: 'holds.pr', target: 'pulls.pr', type: 'many-to-one' },
        { id: 'queue-pulls', source: 'queue.pr', target: 'pulls.pr', type: 'one-to-one' },
        { id: 'ledger-pulls', source: 'ledger.pr', target: 'pulls.pr', type: 'many-to-one' },
      ],
    }),
    [data],
  );

  const widgets = useMemo(
    () =>
      createWidgets({
        additionalTypes: [
          {
            id: 'needs-answer',
            label: 'Needs an answer',
            comp: NeedsAnswer,
            dataMapping: Object.fromEntries(QUEUE_FIELDS.map((name) => [name, { type: 'field', supportedRoles: ['category', 'numeric', 'temporal'], requires: { cardinality: 'many' }, required: true }])),
            form: (params: { createDefaults(options: { dataMappingItems: unknown[] }): unknown }) => params.createDefaults({ dataMappingItems: QUEUE_FIELDS.map((key) => ({ key, label: key })) }),
            defaultSize: { width: 900, height: 500 },
            minSize: { width: 320, height: 200 },
            ai: { description: 'What each pull request needs from a maintainer now, most urgent first, with a link, a deadline and the AI brief.' },
          },
          {
            id: 'hold-timeline',
            label: 'Hold timeline',
            comp: HoldTimeline,
            dataMapping: Object.fromEntries(TIMELINE_FIELDS.map((name) => [name, { type: 'field', supportedRoles: ['category', 'numeric', 'temporal'], requires: { cardinality: 'many' }, required: true }])),
            form: (params: { createDefaults(options: { dataMappingItems: unknown[] }): unknown }) => params.createDefaults({ dataMappingItems: TIMELINE_FIELDS.map((key) => ({ key, label: key })) }),
            defaultSize: { width: 900, height: 400 },
            minSize: { width: 320, height: 200 },
            ai: { description: 'One row per hold, showing the honor period, the appeal window and the day a forgotten hold is released.' },
          },
          {
            id: 'miss-matrix',
            label: 'Where the AI misses',
            comp: MissMatrix,
            dataMapping: Object.fromEntries(MISS_FIELDS.map((name) => [name, { type: 'field', supportedRoles: ['category', 'numeric', 'temporal'], requires: { cardinality: 'many' }, required: true }])),
            form: (params: { createDefaults(options: { dataMappingItems: unknown[] }): unknown }) => params.createDefaults({ dataMappingItems: MISS_FIELDS.map((key) => ({ key, label: key })) }),
            defaultSize: { width: 900, height: 600 },
            minSize: { width: 420, height: 320 },
            ai: { description: 'The evaluation on 1,316 public pull requests as a table of what really happened against the band the model picked, beside a plain rule, with each published miss and its reason.' },
          },
        ],
        menu: [{ label: 'Goodfaith', widgetIds: ['needs-answer', 'hold-timeline', 'miss-matrix'] }],
      } as never),
    [],
  );

  const ai = useMemo<AgAiHarnessSetup>(
    () =>
      ({ api: coreApi }) => {
        const api = coreApi as unknown as AgStudioApi;
        const rules = api.defineAiTool({
          name: 'explain_hold_rules',
          description: 'The fixed rules for vouches, holds, forfeits, appeals, captures, refunds and payouts.',
          params: (s) => s.object({}),
          execute: async (_args, ctx) => ctx.success(HOLD_RULES),
        });
        // A custom lead that answers about money, handing dashboard work to Studio's own agents.
        // None of the team has a tool that touches PayPal, so delegating widens nothing.
        return createAiHarness(api, ({ builtIn, tools }) => ({
          agents: [
            directLlmRunner({
              id: 'ledger-analyst',
              adapter: consoleAdapter,
              instructions: () => LEAD_INSTRUCTIONS,
              tools: () => [tools.studio.viewSchema(), tools.studio.viewPage(), tools.studio.executeQuery(), rules, tools.delegateTo(['page', 'widget'])],
            }),
            directLlmRunner({ ...builtIn.page, adapter: consoleAdapter }),
            directLlmRunner({ ...builtIn.widget, adapter: consoleAdapter }),
          ],
          primary: 'ledger-analyst',
          promptStarters: PROMPTS,
        }));
      },
    [],
  );

  return (
    <AgStudioProvider modules={[AgStudioAiModule]}>
      <nav className="console-tabs" aria-label="Console pages">
        {PAGES.map(({ id, label }) => (
          <button key={id} type="button" aria-current={page === id ? 'page' : undefined} onClick={() => open(id)}>{label}</button>
        ))}
        <button type="button" className="console-mode" aria-pressed={mode === 'edit'} onClick={() => setMode(mode === 'view' ? 'edit' : 'view')}>
          {mode === 'view' ? 'Ask the assistant' : 'Close the assistant'}
        </button>
        <p className="muted">{mode === 'view' ? 'Everything here is public and read-only. Money only moves when a maintainer comments on the pull request.' : 'The assistant is read-only too. Layout changes last until you reload.'}</p>
        <p className="console-narrow">The console is laid out for a wider screen. On a phone, the <a href="/ledger">public ledger</a> has the same rows.</p>
      </nav>
      <AgStudio onApiReady={({ api }) => { studio.current = api as unknown as AgStudioApi; }} style={{ height: 'calc(100% - 2.75rem)', width: '100%' }} data={sources} initialState={INITIAL} widgets={widgets} theme={THEME} mode={mode} ai={ai} />
    </AgStudioProvider>
  );
}
