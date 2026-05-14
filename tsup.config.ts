import {defineConfig} from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts', 'src/worker-wrapper.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  minify: true,
  splitting: false,
  sourcemap: true,
  target: 'node22',
  outDir: 'dist'
});
