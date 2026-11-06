'use client';

import { AgLoadingOverlay } from 'ag-studio-react';
import { useEffect, useState } from 'react';

export const QUEUE_FIELDS = ['pr', 'title', 'url', 'rank', 'dueAt', 'need', 'detail', 'due', 'amount', 'band', 'brief', 'flagged'] as const;
type QueueField = (typeof QUEUE_FIELDS)[number];
type MappedField = { id: string; key: string };

interface QueueParams {
  dataMapping: Partial<Record<QueueField, MappedField[]>>;
  widgetApi: {
    getData(request: unknown, options?: { queryId?: string }): Promise<{ replaced?: boolean; results?: { rows?: Record<string, unknown>[] } }>;
  };
}

type Item = Record<QueueField, string> & { amountValue: number; rankValue: number; dueValue: number };

// What a maintainer has to act on, with a link to each pull request and the AI's brief.
// The second custom widget this project adds to AG Studio.
export function NeedsAnswer({ widgetApi, dataMapping }: QueueParams) {
  const [items, setItems] = useState<Item[] | null>(null);

  useEffect(() => {
    let live = true;
    const mapped = QUEUE_FIELDS.flatMap((name) => dataMapping[name]?.slice(0, 1) ?? []);
    if (mapped.length < QUEUE_FIELDS.length) return;
    void widgetApi
      .getData({ kind: 'flat', fields: mapped }, { queryId: 'queue' })
      .then((response) => {
        if (!live || response.replaced) return;
        const read = (row: Record<string, unknown>, name: QueueField) => row[dataMapping[name]?.[0]?.key ?? name];
        const next = (response.results?.rows ?? []).map((row) => {
          const item = Object.fromEntries(QUEUE_FIELDS.map((name) => [name, String(read(row, name) ?? '')])) as Record<QueueField, string>;
          return { ...item, amountValue: Number(read(row, 'amount')), rankValue: Number(read(row, 'rank')), dueValue: Number(read(row, 'dueAt')) };
        });
        setItems(next.sort((a, b) => a.rankValue - b.rankValue || a.dueValue - b.dueValue));
      });
    return () => {
      live = false;
    };
  }, [widgetApi, dataMapping]);

  if (!items) return <AgLoadingOverlay />;
  if (items.length === 0) return <p className="queue-empty">Nothing needs an answer. Every pull request is in review or settled.</p>;

  return (
    <ol className="queue">
      {items.map((item) => (
        <li key={item.pr} className={`queue-item rank-${item.rankValue}`}>
          <div className="queue-head">
            <a href={item.url} target="_blank" rel="noreferrer">#{item.pr} {item.title}</a>
            <span className="queue-money">{item.amountValue > 0 ? `$${item.amountValue.toFixed(2)} held` : 'No money'}</span>
          </div>
          <p className="queue-need"><strong>{item.need}.</strong> {item.detail}</p>
          <p className="queue-due">{item.due}</p>
          <p className="queue-brief">AI brief, {item.band.toLowerCase()} band: {item.brief}</p>
          {item.flagged && <p className="queue-flag">{item.flagged}</p>}
        </li>
      ))}
    </ol>
  );
}
