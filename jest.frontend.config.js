// Frontend unit-test config. Runs the pure browser helpers (public/js/wo-util.js
// and friends) under a jsdom environment so DOM/URL globals exist. Kept separate
// from the backend suite (package.json "jest" key, rootDir=src, ts-jest): here
// the files are plain CommonJS-compatible JS, so no transform is needed.
module.exports = {
  rootDir: '.',
  testEnvironment: 'jsdom',
  testMatch: ['<rootDir>/test-frontend/**/*.spec.js'],
  transform: {},
};
