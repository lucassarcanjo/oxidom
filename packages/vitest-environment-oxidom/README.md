# vitest-environment-oxidom

Lets Vitest resolve `environment: 'oxidom'`. The environment itself lives in [oxidom](https://www.npmjs.com/package/oxidom).

```bash
npm install --save-dev oxidom vitest-environment-oxidom
```

```ts
// vitest.config.ts
export default defineConfig({
  test: {
    environment: 'oxidom', // was: 'jsdom'
  },
})
```

## License

MIT
