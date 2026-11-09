import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
test('package, lock root, manifest and README agree on version 1.2.0',()=>{
 const pkg=JSON.parse(fs.readFileSync('package.json'));const lock=JSON.parse(fs.readFileSync('package-lock.json'));const manifest=JSON.parse(fs.readFileSync('manifest.json'));
 assert.equal(manifest.version,'1.2.0');for(const v of [pkg.version,lock.version,lock.packages[''].version])assert.equal(v,manifest.version);
 assert.match(fs.readFileSync('README.md','utf8'),/1\.2\.0/);
});
test('upstream attribution, license and pinned commit are preserved in the vendored directory',()=>{
 const license=fs.readFileSync('src/vendor/style-html-viewer/LICENSE','utf8');
 assert.match(license,/MIT License/);
 const notice=fs.readFileSync('src/vendor/style-html-viewer/NOTICE.md','utf8');
 assert.match(notice,/taihoe\/style-html-viewer/);
 assert.match(notice,/708c18c7518d72ac7917f85fbe03c466652263a9/);
 assert.match(notice,/v?1\.0\.6/);
 assert.match(fs.readFileSync('LICENSE','utf8'),/MIT License/);
});
test('dependencies needed by the vendored engine are declared',()=>{
 const pkg=JSON.parse(fs.readFileSync('package.json'));
 for(const dep of ['postcss','postcss-value-parser'])assert.ok(pkg.dependencies[dep],dep);
});
