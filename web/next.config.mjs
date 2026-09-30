/**
 * Production: static export (`out/`) served by the Cloudflare Worker's static assets,
 * on the same origin as the API.
 * Development: `next dev` proxies /api and /auth to `wrangler dev` (default :8787).
 */
const isDev = process.env.NODE_ENV === "development";
const workerUrl = process.env.WORKER_DEV_URL || "http://127.0.0.1:8787";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  eslint: { ignoreDuringBuilds: true },
  images: { unoptimized: true },
  ...(isDev
    ? {
        async rewrites() {
          return [
            { source: "/api/:path*", destination: `${workerUrl}/api/:path*` },
            { source: "/auth/:path*", destination: `${workerUrl}/auth/:path*` },
          ];
        },
      }
    : { output: "export" }),
};

export default nextConfig;
