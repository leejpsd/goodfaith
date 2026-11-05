'use client';

import dynamic from 'next/dynamic';
import type { ConsoleData } from '@/lib/console/data';

// AG Studio draws in the browser, so it stays out of the server render.
const Studio = dynamic(() => import('./studio').then((m) => m.Studio), {
  ssr: false,
  loading: () => <p className="muted" role="status" style={{ padding: '1rem' }}>Loading the console.</p>,
});

export function ConsoleLoader({ data, licenseKey }: { data: ConsoleData; licenseKey: string }) {
  return <Studio data={data} licenseKey={licenseKey} />;
}
