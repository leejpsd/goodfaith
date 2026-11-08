'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

// Reloads the server render every few seconds while the model is still sizing the hold.
export function RefreshSoon({ seconds = 5 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), seconds * 1000);
    return () => clearInterval(timer);
  }, [router, seconds]);
  return null;
}
