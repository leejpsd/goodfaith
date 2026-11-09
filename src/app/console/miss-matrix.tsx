'use client';

import { AgLoadingOverlay, AgNoDataOverlay } from 'ag-studio-react';
import { useEffect, useMemo, useState } from 'react';
import { columnsOf, isMissCell, MISS_FIELDS, tally, type EvidenceRow, type Reader } from '@/lib/console/misses';

type MappedField = { id: string; key: string };

interface MatrixParams {
  dataMapping: Partial<Record<(typeof MISS_FIELDS)[number], MappedField[]>>;
  widgetApi: {
    getData(request: unknown, options?: { queryId?: string; crossFilter?: 'none' }): Promise<{ replaced?: boolean; results?: { rows?: Record<string, unknown>[] } }>;
    toggleCrossFilter(params: { type: 'multiValue'; group: number; reset: boolean; values: { field: MappedField; value: string }[] }): void;
    resetCrossFilter(): void;
    getCrossFilterSelections(): { type: string; values?: unknown }[] | undefined;
  };
}

const NOTE: Record<Reader, string> = {
  model: 'Choose any cell and the rest of this page follows it. The two stamped cells are the mistakes that matter: low effort sized too small, and a good newcomer charged the most. Their pull requests and the reasons the model gave are listed here.',
  rule: 'Choose any cell and the rest of this page follows it. The plain rule flags a young account or a thin history. It has two outcomes and gives no reasons, so there is nothing to read here.',
};

// Where the model was wrong on real pull requests, beside a plain rule. Choosing a cell sets a
// Studio cross filter, so the page's chart and grid follow it. The third custom widget this
// project adds to AG Studio.
export function MissMatrix({ widgetApi, dataMapping }: MatrixParams) {
  const [rows, setRows] = useState<EvidenceRow[] | null>(null);
  const [reader, setReader] = useState<Reader>('model');

  useEffect(() => {
    let live = true;
    const mapped = MISS_FIELDS.flatMap((name) => dataMapping[name]?.slice(0, 1) ?? []);
    if (mapped.length < MISS_FIELDS.length) return;
    // Its own selection must not narrow its own table, so it always reads every row.
    void widgetApi.getData({ kind: 'flat', fields: mapped }, { queryId: 'misses', crossFilter: 'none' }).then((response) => {
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
  // Studio holds the selection, so a filter cleared anywhere else shows here too.
  const field = reader === 'model' ? dataMapping.band?.[0] : dataMapping.rule?.[0];
  const selection = widgetApi.getCrossFilterSelections()?.find((s) => s.type === 'multiValue');
  const pairs = ((selection?.values as { field: MappedField; value: string }[][] | undefined)?.[0] ?? []);
  const valueOf = (mapped?: MappedField) => pairs.find((pair) => pair.field.id === mapped?.id)?.value;
  const chosen = { group: valueOf(dataMapping.group?.[0]), column: valueOf(field) };
  const filtered = chosen.group !== undefined && chosen.column !== undefined;
  const reading = filtered ? chosen : { group: 'Merged first-timer', column: 'High' };
  const isMiss = isMissCell(reading.group as string, reading.column as string, 'model');
  const misses = useMemo(() => (rows ?? []).filter((r) => r.miss === 1 && r.group === reading.group && r.band === reading.column), [rows, reading.group, reading.column]);

  function choose(group: string, column: string) {
    const groupField = dataMapping.group?.[0];
    if (!groupField || !field) return;
    widgetApi.toggleCrossFilter({ type: 'multiValue', group: 0, reset: true, values: [{ field: groupField, value: group }, { field, value: column }] });
  }

  function read(next: Reader) {
    widgetApi.resetCrossFilter();
    setReader(next);
  }

  if (!rows) return <AgLoadingOverlay />;
  if (rows.length === 0) return <AgNoDataOverlay />;

  return (
    <div className="matrix">
      <div className="matrix-readers" role="group" aria-label="Whose answers to show">
        {(['model', 'rule'] as const).map((id) => (
          <button key={id} type="button" aria-pressed={reader === id} onClick={() => read(id)}>
            {id === 'model' ? 'The model' : 'A plain account-age rule'}
          </button>
        ))}
        {filtered && <button type="button" className="matrix-clear" onClick={() => widgetApi.resetCrossFilter()}>Show all {rows.length.toLocaleString('en-US')}</button>}
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
                const on = filtered && chosen.group === row.group && chosen.column === cell.column;
                return (
                  <td key={cell.column} className={cell.miss ? 'miss' : undefined} style={shade}>
                    <button type="button" aria-pressed={on} onClick={() => choose(row.group, cell.column)}>{body}</button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="matrix-note">{NOTE[reader]}</p>
      {reader === 'model' && !isMiss && <p className="matrix-note">This cell is not one of the published misses, so it has no links or reasons. The rest of the page now shows only these pull requests.</p>}
      {reader === 'model' && isMiss && (
        <ul className="matrix-misses" aria-label={`${reading.group} placed in the ${reading.column} band`}>
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
