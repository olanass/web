import './globals.css';
import { headers } from 'next/headers';

const title = 'x402 Launchpad - Paid APIs on Robinhood Chain';
const description = 'Launch, discover, and monetize APIs with x402 payments on Robinhood Chain.';

export async function generateMetadata() {
  const requestHeaders = await headers();
  const host = (requestHeaders.get('x-forwarded-host') || requestHeaders.get('host') || 'localhost:4020')
    .split(',')[0]
    .trim();
  const protocol = (requestHeaders.get('x-forwarded-proto') || (host.startsWith('localhost') ? 'http' : 'https'))
    .split(',')[0]
    .trim();
  const origin = `${protocol}://${host}`;
  const socialImage = `${origin}/og.png`;

  return {
    title,
    description,
    referrer: 'no-referrer',
    icons: { icon: '/assets/favicon.png?v=20260923' },
    openGraph: {
      title,
      description,
      type: 'website',
      url: origin,
      images: [{ url: socialImage, width: 1200, height: 630, alt: 'x402 Launchpad' }]
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [socialImage]
    }
  };
}

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
        <link href="/styles/app.css?v=20260926-projects-design" rel="stylesheet" />
        <script
          type="importmap"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              imports: {
                three: 'https://unpkg.com/three@0.158.0/build/three.module.js',
                'three/addons/': 'https://unpkg.com/three@0.158.0/examples/jsm/'
              }
            })
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
