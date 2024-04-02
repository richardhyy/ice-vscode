//@ts-check

'use strict';

const CopyPlugin = require("copy-webpack-plugin");
const webpack = require('webpack');
const fs = require('fs');
const glob = require("glob");
const path = require('path');

//@ts-check
/** @typedef {import('webpack').Configuration} WebpackConfig **/

// Dictionary configuration
const dictionaryConfig = {
  target: 'node',
  mode: 'none',
  entry: glob.sync('./providers/*/main.js').reduce((acc, filePath) => {
    const dictionaryName = path.basename(path.dirname(filePath));
    acc[dictionaryName] = './' + filePath;
    return acc;
  }, {}),
  output: {
    path: path.resolve(__dirname, 'dist_providers'),
    filename: '[name].js',
    libraryTarget: 'commonjs2'
  },
  plugins: [
    new webpack.BannerPlugin({
      banner: (pathData) => {
        console.log(pathData);
        // @ts-ignore
        const filePath = pathData.chunk.entryModule.resource;
        const fileContent = fs.readFileSync(filePath, 'utf8');
        // @ts-ignore
        const commentHeader = fileContent.match(/\/\/\s==FlowChatProvider==[\s\S]*?\/\/\s==\/FlowChatProvider==/)[0];
        return commentHeader;
      },
      raw: true,
      entryOnly: true,
    })
  ],
  resolve: {
    extensions: ['.js']
  },
  optimization: {
    minimize: false,
  },
};

// Webview configuration
const webviewConfig = {
  target: 'node',
  mode: 'none',
  entry: './webview/main.js',
  output: {
    path: path.resolve(__dirname, 'dist_webview'),
    filename: '[name].js',
    libraryTarget: 'commonjs2'
  },
  resolve: {
    extensions: ['.js']
  },
  optimization: {
    minimize: true,
  },
};

/** @type WebpackConfig */
const extensionConfig = {
  target: 'node',
  mode: 'none',
  entry: './src/extension.ts',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'extension.js',
    libraryTarget: 'commonjs2'
  },
  plugins: [
    new CopyPlugin({
      patterns: [
        {
          from: './dist_providers',
          to: 'providers',
        },
      ],
    }),
  ],
  externals: {
    vscode: 'commonjs vscode'
  },
  resolve: {
    extensions: ['.ts', '.js', '.html']
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [
          {
            loader: 'ts-loader'
          }
        ]
      },
      {
        test: /\.html$/i,
        loader: 'html-loader',
        options: {
          preprocessor: async (content, loaderContext) => {
            const $ = require('cheerio').load(content);
            const fs = require('fs');
            const path = require('path');
  
            const read = (p) => fs.readFileSync(path.resolve(loaderContext.context, p), 'utf8');
  
            try {
              $('script').each(function () {
                if ($(this).attr('src')) {
                  $(this).text(read('../dist_webview/' + $(this).attr('src')).toString());
                  $(this).removeAttr('src');
                }
              });
  
              $('link[rel="stylesheet"]').replaceWith(function () {
                  return $('<style>').text(read($(this).attr("href")).toString());
              });
            } catch (error) {
                await loaderContext.emitError(error);
                return content;
            }

            return $.html();
          }
        },
      },
    ]
  },
  devtool: 'nosources-source-map',
  infrastructureLogging: {
    level: "log", // enables logging required for problem matchers
  },
  optimization: {
    minimize: false, // Disable minification for the entire bundle
  },
};
module.exports = [dictionaryConfig, webviewConfig, extensionConfig];
