export default function Home() {
  return (
    <main>
      <h1>Understand your users</h1>
      <img src="/hero.png" />
      <a onClick={() => window.location.assign('/pricing')}>See pricing</a>
    </main>
  );
}
