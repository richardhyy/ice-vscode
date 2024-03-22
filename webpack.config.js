const CopyPlugin = require("copy-webpack-plugin");

//@ts-check

'use strict';

const path = require('path');

//@ts-check
/** @typedef {import('webpack').Configuration} WebpackConfig **/

/** @type WebpackConfig */
const extensionConfig = {
  target: 'node', // VS Code extensions run in a Node.js-context 📖 -> https://webpack.js.org/configuration/node/
	mode: 'none', // this leaves the source code as close as possible to the original (when packaging we set this to 'production')

  entry: './src/extension.ts', // the entry point of this extension, 📖 -> https://webpack.js.org/configuration/entry-context/
  output: {
    // the bundle is stored in the 'dist' folder (check package.json), 📖 -> https://webpack.js.org/configuration/output/
    path: path.resolve(__dirname, 'dist'),
    filename: 'extension.js',
    libraryTarget: 'commonjs2'
    },
    plugins: [
    new CopyPlugin({
      patterns: [
      {
        from: './providers',
        to: 'providers',
      }
      ]
    })
    ],
  externals: {
    vscode: 'commonjs vscode' // the vscode-module is created on-the-fly and must be excluded. Add other modules that cannot be webpack'ed, 📖 -> https://webpack.js.org/configuration/externals/
    // modules added here also need to be added in the .vscodeignore file
  },
  resolve: {
    // support reading TypeScript and JavaScript files, 📖 -> https://github.com/TypeStrong/ts-loader
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
        loader: "html-loader",
        options: {
          preprocessor: async (content, loaderContext) => {
              const $ = require('cheerio').load(content);
              const fs = require('fs');
              const path = require('path');

              const read = (p) => fs.readFileSync(path.resolve(loaderContext.context, p));

              try {
                  $('script').each(function () {
                    if ($(this).attr("src")) {
                      $(this).text(read($(this).attr("src")).toString());
                      $(this).removeAttr("src");
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
module.exports = [ extensionConfig ];