import type { NextConfig } from "next";

const config: NextConfig = {
  // The gateway routes /acme-ui/** here and keeps the path.
  basePath: "/acme-ui",
  output: "standalone",
};

export default config;
