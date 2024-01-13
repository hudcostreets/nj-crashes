const {
  createVanillaExtractPlugin
} = require('@vanilla-extract/next-plugin');
const withVanillaExtract = createVanillaExtractPlugin();
const path = require('path')

const createTranspileModulesPlugin = require("next-transpile-modules");
const withTranspileModules = createTranspileModulesPlugin(["next-utils"]);

const basePath = "/nj-crashes"

let distDirArgs = { distDir: `out${basePath}` }
if (process.env.CI) {
  distDirArgs = {}
  console.log("CI detected, removing distDir")
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  swcMinify: true,
  basePath,
  assetPrefix: basePath,
  publicRuntimeConfig: {
    basePath,
  },
  images: {
    unoptimized: true,
  },
  output: "export",
  ...distDirArgs,
  trailingSlash: true,
  // https://github.com/vercel/next.js/issues/55964#issuecomment-1744279596
  webpack: (config) => {
    // This fixes the invalid hook React error which
    // will occur when multiple versions of React is detected
    // This can happen since common project is also using Next (which is using React)
    const reactPaths = {
      react: path.join(__dirname, "node_modules/react"),
      "react-dom": path.join(__dirname, "node_modules/react-dom"),
    };
    config.resolve = {
      ...config.resolve,
      alias: {
        ...config.resolve.alias,
        ...reactPaths,
      },
    };
    return config;
  },
}

const withMDX = require('@next/mdx')({
  extension: /\.mdx?$/,
  options: {
    // If you use remark-gfm, you'll need to use next.config.mjs
    // as the package is ESM only
    // https://github.com/remarkjs/remark-gfm#install
    remarkPlugins: [],
    rehypePlugins: [],
    // If you use `MDXProvider`, uncomment the following line.
    providerImportSource: "@mdx-js/react",
  },
})
module.exports = withTranspileModules(withVanillaExtract(withMDX({
  ...nextConfig,
  // Append the default value with md extensions
  pageExtensions: ['ts', 'tsx', 'js', 'jsx', 'md', 'mdx'],
})))
