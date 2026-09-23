const ignores = require('./eslint.ignores.cjs');

module.exports = [
  {ignores},
  ...require('gts'),
  {
    // node:test's test() and describe() return promises the runner tracks.
    files: ['test/**/*.ts'],
    rules: {'@typescript-eslint/no-floating-promises': 'off'},
  },
];
