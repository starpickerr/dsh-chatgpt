import { build } from 'esbuild'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'

await mkdir('lib/licenses', { recursive: true })
await mkdir('.local/artifacts', { recursive: true })
await build({
  entryPoints: ['src/index.js'], outfile: 'lib/index.js',
  bundle: true, external: ['@deepseek-ai/*', 'zod'], platform: 'node', target: 'node24', format: 'esm',
})
const client = await build({
  entryPoints: ['src/client.jsx'], bundle: true, external: ['react', '@deepseek-ai/dsh-client-ui-primitives'],
  loader: { '.css': 'text' }, platform: 'browser', target: 'es2022', format: 'cjs', write: false,
})
await writeFile('lib/client.js',
  'window.__ModuleLoader__.load({id:"@alcor/chatgpt",factory(require){const module={exports:{}};const exports=module.exports;\n'
  + client.outputFiles[0].text + '\nreturn module.exports;}});\n')
for (const [name, license] of [['jose', 'LICENSE.md'], ['eventsource-parser', 'LICENSE'], ['@deepseek-ai/dsh-typert-protocol', 'LICENSE'], ['zod', 'LICENSE']]) {
  await copyFile('node_modules/' + name + '/' + license, 'lib/licenses/' + name.split('/').at(-1) + '.txt')
}
