// jest-environment-jsdom 30 on jsdom 30. Its `userAgent` option builds a `ResourceLoader`, which jsdom 28
// replaced with a plain `resources` object: this shim hands that object back.
const Base = require('@jest/environment-jsdom-abstract').default;

const jsdom = {
  ...require('jsdom'),
  ResourceLoader: class {
    constructor(options) {
      return options;
    }
  },
};

module.exports = class JSDOM30Environment extends Base {
  constructor(config, context) {
    super(config, context, jsdom);
  }
};
