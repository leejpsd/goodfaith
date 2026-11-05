import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The SDK's HTTP layer is loaded at run time, so it stays out of the server bundle.
  serverExternalPackages: ['@paypal/paypal-server-sdk'],
};

export default nextConfig;
