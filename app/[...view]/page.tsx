import Battle from '@/components/battle';
export default async function Page({ params }: { params: Promise<{ view: string[] }> }) {
  const { view } = await params;
  return <Battle key={view.join('/')} view={view} />;
}
