import './globals.css';
import type { ReactNode } from 'react';

export const metadata = { title: 'NexaForge AI', description: 'Multimodal AI agent workspace' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="fr"><body>{children}</body></html>;
}
