import { resolve } from "node:path";
import type { NextConfig } from "next";
import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();
const repo = resolve(__dirname, "../..");

const config: NextConfig = {
  reactStrictMode: true,
  agentRules: false,
  transpilePackages: ["skills-cli"],
  outputFileTracingRoot: repo,
  turbopack: { root: repo },
};

export default withMDX(config);
