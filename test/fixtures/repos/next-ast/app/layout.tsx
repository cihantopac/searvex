import type { Metadata } from 'next';

const shared = { openGraph: { siteName: 'Acme' } };

export const metadata: Metadata = { ...shared, description: 'Acme tools' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={['a', 'b'].join(' ')}>
      <body>{children}</body>
    </html>
  );
}
