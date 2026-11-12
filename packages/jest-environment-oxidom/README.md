# jest-environment-oxidom

Lets Jest resolve `testEnvironment: 'oxidom'`. It's a port of `jest-environment-jsdom` on top of
[oxidom](https://www.npmjs.com/package/oxidom).

```bash
npm install --save-dev oxidom jest-environment-oxidom
```

```js
// jest.config.js
module.exports = {
  testEnvironment: 'oxidom', // was: 'jsdom'
};
```

## License

MIT
