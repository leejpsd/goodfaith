'use client';

import { AgLoadingOverlay, AgNoDataOverlay } from 'ag-studio-react';
import { useEffect, useMemo, useState } from 'react';
import { columnsOf, MISS_FIELDS, tally, type EvidenceRow, type Reader } from '@/lib/console/misses';

type MappedField = { id: string; key: string };

interface MatrixParams {
  dataMapping: Partial<Record<(typeof MISS_FIELDS)[number], MappedField[]>>;
  widgetApi: {
    getData(request: unknown, options?: { queryId?: string }): Promise<{ replaced?: boolean; results?: { rows?: Record<string, unknown>[] } }>;
  };
}

const NOTE: Record<Reader, string> = {
  model: 'Stamped cells are the two mistakes that matter: low effort sized too small, and a good newcomer charged the most. Choose one to read each pull request and the reason the model gave.',
  rule: `The plain rule flags a young account or a thin history. It has two outcomes and gives no reasons, so there is nothing to read here.`,
};

// Where the model was wrong on real pull requests, beside a plain rule, one choice away from each
// miss and its reason. The third custom widget this project adds to AG Studio.
export function MissMatrix({ widgetApi, dataMapping }: MatrixParams) {
  const [rows, setRows] = useState<EvidenceRow[] | null>(null);
  const [reader, setReader] = useState<Reader>('model');
  const [picked, setPicked] = useState({ group: 'Merged first-timer', column: 'High' });

  useEffect(() => {
    let live = true;
    const mapped = MISS_FIELDS.flatMap((name) => dataMapping[name]?.slice(0, 1) ?? []);
    if (mapped.length < MISS_FIELDS.length) return;
    void widgetApi.getData({ kind: 'flat', fields: mapped }, { queryId: 'misses' }).then((response) => {
      if (!live || response.replaced) return;
      const read = (row: Record<string, unknown>, name: (typeof MISS_FIELDS)[number]) => row[dataMapping[name]?.[0]?.key ?? name];
      setRows(
        (response.results?.rows ?? []).map((row) => ({
          id: Number(read(row, 'id')),
          repo: String(read(row, 'repo') ?? ''),
          group: String(read(row, 'group') ?? ''),
          label: String(read(row, 'label') ?? ''),
          band: String(read(row, 'band') ?? ''),
          rule: String(read(row, 'rule') ?? ''),
          miss: Number(read(row, 'miss')),
          url: String(read(row, 'url') ?? ''),
          reason: String(read(row, 'reason') ?? ''),
        })),
      );
    });
    return () => {
      live = false;
    };
  }, [widgetApi, dataMapping]);

  const table = useMemo(() => (rows ? tally(rows, reader) : []), [rows, reader]);
  const misses = useMemo(() => (rows ?? []).filter((r) => r.miss === 1 && r.group === picked.group && r.band === picked.column), [rows, picked]);

  if (!rows) return <AgLoadingOverlay />;
  if (rows.length === 0) return <AgNoDataOverlay />;

  return (
    <div className="matrix">
      <div className="matrix-readers" role="group" aria-label="Whose answers to show">
        {(['model', 'rule'] as const).map((id) => (
          <button key={id} type="button" aria-pressed={reader === id} onClick={() => setReader(id)}>
            {id === 'model' ? 'The model' : 'A plain account-age rule'}
          </button>
        ))}
      </div>
      <table>
        <thead>
          <tr>
            <th scope="col">What really happened</th>
            {columnsOf(reader).map((column) => (
              <th key={column} scope="col">{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.map((row) => (
            <tr key={row.group}>
              <th scope="row">
                {row.group} <span>{row.total}</span>
              </th>
              {row.cells.map((cell) => {
                const body = (
                  <>
                    <b>{cell.count}</b> <span>{Math.round(cell.share * 100)}%</span>
                  </>
                );
                const shade = { '--share': `${Math.round(cell.share * 45)}%` } as React.CSSProperties;
                if (!cell.miss) return <td key={cell.column} style={shade}>{body}</td>;
                if (reader === 'rule') return <td key={cell.column} className="miss" style={shade}>{body}</td>;
                const on = picked.group === row.group && picked.column === cell.column;
                return (
                  <td key={cell.column} className="miss" style={shade}>
                    <button type="button" aria-pressed={on} onClick={() => setPicked({ group: row.group, column: cell.column })}>{body}</button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="matrix-note">{NOTE[reader]}</p>
      {reader === 'model' && (
        <ul className="matrix-misses" aria-label={`${picked.group} placed in the ${picked.column} band`}>
          {misses.map((miss) => (
            <li key={miss.id}>
              <a href={miss.url} target="_blank" rel="noreferrer">{miss.repo}</a> {miss.reason}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
