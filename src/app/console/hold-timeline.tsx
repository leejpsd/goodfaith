'use client';

import { AgLoadingOverlay, AgNoDataOverlay } from 'ag-studio-react';
import { useEffect, useState } from 'react';
import { AUTHORIZATION_DAYS, HONOR_DAYS, VOID_BEFORE_EXPIRY_DAYS } from '@/lib/hold';

const DAY = 864e5;
const LAST_DAY = AUTHORIZATION_DAYS - VOID_BEFORE_EXPIRY_DAYS;

interface HoldPoint {
  pr: number;
  state: string;
  amount: number;
  placedAt: string;
  appealEndsAt: string | null;
  capturedAt: string | null;
}

const FIELDS = ['pr', 'state', 'amount', 'placedAt', 'appealEndsAt', 'capturedAt'] as const;
const OPEN = new Set(['held', 'forfeit_pending', 'appealed']);
const STATE: Record<string, string> = {
  held: 'In place',
  forfeit_pending: 'Forfeit pending',
  appealed: 'Appealed',
  captured: 'Captured',
  paid_out: 'Paid out',
  voided: 'Released',
  refunded: 'Refunded',
};

const dayOf = (iso: string, placedAt: string) => (Date.parse(iso) - Date.parse(placedAt)) / DAY;
const at = (days: number) => `${Math.min(Math.max(days / LAST_DAY, 0), 1) * 100}%`;

// Studio passes more than this, and these are the parts the widget reads.
interface TimelineParams {
  widgetApi: {
    getData(request: unknown, options?: { queryId?: string }): Promise<{ replaced?: boolean; results?: { rows?: Record<string, unknown>[] } }>;
  };
}

// One row per hold, on the same 28-day ruler: PayPal's honor period, the appeal window, and the
// day a forgotten hold is released. The custom widget this project adds to AG Studio.
export function HoldTimeline({ widgetApi }: TimelineParams) {
  const [rows, setRows] = useState<HoldPoint[] | null>(null);

  useEffect(() => {
    let live = true;
    void widgetApi
      .getData({ kind: 'flat', fields: FIELDS.map((field) => ({ id: `holds.${field}` })) }, { queryId: 'holds' })
      .then((response) => {
        if (!live || response.replaced) return;
        const read = (row: Record<string, unknown>, field: string) => row[`holds.${field}`] ?? row[field];
        setRows(
          (response.results?.rows ?? []).map((row) => ({
            pr: Number(read(row, 'pr')),
            state: String(read(row, 'state')),
            amount: Number(read(row, 'amount')),
            placedAt: String(read(row, 'placedAt')),
            appealEndsAt: (read(row, 'appealEndsAt') as string | null) ?? null,
            capturedAt: (read(row, 'capturedAt') as string | null) ?? null,
          })),
        );
      });
    return () => {
      live = false;
    };
  }, [widgetApi]);

  if (!rows) return <AgLoadingOverlay />;
  if (rows.length === 0) return <AgNoDataOverlay />;
  const now = new Date().toISOString();

  return (
    <div className="timeline">
      <div className="timeline-key">
        <span><i className="swatch honor" /> Honor period, {HONOR_DAYS} days</span>
        <span><i className="swatch appeal" /> Appeal window</span>
        <span><i className="swatch age" /> Time held so far</span>
        <span>Released by day {LAST_DAY} if nobody acts</span>
      </div>
      <ul>
        {rows.map((hold) => {
          const age = dayOf(now, hold.placedAt);
          return (
            <li key={hold.pr}>
              <div className="timeline-label">
                <strong>#{hold.pr}</strong> ${hold.amount.toFixed(2)}, {STATE[hold.state] ?? hold.state}
              </div>
              <div className="timeline-track" title={`Placed ${hold.placedAt}`}>
                <div className="segment honor" style={{ width: at(HONOR_DAYS) }} />
                {OPEN.has(hold.state) && <div className="segment age" style={{ width: at(age) }} />}
                {hold.appealEndsAt && (
                  <div className="segment appeal" style={{ left: at(age), width: `calc(${at(dayOf(hold.appealEndsAt, hold.placedAt))} - ${at(age)})` }} />
                )}
                {hold.capturedAt && <div className="pin" style={{ left: at(dayOf(hold.capturedAt, hold.placedAt)) }} aria-label="Captured" />}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
