/** @type {import('next').NextConfig} */
// Two modes:
//  - dev / `next start`: /api/* is proxied to the Rust API (API_URL), so the browser sees one origin.
//  - NEXT_EXPORT=1: static export into out/, which the Rust API serves itself (single process, see Dockerfile).
const API_URL = process.env.API_URL || 'http://localhost:8000';

module.exports =
  process.env.NEXT_EXPORT === '1'
    ? { reactStrictMode: true, output: 'export', trailingSlash: true, images: { unoptimized: true } }
    : {
        reactStrictMode: true,
        async rewrites() {
          return [{ source: '/api/:path*', destination: `${API_URL}/api/:path*` }];
        },
      };
