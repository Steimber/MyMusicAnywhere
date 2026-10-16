import { Manrope, Syne } from 'next/font/google';
import './globals.css';

const syne = Syne({
  subsets: ['latin'],
  weight: ['600', '700', '800'],
  variable: '--font-syne',
  display: 'swap'
});

const manrope = Manrope({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-manrope',
  display: 'swap'
});

export const metadata = {
  title: {
    default: 'mineral music',
    template: '%s · mineral music'
  },
  description: 'Tu música, colecciones y modo offline sin interrupciones.',
  applicationName: 'mineral music',
  manifest: '/manifest.json',
  icons: {
    icon: [
      { url: '/icon.svg?v=3', type: 'image/svg+xml', sizes: 'any' },
      { url: '/icons/icon-192.png', type: 'image/png', sizes: '192x192' }
    ],
    apple: [{ url: '/apple-touch-icon.png?v=3', sizes: '180x180', type: 'image/png' }]
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'mineral music'
  },
  other: {
    'apple-mobile-web-app-capable': 'yes'
  }
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  colorScheme: 'light dark',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f5f2e9' },
    { media: '(prefers-color-scheme: dark)', color: '#000000' }
  ]
};

export default function RootLayout({ children }) {
  return (
    <html lang="es" className={`${syne.variable} ${manrope.variable}`}>
      <body>
        {children}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              if ('serviceWorker' in navigator) {
                window.addEventListener('load', () => {
                  navigator.serviceWorker.register('/sw.js').catch(console.warn);
                });
              }
            `
          }}
        />
      </body>
    </html>
  );
}
