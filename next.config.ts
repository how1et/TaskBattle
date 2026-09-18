import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Vinext's multipart preflight also runs before App Router API handlers.
  // The API enforces the tighter per-route 3 MiB / 18 MiB streaming limits.
  experimental: { serverActions: { bodySizeLimit: '20mb' } },
};

export default nextConfig;
