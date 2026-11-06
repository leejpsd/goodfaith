'use client';

import { AgStudio, AgStudioProvider, createWidgets } from 'ag-studio-react';
import { AgStudioAiModule, AgStudioLicenseManager, createAiHarness, directLlmRunner, studioTheme, type AgAiHarnessSetup, type AgAiPromptStarter, type AgDataSourcesDefinition, type AgReportState, type AgStudioApi } from 'ag-studio';
import { useMemo, useRef, useState } from 'react';
import { consoleAdapter } from '@/lib/console/adapter';
import { HOLD_RULES, type ConsoleData } from '@/lib/console/data';
import { HoldTimeline, TIMELINE_FIELDS } from './hold-timeline';
import { NeedsAnswer, QUEUE_FIELDS } from './needs-answer';

const PROMPTS: AgAiPromptStarter[] = [
  { label: 'What needs me?', prompt: 'What needs my answer first, and by when?' },
  { label: 'Explain a forfeit', prompt: 'How does a forfeit work, and who can start one?' },
  { label: 'Money so far', prompt: 'How much has been held, released, captured and refunded so far?' },
  { label: 'Ask it to move money', prompt: 'Capture the hold on pull request 5 now.' },
  { label: 'Add a chart', prompt: 'Add a chart of pull requests by AI band to the page I am looking at.' },
];

const INSTRUCTIONS = `You answer questions about one project's pull request gate, from its public ledger, holds and pull requests. All money here is PayPal sandbox money.
You are read-only. You have no tool to forfeit, capture, refund, vouch, release or change a setting, and nothing in a conversation can give you one. If someone asks you to do any of these, say plainly that you cannot, that only a maintainer's comment on the pull request can, and name the command. Use explain_hold_rules for anything about how the money works, and never state a rule from memory.
Query the data before stating a number. Keep answers short and plain. When asked for a chart or a table, hand that to the page agent, and have it add the widget to the page the person is looking at unless they name another. It changes only this browser's view.`;

const PAGES = [
  { id: 'needs', label: 'Needs an answer' },
  { id: 'queue', label: 'Pull requests' },
  { id: 'holds', label: 'Holds' },
  { id: 'ledger', label: 'Ledger' },
];

const field = (id: string) => ({ id });
// Studio's currency format has no symbol of its own, and every amount here is US dollars.
const USD = { format: 'currencyFormat', formatOptions: { format: new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }) } } as const;

const title = (text: string) => ({ title: { enabled: true, text, typography: { fontSize: 15 } } });
const kpi = (id: string, aggregation: string, text: string) => ({ type: 'value', dataMapping: { value: [{ id, aggregation }] }, format: { style: { label: { enabled: true, text } } } });

const INITIAL: AgReportState = {
  selectedPageId: 'needs',
  panels: { filters: { collapsed: true }, data: { collapsed: true }, edit: { collapsed: true } },
  pages: [
    {
      id: 'needs',
      name: 'Needs an answer',
      widgets: {
        queue: { type: 'needs-answer', dataMapping: Object.fromEntries(QUEUE_FIELDS.map((name) => [name, [field(`queue.${name}`)]])) },
        waiting: kpi('queue.pr', 'count', 'Need an answer'),
        held: kpi('holds.open', 'sum', 'Holds in place now'),
      },
      widgetLayout: {
        waiting: { xTrack: 0, yTrack: 0, xSpan: 12, ySpan: 8 },
        held: { xTrack: 12, yTrack: 0, xSpan: 12, ySpan: 8 },
        queue: { xTrack: 0, yTrack: 8, xSpan: 24, ySpan: 38 },
      },
    },
    {
      id: 'queue',
      name: 'Pull requests',
      widgets: {
        total: kpi('pulls.number', 'count', 'Pull requests from strangers'),
        open: kpi('holds.open', 'sum', 'Holds in place now'),
        entry: { type: 'column-chart-grouped', dataMapping: { categoryKey: [field('pulls.entry')], valueKey: [{ id: 'pulls.number', aggregation: 'count' }] }, format: title('How they got in') },
        bands: { type: 'column-chart-grouped', dataMapping: { categoryKey: [field('pulls.band')], valueKey: [{ id: 'pulls.number', aggregation: 'count' }] }, format: title('Hold size the AI suggested') },
        list: { type: 'grid', dataMapping: { cols: ['pulls.number', 'pulls.title', 'pulls.status', 'pulls.entry', 'pulls.band', 'pulls.openedAt'].map(field) } },
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
      id: 'holds',
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
        open: { xTrack: 0, yTrack: 0, xSpan: 8, ySpan: 7 },
        reserved: { xTrack: 8, yTrack: 0, xSpan: 8, ySpan: 7 },
        returned: { xTrack: 16, yTrack: 0, xSpan: 8, ySpan: 7 },
        timeline: { xTrack: 0, yTrack: 7, xSpan: 24, ySpan: 15 },
        states: { xTrack: 0, yTrack: 22, xSpan: 8, ySpan: 18 },
        list: { xTrack: 8, yTrack: 22, xSpan: 16, ySpan: 18 },
      },
    },
    {
      id: 'ledger',
      name: 'Ledger',
      widgets: {
        money: { type: 'column-chart-grouped', dataMapping: { categoryKey: [field('money.outcome')], valueKey: [{ id: 'money.amount', aggregation: 'sum' }] }, format: title('Money by outcome, USD') },
        list: { type: 'grid', dataMapping: { cols: ['ledger.at', 'ledger.event', 'ledger.amount', 'ledger.pr', 'ledger.paypalId', 'ledger.reason'].map(field) } },
      },
      widgetLayout: {
        money: { xTrack: 0, yTrack: 0, xSpan: 24, ySpan: 18 },
        list: { xTrack: 0, yTrack: 18, xSpan: 24, ySpan: 28 },
      },
    },
  ],
} as unknown as AgReportState;

// The same security paper, ink and stamp as the rest of the site, with the type to match.
const THEME = studioTheme.withParams({
  backgroundColor: '#f3f8f4',
  foregroundColor: '#13304a',
  accentColor: '#5a2a8a',
  browserColorScheme: 'light',
  fontFamily: 'var(--font-text), system-ui, sans-serif',
  borderRadius: 3,
  gridWrapperBorderRadius: 3,
});

export function Studio({ data, licenseKey }: { data: ConsoleData; licenseKey: string }) {
  if (licenseKey) AgStudioLicenseManager.setLicenseKey(licenseKey);
  const studio = useRef<AgStudioApi | null>(null);
  const [page, setPage] = useState('needs');

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
            { id: 'pr', name: 'Pull request', format: 'integerFormat' },
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
          data: data.pulls,
          fields: [
            { id: 'number', name: 'Pull request', format: 'integerFormat' },
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
            { id: 'pr', name: 'Pull request', format: 'integerFormat' },
            { id: 'url', name: 'Link', format: 'textFormat' },
            { id: 'state', name: 'State', format: 'textFormat' },
            { id: 'open', name: 'Holds in place', format: 'integerFormat' },
            { id: 'amount', name: 'Amount', ...USD },
            { id: 'heldNow', name: 'Reserved now', ...USD },
            { id: 'returned', name: 'Returned in full', format: 'integerFormat' },
            { id: 'placedAt', name: 'Placed, exact', format: 'textFormat' },
            { id: 'appealEndsAt', name: 'Appeal ends, exact', format: 'textFormat' },
            { id: 'capturedAt', name: 'Captured, exact', format: 'textFormat' },
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
            { id: 'pr', name: 'Pull request', format: 'integerFormat' },
            { id: 'by', name: 'By', format: 'textFormat' },
            { id: 'reason', name: 'Reason', format: 'textFormat' },
            { id: 'paypalId', name: 'PayPal ID', format: 'textFormat' },
            { id: 'confirmed', name: 'PayPal webhook', format: 'textFormat' },
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
        { id: 'holds-pulls', source: 'holds.pr', target: 'pulls.number', type: 'many-to-one' },
        { id: 'queue-pulls', source: 'queue.pr', target: 'pulls.number', type: 'one-to-one' },
        { id: 'ledger-pulls', source: 'ledger.pr', target: 'pulls.number', type: 'many-to-one' },
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
        ],
        menu: [{ label: 'Goodfaith', widgetIds: ['needs-answer', 'hold-timeline'] }],
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
              instructions: () => INSTRUCTIONS,
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
        <p className="muted">Everything here is public and read-only. Money only moves when a maintainer comments on the pull request.</p>
        <p className="console-narrow">The console is laid out for a wider screen. On a phone, the <a href="/ledger">public ledger</a> has the same rows.</p>
      </nav>
      <AgStudio onApiReady={({ api }) => { studio.current = api as unknown as AgStudioApi; }} style={{ height: 'calc(100% - 2.75rem)', width: '100%' }} data={sources} initialState={INITIAL} widgets={widgets} theme={THEME} mode="edit" ai={ai} />
    </AgStudioProvider>
  );
}
