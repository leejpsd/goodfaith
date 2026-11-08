'use client';

import { AgLoadingOverlay, AgNoDataOverlay } from 'ag-studio-react';
import { useEffect, useState } from 'react';
import { AUTHORIZATION_DAYS, HONOR_DAYS, VOID_BEFORE_EXPIRY_DAYS } from '@/lib/hold';

const DAY = 864e5;
const LAST_DAY = AUTHORIZATION_DAYS - VOID_BEFORE_EXPIRY_DAYS;

interface HoldPoint {
  pr: string;
  url: string;
  state: string;
  amount: number;
  placedAt: string;
  appealEndsAt: string | null;
  capturedAt: string | null;
  endedAt: string | null;
}

export const TIMELINE_FIELDS = ['pr', 'url', 'state', 'amount', 'placedAt', 'appealEndsAt', 'capturedAt', 'endedAt'] as const;
const ENDED = new Set(['Captured', 'Paid out', 'Released', 'Refunded']);
// Money that went back to the contributor is stamped in green, and money taken in rust.
const STAMP: Record<string, string> = { Released: 'returned', Refunded: 'returned', Captured: 'taken', 'Paid out': 'taken' };
const MARKS = [0, 7, 14, 21, 28];

// Studio hands date fields back as dates or strings, depending on the field's format.
const toIso = (value: unknown) => (value === null || value === undefined || value === '' ? null : new Date(value as string).toISOString());
const dayOf = (iso: string, placedAt: string) => (Date.parse(iso) - Date.parse(placedAt)) / DAY;
const at = (days: number) => `${Math.min(Math.max(days / LAST_DAY, 0), 1) * 100}%`;

type MappedField = { id: string; key: string };

// Studio passes more than this, and these are the parts the widget reads.
interface TimelineParams {
  dataMapping: Partial<Record<(typeof TIMELINE_FIELDS)[number], MappedField[]>>;
  widgetApi: {
    getData(request: unknown, options?: { queryId?: string }): Promise<{ replaced?: boolean; results?: { rows?: Record<string, unknown>[] } }>;
  };
}

// One row per hold, on the same 28-day ruler: PayPal's honor period, the appeal window, and the
// day a forgotten hold is released. The custom widget this project adds to AG Studio.
export function HoldTimeline({ widgetApi, dataMapping }: TimelineParams) {
  const [rows, setRows] = useState<HoldPoint[] | null>(null);

  useEffect(() => {
    let live = true;
    const mapped = TIMELINE_FIELDS.flatMap((name) => dataMapping[name]?.slice(0, 1) ?? []);
    if (mapped.length < TIMELINE_FIELDS.length) return;
    void widgetApi
      .getData({ kind: 'flat', fields: mapped }, { queryId: 'holds' })
      .then((response) => {
        if (!live || response.replaced) return;
        const read = (row: Record<string, unknown>, name: (typeof TIMELINE_FIELDS)[number]) => row[dataMapping[name]?.[0]?.key ?? name];
        setRows(
          (response.results?.rows ?? []).map((row) => ({
            pr: String(read(row, 'pr')),
            url: String(read(row, 'url') ?? ''),
            state: String(read(row, 'state')),
            amount: Number(read(row, 'amount')),
            placedAt: toIso(read(row, 'placedAt')) ?? '',
            appealEndsAt: toIso(read(row, 'appealEndsAt')),
            capturedAt: toIso(read(row, 'capturedAt')),
            endedAt: toIso(read(row, 'endedAt')),
          })),
        );
      });
    return () => {
      live = false;
    };
  }, [widgetApi, dataMapping]);

  if (!rows) return <AgLoadingOverlay />;
  if (rows.length === 0) return <AgNoDataOverlay />;
  const now = new Date().toISOString();

  return (
    <div className="timeline">
      <div className="timeline-key">
        <span><i className="swatch honor" /> Honor period, {HONOR_DAYS} days</span>
        <span><i className="swatch appeal" /> Appeal window</span>
        <span><i className="swatch age" /> Time held</span>
        <span><i className="swatch pin-key" /> Captured</span>
        <span>Released by day {LAST_DAY} if nobody acts</span>
      </div>
      <div className="timeline-ruler" aria-hidden="true">
        <span />
        <div>{MARKS.map((day) => <span key={day} style={{ left: at(day) }}>Day {day}</span>)}</div>
      </div>
      <ul>
        {rows.map((hold) => {
          const age = dayOf(now, hold.placedAt);
          const ended = ENDED.has(hold.state);
          const appealEnd = hold.appealEndsAt ? dayOf(hold.appealEndsAt, hold.placedAt) : null;
          // An ended hold is drawn to the day it ended, and its stamp sits just past that.
          const held = hold.endedAt ? dayOf(hold.endedAt, hold.placedAt) : age;
          return (
            <li key={hold.pr} className={ended ? 'ended' : undefined}>
              <div className="timeline-label">
                {hold.url ? <a href={hold.url} target="_blank" rel="noreferrer"><strong>{hold.pr}</strong></a> : <strong>{hold.pr}</strong>} ${hold.amount.toFixed(2)}, {hold.state}
              </div>
              <div
                className="timeline-track"
                role="img"
                aria-label={`${hold.pr}: ${hold.state}. Placed ${hold.placedAt}.${hold.appealEndsAt ? ` Appeal window ends ${hold.appealEndsAt}.` : ''}${hold.capturedAt ? ` Captured ${hold.capturedAt}.` : ''}`}
              >
                <div className="segment honor" style={{ width: at(HONOR_DAYS) }} />
                <div className="segment age" style={{ width: at(held) }} />
                {!ended && appealEnd !== null && <div className="segment appeal" style={{ left: at(age), width: `calc(${at(appealEnd)} - ${at(age)})` }} />}
                {hold.capturedAt && <div className="pin" style={{ left: at(dayOf(hold.capturedAt, hold.placedAt)) }} />}
                {ended && <span className={`track-stamp ${STAMP[hold.state] ?? ''}`} style={{ left: `calc(${at(held)} + 0.5rem)` }}>{hold.state}</span>}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
