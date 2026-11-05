'use client';

import { useRouter } from 'next/navigation';
import Script from 'next/script';
import { useRef, useState, type HTMLAttributes, type MouseEventHandler } from 'react';

interface PaymentSession {
  start(options: { presentationMode: 'auto' }, order: Promise<{ orderId: string }>): Promise<void>;
}

interface SdkInstance {
  findEligibleMethods(input: { currencyCode: string; amount: string }): Promise<{ isEligible(method: string): boolean }>;
  createPayPalOneTimePaymentSession(callbacks: {
    onApprove(data: { orderId: string }): Promise<void>;
    onCancel(): void;
    onError(error: { code?: string; message?: string }): void;
  }): PaymentSession;
}

declare global {
  interface Window {
    paypal?: { createInstance(input: { clientId: string; components: string[]; pageType: string; locale: string }): Promise<SdkInstance> };
  }
}

declare module 'react' {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      'paypal-button': HTMLAttributes<HTMLElement> & { class?: string };
    }
  }
}

const MESSAGES: Record<string, string> = {
  declined: 'PayPal declined that payment method, and nothing was held. You can try again.',
  not_waiting: 'This pull request no longer needs a hold, and nothing was held.',
  stale_order: 'That approval is out of date, and nothing was held. Please try again.',
  not_found: 'This hold page is no longer valid.',
  cancelled: 'You left PayPal, so nothing was held.',
};
const FAILED = 'PayPal could not finish this, and nothing was held. Please try again, or ask for a vouch instead.';

async function post(url: string, body?: unknown) {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const json = (await response.json().catch(() => ({}))) as { orderId?: string; refused?: string };
  return { ok: response.ok, ...json };
}

export function HoldButton({ pullRequestId, clientId, amount, canSimulateDecline }: { pullRequestId: string; clientId: string; amount: string; canSimulateDecline: boolean }) {
  const router = useRouter();
  const simulate = useRef(false);
  const session = useRef<PaymentSession | null>(null);
  const [ready, setReady] = useState(false);
  const [working, setWorking] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function setUp() {
    try {
      const sdk = await window.paypal!.createInstance({ clientId, components: ['paypal-payments'], pageType: 'checkout', locale: 'en-US' });
      const methods = await sdk.findEligibleMethods({ currencyCode: 'USD', amount });
      if (!methods.isEligible('paypal')) {
        setUnavailable(true);
        return;
      }
      session.current = sdk.createPayPalOneTimePaymentSession({
        onApprove: async ({ orderId }) => {
          setWorking(true);
          const result = await post(`/api/holds/${pullRequestId}/authorize`, { orderId, simulateDecline: simulate.current });
          setWorking(false);
          if (result.ok) router.refresh();
          else setMessage(MESSAGES[result.refused ?? ''] ?? FAILED);
        },
        onCancel: () => setMessage(MESSAGES.cancelled ?? FAILED),
        onError: (error) => {
          console.error('PayPal session error', error.code, error.message);
          setMessage(FAILED);
        },
      });
      setReady(true);
    } catch (error) {
      console.error('PayPal SDK failed to start', error);
      setUnavailable(true);
    }
  }

  async function createOrder(): Promise<{ orderId: string }> {
    const result = await post(`/api/holds/${pullRequestId}/order`);
    if (!result.ok || !result.orderId) throw new Error(result.refused ?? 'unavailable');
    return { orderId: result.orderId };
  }

  const start: MouseEventHandler<HTMLElement> = async () => {
    setMessage(null);
    try {
      // The live SDK requires a promise here. It rejects a function reference.
      await session.current?.start({ presentationMode: 'auto' }, createOrder());
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      setMessage(MESSAGES[code] ?? FAILED);
    }
  };

  return (
    <div className="pay">
      <Script src="https://www.sandbox.paypal.com/web-sdk/v6/core" strategy="afterInteractive" onReady={() => void setUp()} onError={() => setUnavailable(true)} />
      {/* No `type`, which leaves just the PayPal logo. The other types all say to pay or buy, and this is a hold. */}
      {ready && !working && <paypal-button class="paypal-gold" onClick={start} />}
      {canSimulateDecline && ready && (
        <label className="simulate">
          <input type="checkbox" onChange={(event) => { simulate.current = event.target.checked; }} /> Have PayPal&apos;s sandbox decline this payment, to see what happens
        </label>
      )}
      {!ready && !unavailable && <p className="muted">Loading PayPal.</p>}
      {working && <p className="muted">Placing your hold.</p>}
      {unavailable && <p className="warn">PayPal is not available right now. A vouch is free and does not need PayPal.</p>}
      {message && <p className="warn" role="alert">{message}</p>}
    </div>
  );
}
