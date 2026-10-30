export function Card({ src }: { src: string }) {
  return (
    <figure>
      <img src={src} onClick={() => window.open(src)} alt="Product" />
      <a onClick={() => history.back()}>Back</a>
    </figure>
  );
}
