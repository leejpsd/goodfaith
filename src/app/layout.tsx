import type { Metadata } from 'next';
import { Atkinson_Hyperlegible_Next, Courier_Prime, Libre_Caslon_Display } from 'next/font/google';
import Link from 'next/link';
import type { ReactNode } from 'react';
import './globals.css';

const display = Libre_Caslon_Display({ weight: '400', subsets: ['latin'], variable: '--font-display' });
const text = Atkinson_Hyperlegible_Next({ subsets: ['latin'], variable: '--font-text' });
const typed = Courier_Prime({ weight: ['400', '700'], subsets: ['latin'], variable: '--font-typed' });

export const metadata: Metadata = {
  title: 'Goodfaith',
  description: "A free vouch or a refundable PayPal hold gets a stranger's pull request to review.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${text.variable} ${typed.variable}`}>
      <body>
        <header className="site-head">
          <Link className="wordmark" href="/">Goodfaith</Link>
          <nav aria-label="Main">
            <Link href="/try">Try it</Link>
            <Link href="/replay">Replay a repo</Link>
            <Link href="/console">Console</Link>
            <Link href="/ledger">Public ledger</Link>
            <a href="https://github.com/leejpsd/goodfaith-demo">Demo repository</a>
            <a href="https://github.com/leejpsd/goodfaith">Source</a>
          </nav>
        </header>
        {children}
        <footer>
          Goodfaith uses the PayPal sandbox, so all money shown here is sandbox money. The contributors and maintainers in the demo are test accounts.
        </footer>
      </body>
    </html>
  );
}
