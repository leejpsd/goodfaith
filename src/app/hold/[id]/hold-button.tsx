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
  declined: 'PayPal declined that payment method, and nothing was held. Place the hold again and choose a different payment method in PayPal, or ask for a vouch.',
  not_approved: 'PayPal did not finish the approval, and nothing was held. Please try again.',
  pending: 'PayPal is still reviewing this payment, so nothing is held. If it clears later, Goodfaith releases it on its own.',
  not_waiting: 'This pull request no longer needs a hold, and nothing was held.',
  stale_order: 'That approval is out of date, and nothing was held. Please try again.',
  not_found: 'This hold page is no longer valid.',
  too_many_holds: 'This PayPal account already has 5 open holds across projects, so nothing was held. A hold is released at review. A vouch is free and has no limit.',
  sizing: 'The AI is still reading this pull request to size the hold, and nothing was held. This page updates on its own.',
  cancelled: 'You left PayPal, so nothing was held.',
};
const FAILED = 'PayPal could not finish this, and nothing was held. Please try again, or ask for a vouch instead.';
// PayPal may have acted on an approval whose answer was lost, so this never says nothing was held.
const UNKNOWN = 'PayPal did not answer in time, so it is not clear yet whether the hold went through. Refresh this page in a minute. If PayPal holds money that this page does not show, Goodfaith releases it within half an hour.';

// A server error or a lost connection reads as unavailable: the outcome is unknown, not refused.
async function post(url: string, body?: unknown): Promise<{ ok: boolean; orderId?: string; refused?: string }> {
  try {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const json = (await response.json().catch(() => ({}))) as { orderId?: string; refused?: string };
    return { ok: response.ok, ...json, refused: json.refused ?? (response.status >= 500 ? 'unavailable' : undefined) };
  } catch {
    return { ok: false, refused: 'unavailable' };
  }
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
          // The same order and the same request ID make a repeat safe, so an answer lost on the
          // way back is asked for again before anyone is told what happened.
          let result = await post(`/api/holds/${pullRequestId}/authorize`, { orderId, simulateDecline: simulate.current });
          for (const wait of [1500, 4000]) {
            if (result.ok || result.refused !== 'unavailable') break;
            await new Promise((done) => setTimeout(done, wait));
            result = await post(`/api/holds/${pullRequestId}/authorize`, { orderId, simulateDecline: simulate.current });
          }
          setWorking(false);
          if (result.ok) router.refresh();
          else setMessage(result.refused === 'unavailable' ? UNKNOWN : (MESSAGES[result.refused ?? ''] ?? FAILED));
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
