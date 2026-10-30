export async function generateMetadata() {
  const post = await load();
  return { title: post.title, description: post.summary, alternates: { canonical: '/blog' } };
}

export default function Blog() {
  return null;
}
