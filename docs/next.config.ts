import type { NextConfig } from "next";
import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

const config: NextConfig = {
  reactStrictMode: true,
  agentRules: false,
};

export default withMDX(config);
