import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Every page depends on who is signed in, so the app renders on each request.
  // Cache Components stays off to keep that model simple.
  output: "standalone",
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
