const features = [{ title: 'Fast', description: 'Quick' }];

export const metadata = { description: 'Home', alternates: { canonical: '/' } };

export default function Home() {
  return <ul>{features.map((f) => <li key={f.title}>{f.title}</li>)}</ul>;
}
