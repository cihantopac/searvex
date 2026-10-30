import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'About Acme',
  description: 'Our story and team.',
  alternates: { canonical: '/about' },
};

export default function About() {
  return <h1>About</h1>;
}
