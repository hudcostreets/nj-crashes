/** @type {import('next').NextConfig} */
const nextConfig = {
  trailingSlash: true,
  transpilePackages: ['@rdub/icons'],
}

module.exports = {
  ...nextConfig,
}
