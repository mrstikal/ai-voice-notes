import type { NextConfig } from "next";

import { validateStartupEnvironment } from "./src/lib/config";

validateStartupEnvironment();

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
