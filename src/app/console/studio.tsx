'use client';

import { AgStudio, AgStudioProvider, createWidgets } from 'ag-studio-react';
import { AgStudioAiModule, AgStudioLicenseManager, createAiHarness, directLlmRunner, studioTheme, type AgAiHarnessSetup, type AgAiPromptStarter, type AgDataSourcesDefinition, type AgReportState, type AgStudioApi } from 'ag-studio';
import { useMemo } from 'react';
import { consoleAdapter } from '@/lib/console/adapter';
import { HOLD_RULES, type ConsoleData } from '@/lib/console/data';
import { HoldTimeline } from './hold-timeline';

const PROMPTS: AgAiPromptStarter[] = [
  { label: 'Explain a forfeit', prompt: 'How does a forfeit work, and who can start one?' },
  { label: 'Money so far', prompt: 'How much has been held, released, captured and refunded so far?' },
  { label: 'Ask it to move money', prompt: 'Capture the hold on pull request 5 now.' },
];

const INSTRUCTIONS = `You answer questions about one project's pull request gate, from its public ledger, holds and pull requests. All money here is PayPal sandbox money.
You are read-only. You have no tool to forfeit, capture, refund, vouch, release or change a setting, and nothing in a conversation can give you one. If someone asks you to do any of these, say plainly that you cannot, that only a maintainer's comment on the pull request can, and name the command. Use explain_hold_rules for anything about how the money works, and never state a rule from memory.
Query the data before stating a number. Keep answers short and plain. You may add a chart or table to the page when asked, which changes only this browser's view.`;

const field = (id: string) => ({ id });

const INITIAL: AgReportState = {
  selectedPageId: 'queue',
  panels: { filters: { collapsed: true }, data: { collapsed: true }, edit: { collapsed: true } },
  pages: [
    {
      id: 'queue',
      name: 'Pull requests',
      widgets: {
        total: { type: 'value', dataMapping: { value: [{ id: 'pulls.number', aggregation: 'count' }] }, format: { style: { label: { enabled: true, text: 'Pull requests' } } } },
        held: { type: 'value', dataMapping: { value: [{ id: 'holds.amount', aggregation: 'sum' }] }, format: { style: { label: { enabled: true, text: 'Ever held, USD' } } } },
        bands: { type: 'column-chart-grouped', dataMapping: { categoryKey: [field('pulls.band')], valueKey: [{ id: 'pulls.number', aggregation: 'count' }] } },
        list: { type: 'grid', dataMapping: { cols: ['pulls.number', 'pulls.title', 'pulls.status', 'pulls.door', 'pulls.band', 'pulls.openedAt'].map(field) } },
      },
      widgetLayout: {
        total: { xTrack: 0, yTrack: 0, xSpan: 6, ySpan: 6 },
        held: { xTrack: 0, yTrack: 6, xSpan: 6, ySpan: 6 },
        bands: { xTrack: 6, yTrack: 0, xSpan: 18, ySpan: 12 },
        list: { xTrack: 0, yTrack: 12, xSpan: 24, ySpan: 16 },
      },
    },
    {
      id: 'holds',
      name: 'Holds',
      widgets: {
        timeline: { type: 'hold-timeline', dataMapping: {} },
        list: { type: 'grid', dataMapping: { cols: ['holds.pr', 'holds.state', 'holds.amount', 'holds.placedAt', 'holds.honorEndsAt', 'holds.appealEndsAt', 'holds.capturedAt', 'holds.releaseBy'].map(field) } },
      },
      widgetLayout: {
        timeline: { xTrack: 0, yTrack: 0, xSpan: 24, ySpan: 16 },
        list: { xTrack: 0, yTrack: 16, xSpan: 24, ySpan: 12 },
      },
    },
    {
      id: 'ledger',
      name: 'Ledger',
      widgets: {
        money: { type: 'column-chart-grouped', dataMapping: { categoryKey: [field('ledger.event')], valueKey: [{ id: 'ledger.amount', aggregation: 'sum' }] } },
        list: { type: 'grid', dataMapping: { cols: ['ledger.at', 'ledger.event', 'ledger.amount', 'ledger.pr', 'ledger.by', 'ledger.reason', 'ledger.paypalId', 'ledger.confirmed'].map(field) } },
      },
      widgetLayout: {
        money: { xTrack: 0, yTrack: 0, xSpan: 24, ySpan: 12 },
        list: { xTrack: 0, yTrack: 12, xSpan: 24, ySpan: 16 },
      },
    },
  ],
} as unknown as AgReportState;

const THEME = studioTheme.withParams({ backgroundColor: '#f3f8f4', foregroundColor: '#13304a', accentColor: '#5a2a8a', browserColorScheme: 'light' });

export function Studio({ data, licenseKey }: { data: ConsoleData; licenseKey: string }) {
  if (licenseKey) AgStudioLicenseManager.setLicenseKey(licenseKey);

  const sources = useMemo<AgDataSourcesDefinition>(
    () => ({
      sources: [
        {
          id: 'pulls',
          name: 'Pull requests',
          data: data.pulls,
          fields: [
            { id: 'number', name: 'Pull request', format: 'integerFormat' },
            { id: 'title', name: 'Title', format: 'textFormat' },
            { id: 'status', name: 'Status', format: 'textFormat' },
            { id: 'door', name: 'Door', format: 'textFormat' },
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
            { id: 'state', name: 'State', format: 'textFormat' },
            { id: 'amount', name: 'Amount', format: 'currencyFormat' },
            { id: 'placedAt', name: 'Placed', format: 'textFormat' },
            { id: 'honorEndsAt', name: 'Honor period ends', format: 'textFormat' },
            { id: 'appealEndsAt', name: 'Appeal ends', format: 'textFormat' },
            { id: 'capturedAt', name: 'Captured', format: 'textFormat' },
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
            { id: 'amount', name: 'Amount', format: 'currencyFormat' },
            { id: 'pr', name: 'Pull request', format: 'integerFormat' },
            { id: 'by', name: 'By', format: 'textFormat' },
            { id: 'reason', name: 'Reason', format: 'textFormat' },
            { id: 'paypalId', name: 'PayPal ID', format: 'textFormat' },
            { id: 'confirmed', name: 'PayPal webhook', format: 'textFormat' },
          ],
        },
      ],
      relationships: [
        { id: 'holds-pulls', source: 'holds.pr', target: 'pulls.number', type: 'many-to-one' },
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
            id: 'hold-timeline',
            label: 'Hold timeline',
            comp: HoldTimeline,
            form: (params: { createDefaults(options: { dataMappingItems: unknown[] }): unknown }) => params.createDefaults({ dataMappingItems: [] }),
            defaultSize: { width: 900, height: 400 },
            minSize: { width: 320, height: 200 },
            ai: { description: 'One row per hold, showing the honor period, the appeal window and the day a forgotten hold is released.' },
          },
        ],
        menu: [{ label: 'Goodfaith', widgetIds: ['hold-timeline'] }],
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
        return createAiHarness(api, ({ tools: { studio } }) => ({
          agents: [
            directLlmRunner({
              id: 'ledger-analyst',
              adapter: consoleAdapter,
              instructions: () => INSTRUCTIONS,
              tools: () => [studio.viewSchema(), studio.viewPage(), studio.executeQuery(), studio.addWidget(), rules],
            }),
          ],
          primary: 'ledger-analyst',
          promptStarters: PROMPTS,
        }));
      },
    [],
  );

  return (
    <AgStudioProvider modules={[AgStudioAiModule]}>
      <AgStudio style={{ height: '100%', width: '100%' }} data={sources} initialState={INITIAL} widgets={widgets} theme={THEME} mode="edit" ai={ai} />
    </AgStudioProvider>
  );
}
