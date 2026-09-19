import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'TaskBattle — задачи на время',
  description:
    'Загрузите фотографии задач, поделитесь комнатой и получите подробный отчёт о решении.',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
  icons: {
    icon: '/favicon.svg',
    shortcut: '/favicon.svg',
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru">
      <body className="antialiased">{children}</body>
    </html>
  );
}
