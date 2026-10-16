/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    const vpsUrl = process.env.VPS_BACKEND_URL?.trim().replace(/\/$/, '');
    if (!vpsUrl) {
      return [];
    }
    return {
      beforeFiles: [
        {
          source: '/api/:path*',
          destination: `${vpsUrl}/api/:path*`
        }
      ]
    };
  }
};

export default nextConfig;
