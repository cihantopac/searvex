export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return { title: slug, description: `Post ${slug}` };
}
export default function Post() {
  return <article>Post</article>;
}
