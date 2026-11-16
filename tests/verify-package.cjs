// Runs after every pack/dist build, including CI and release builds.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const asar = require('@electron/asar');

function verifyPackage(archive, projectDir = path.resolve(__dirname, '..')) {
  const required = ['package.json', 'electron/main.js', 'electron/preload.cjs',
    'renderer/index.html', 'renderer/app.js', 'renderer/viewer.js'];
  // Check the complete runtime trees, including lazy loaders, their transitive
  // helpers and WASM assets. Checking only startup imports misses format failures.
  for (const directory of ['node_modules/three/build', 'node_modules/three/examples/jsm']) {
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
  // The first-launch example lives beside the executable; main.js resolves it as <resources>/../Example.
  for (const file of ['Zhuang Fangyi.canvas', 'Zhuang Fangyi.pmx', 'ReadMe.txt']) {
    assert.ok(fs.existsSync(path.join(resources, '..', 'Example', 'Zhuang Fangyi', file)), `Packaged example missing: ${file}`);
  }
};
module.exports.verifyPackage = verifyPackage;

if (require.main === module) {
  assert.ok(process.argv[2], 'Usage: node tests/verify-package.cjs <app.asar>');
  verifyPackage(path.resolve(process.argv[2]));
}
