import type { Metadata, Viewport } from 'next';
import './globals.css';
import { Geist } from 'next/font/google';
import { cn } from '@/lib/utils';
import { DaemonProvider } from '@/components/providers/DaemonProvider';
import { NexusClientProvider } from '@/components/providers/NexusClientProvider';
import { ThemeProvider } from '@/components/providers/ThemeProvider';
import { ToastProvider } from '@/components/providers/ToastProvider';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AppShell } from '@/components/shell/AppShell';
import { MaturityBanner } from '@/components/shell/MaturityBanner';
import { ServiceWorkerRegister } from '@/components/providers/ServiceWorkerRegister';
import { NewBuildBanner } from '@/components/providers/NewBuildBanner';

const geist = Geist({ subsets: ['latin'], variable: '--font-sans' });

export const metadata: Metadata = {
  title: 'elanous',
  description: 'elanous — voice · chat · intake · control · terminal.',
  manifest: '/app/manifest.webmanifest',
  applicationName: 'elanous',
  // 대표 확정 아이콘 V6 «엘랑 소용돌이» — 원천 docs/brand/icon/ (2026-09-30)
  icons: {
    icon: [
      { url: '/app/icons/elanous-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/app/icons/elanous-16.png', sizes: '16x16', type: 'image/png' },
    ],
    apple: [{ url: '/app/icons/elanous-180.png', sizes: '180x180', type: 'image/png' }],
  },
};

export const viewport: Viewport = {
  themeColor: '#1e1e2e',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ko" className={cn('font-sans', geist.variable)}>
      <head>
        {/* Preload the Regular weight so xterm.js measures glyphs with
            the bundled Nerd Font on first paint instead of falling back
            to monospace and reflowing once the @font-face fetch lands. */}
        <link
          rel="preload"
          as="font"
          type="font/ttf"
          href="/app/fonts/JetBrainsMonoNerdFontMono-Regular.ttf"
          crossOrigin="anonymous"
        />
      </head>
      <body className="min-h-screen bg-background text-foreground antialiased">
        <ServiceWorkerRegister />
        <NewBuildBanner />
        <DaemonProvider>
          <NexusClientProvider>
            <ThemeProvider>
              <TooltipProvider>
                <ToastProvider>
                  <AppShell><MaturityBanner />{children}</AppShell>
                </ToastProvider>
              </TooltipProvider>
            </ThemeProvider>
          </NexusClientProvider>
        </DaemonProvider>
      </body>
    </html>
  );
}
