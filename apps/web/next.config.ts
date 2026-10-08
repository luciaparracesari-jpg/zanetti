import path from 'node:path';
import type { NextConfig } from 'next';

// Se lee al compilar: en Docker se pasa como build arg (API_URL=http://api:4000).
const API_URL = process.env.API_URL ?? 'http://localhost:4000';

const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: 'standalone',
  // Monorepo: incluye los paquetes del workspace en la salida standalone.
  outputFileTracingRoot: path.join(__dirname, '../../'),
  transpilePackages: ['@erp/shared'],
  // El navegador sólo habla con este mismo origen; Next.js reenvía /api/* a la API.
  // Así la cookie de sesión es de primer nivel y ninguna credencial de canal llega al frontend.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API_URL}/api/:path*` }];
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
