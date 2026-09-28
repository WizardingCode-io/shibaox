// The published dashboard is plain JS: OpenTUI's Solid transform skips files under
// node_modules, so an npm install cannot run our TSX; the monorepo still runs `src` directly.
// the plugin file is not among the package's exports: found next to its exported preload
const preload = Bun.resolveSync('@opentui/solid/preload', import.meta.dir);
const { createSolidTransformPlugin } = (await import(
  preload.replace(/preload\.js$/, 'solid-plugin.js')
)) as { createSolidTransformPlugin: () => Bun.BunPlugin };

const result = await Bun.build({
  entrypoints: ['src/main.tsx'],
  outdir: 'dist',
  target: 'bun',
  format: 'esm',
  packages: 'external',
  sourcemap: 'linked',
  plugins: [createSolidTransformPlugin()],
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log(
  `dashboard built: ${result.outputs.map((o) => o.path.split('/').slice(-2).join('/')).join(', ')}`,
);
