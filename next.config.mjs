/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  serverExternalPackages: ["better-sqlite3"],
  allowedDevOrigins: ["127.0.0.1", "localhost", "192.168.1.218"],
};

export default nextConfig;
