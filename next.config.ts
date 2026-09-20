import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * nodemailer, imapflow and mailparser are Node-only and are not on Next's
   * auto-externalized list. Bundling them breaks their dynamic requires, so
   * they have to be loaded from node_modules at runtime instead.
   */
  serverExternalPackages: ["nodemailer", "imapflow", "mailparser"],
};

export default nextConfig;
