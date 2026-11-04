import {readFile,readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
const manifest=JSON.parse(await readFile('extension/manifest.json','utf8'));
assert.equal(manifest.manifest_version,3);
assert.deepEqual([...manifest.permissions].sort(),['alarms','storage','tabGroups','tabs']);
assert.ok(!manifest.content_scripts && !manifest.host_permissions && !manifest.externally_connectable);
for(const dir of ['extension','scripts','tests'])for(const file of await readdir(dir))if(/\.(mjs|js)$/.test(file)){
  const result=spawnSync(process.execPath,['--check',`${dir}/${file}`],{encoding:'utf8'});
  assert.equal(result.status,0,`${file}: ${result.stderr}`);
}
for(const file of ['popup.html','options.html']){
  const html=await readFile(`extension/${file}`,'utf8');assert.doesNotMatch(html,/on(?:click|load|error)=|<script[^>]+https?:/i);
}
console.log('Syntax, manifest and extension CSP checks passed.');
