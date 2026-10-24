import './globals.css';
import { Space_Grotesk, IBM_Plex_Sans, IBM_Plex_Mono, Sora, Manrope, Public_Sans } from 'next/font/google';

const grotesk = Space_Grotesk({ subsets: ['latin'], variable: '--f-grotesk', display: 'swap' });
const plex = IBM_Plex_Sans({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--f-plex', display: 'swap' });
const plexMono = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--f-plexmono', display: 'swap' });
const sora = Sora({ subsets: ['latin'], variable: '--f-sora', display: 'swap' });
const manrope = Manrope({ subsets: ['latin'], variable: '--f-manrope', display: 'swap' });
const publicSans = Public_Sans({ subsets: ['latin'], variable: '--f-public', display: 'swap' });

export const metadata = { title: 'AIRSAFE', description: 'Indoor air transmission-risk monitoring' };

export default function RootLayout({ children }) {
  const fonts = [grotesk, plex, plexMono, sora, manrope, publicSans].map((f) => f.variable).join(' ');
  return (
    <html lang="en">
      <body className={fonts}>{children}</body>
    </html>
  );
}
