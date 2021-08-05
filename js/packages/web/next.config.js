const withPlugins = require('next-compose-plugins');
const withLess = require('next-with-less');
const path = require('path');

const pathToLessFileWithVariables = path.resolve('ant-theme-overrides.less');

const assetPrefix = process.env.ASSET_PREFIX || '';

const plugins = [
  [
    withLess,
    {
      lessLoaderOptions: {
        additionalData: `@assetPrefix: ${assetPrefix};\n\n@import '${pathToLessFileWithVariables}';`,
      },
    },
  ],
];

module.exports = withPlugins(plugins, {
  assetPrefix,
  reactStrictMode: true,
  eslint: {
    ignoreDuringBuilds: true,
  },
  env: {
    NEXT_PUBLIC_STORE_OWNER_ADDRESS_ADDRESS:
      process.env.REACT_APP_STORE_OWNER_ADDRESS_ADDRESS,
  },
  async rewrites() {
    return [
      {
        source: '/:any*',
        destination: '/',
      },
    ];
  },
});
