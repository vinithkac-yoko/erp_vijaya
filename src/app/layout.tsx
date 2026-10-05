import type { Metadata, Viewport } from 'next';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource-variable/space-grotesk';
import './globals.css';
import { currentUser } from '@/server/auth/session';

export const metadata: Metadata = {
  title: { default: 'Vijaya Stores', template: '%s · Vijaya Stores' },
  description: 'Stores and stock for Vijaya Electronics.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#1B2A38' };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Reading the cookie makes every page render per request, which is what lets Next stamp the CSP nonce.
  const user = await currentUser();
  const theme = user?.theme === 'light' || user?.theme === 'dark' ? user.theme : undefined;
  return (
    <html lang="en" data-theme={theme}>
      <body>{children}</body>
    </html>
  );
}
