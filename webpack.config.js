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
  name: 'providers',
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
        const commentHeader = fileContent.match(/\/\/\s==ICEProvider==[\s\S]*?\/\/\s==\/ICEProvider==/)[0];
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

// Tools configuration. ICE tools are self-describing JS scripts (see tools/) that
// run in child processes. Bundling them here lets a tool pull in npm dependencies
// (e.g. the MCP SDK) that are inlined into the tool's own bundle, keeping them out
// of the core extension. Each tool's `==ICETool==` header is preserved as a banner
// so it can still be parsed statically.
const toolsConfig = {
  name: 'tools',
  target: 'node',
  mode: 'none',
  entry: glob.sync('./tools/*/main.js').reduce((acc, filePath) => {
    const toolName = path.basename(path.dirname(filePath));
    acc[toolName] = './' + filePath;
    return acc;
  }, {}),
  output: {
    path: path.resolve(__dirname, 'dist_tools'),
    filename: '[name]/main.js',
    libraryTarget: 'commonjs2'
  },
  plugins: [
    new webpack.BannerPlugin({
      banner: (pathData) => {
        // @ts-ignore
        const filePath = pathData.chunk.entryModule.resource;
        const fileContent = fs.readFileSync(filePath, 'utf8');
        const match = fileContent.match(/\/\/\s==ICETool==[\s\S]*?\/\/\s==\/ICETool==/);
        return match ? match[0] : '';
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
  name: 'webview',
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
  name: 'extension',
  // The extension bundle copies dist_providers/dist_tools and inlines dist_webview
  // at build time, so those configs must finish first.
  dependencies: ['providers', 'tools', 'webview'],
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
        {
          // Bundled tools (produced by toolsConfig), including any with npm deps.
          from: './dist_tools',
          to: 'tools',
        },
        {
          // The tool harness is dependency-free and runs the bundled tools.
          from: './tools/_host.js',
          to: 'tools/_host.js',
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
module.exports = [dictionaryConfig, toolsConfig, webviewConfig, extensionConfig];
