import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Acme Analytics',
  description: 'Product analytics for modern teams.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html>
      <body>{children}</body>
    </html>
  );
}
