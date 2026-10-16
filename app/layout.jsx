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
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'mineral music'
  }
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f5f2e9' },
    { media: '(prefers-color-scheme: dark)', color: '#000000' }
  ]
};

export default function RootLayout({ children }) {
  return (
    <html lang="es" className={`${syne.variable} ${manrope.variable}`}>
      <head>
        <link rel="icon" type="image/svg+xml" href="/brand/logo.svg" media="(prefers-color-scheme: light)" />
        <link rel="icon" type="image/svg+xml" href="/brand/logo-dark.svg" media="(prefers-color-scheme: dark)" />
        <link rel="apple-touch-icon" href="/icon.svg" />
      </head>
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
