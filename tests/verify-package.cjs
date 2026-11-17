// Runs after every pack/dist build, including CI and release builds.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const asar = require('@electron/asar');

function verifyPackage(archive, projectDir = path.resolve(__dirname, '..')) {
  const required = ['package.json', 'electron/main.js', 'electron/preload.cjs', 'electron/gpu-presenter.cjs',
    'renderer/index.html', 'renderer/app.js', 'renderer/viewer.js',
    'renderer/cortao.js', 'electron/dx12.js', 'renderer/dx12.js', 'renderer/native-textures.js',
    'node_modules/three/build/three.core.js', 'src/core/ambient-occlusion.js', 'licenses/CORTAO-MIT.txt'];
  // Check the complete runtime trees, including lazy loaders, their transitive
  // helpers and WASM assets. Checking only startup imports misses format failures.
  for (const directory of ['node_modules/three/examples/jsm']) {
    const walk = (relative) => {
      for (const entry of fs.readdirSync(path.join(projectDir, relative), { withFileTypes: true })) {
        const file = `${relative}/${entry.name}`;
        if (entry.isDirectory()) walk(file);
        else if (/\.(js|wasm)$/.test(entry.name)) required.push(file);
      }
    };
    walk(directory);
  }
  const files = new Set(asar.listPackage(archive).map(file => file.replace(/\\/g, '/').replace(/^\//, '')));
  for (const retired of ['renderer/shadows.js','renderer/color-pipeline.js','renderer/cortao-pass.js','renderer/hull-outline.js','renderer/photometric.js','node_modules/three/build/three.module.js']) {
    assert.ok(!files.has(retired), `Retired browser renderer must not ship: ${retired}`);
  }
  const missing = required.filter(file => !files.has(file));
  assert.equal(missing.length, 0, `Packaged runtime files missing (${missing.length}):\n${missing.slice(0,20).join('\n')}`);
  for (const file of required.filter(file => file !== 'package.json')) {
    assert.ok(asar.extractFile(archive, path.normalize(file)).equals(fs.readFileSync(path.join(projectDir, file))),
      `Packaged runtime file differs from source: ${file}`);
  }
  console.log(`Packaged runtime verified: ${required.length} files in ${archive}`);
}

module.exports = async ({ appOutDir, packager }) => {
  const resources = packager.getResourcesDir(appOutDir);
  verifyPackage(path.join(resources, 'app.asar'), packager.projectDir);
  verifyExample(path.join(packager.projectDir, 'Example'), path.join(resources, '..', 'Example'));
  for (const file of ['mmd-dx12.exe', 'vertexMain.cso', 'outlineVertex.cso', 'outlineMain.cso', 'normalMain.cso', 'colorMain.cso', 'packMain.cso', 'mipMain.cso', 'cortaoMain.cso', 'outputMain.cso', '32x32x24x32_R32_UINT.bin']) {
    const packaged=path.join(resources,'..','native','dx12',file);
    assert.ok(fs.existsSync(packaged),`Packaged DX12 runtime missing: ${file}`);
    assert.ok(fs.readFileSync(packaged).equals(fs.readFileSync(path.join(packager.projectDir,'out','dx12',file))),`Packaged DX12 runtime differs: ${file}`);
  }
  console.log('Packaged DX12 executable, shader bytecode and CORTAO LUT verified.');
};
module.exports.verifyPackage = verifyPackage;
function verifyExample(source, destination) {
  let count = 0;
  const walk = (relative = '') => {
    for (const entry of fs.readdirSync(path.join(source, relative), { withFileTypes: true })) {
      const name=path.join(relative,entry.name),target=path.join(destination,name);
      assert.ok(fs.existsSync(target), `Packaged Example missing: ${name}`);
      if(entry.isDirectory()) walk(name);
      else {
        assert.ok(fs.readFileSync(target).equals(fs.readFileSync(path.join(source,name))), `Packaged Example differs: ${name}`);
        count++;
      }
    }
  };
  walk();
  console.log(`Packaged Example verified: all ${count} files match the source.`);
  return count;
}
module.exports.verifyExample = verifyExample;

if (require.main === module) {
  assert.ok(process.argv[2], 'Usage: node tests/verify-package.cjs <app.asar>');
  verifyPackage(path.resolve(process.argv[2]));
}
