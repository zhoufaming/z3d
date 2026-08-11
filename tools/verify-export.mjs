import { readThreeMF, flattenObject } from '../src/core/threemf/reader.js';
import fs from 'fs';

const path = process.argv[2] || '.playwright-cli/sample-bambu-edited.3mf';
const buf = fs.readFileSync(path);
const file = new File([buf], 'sample-bambu-edited.3mf', { type: 'application/zip' });
const doc = await readThreeMF(file);

let parts = 0;
let tris = 0;
for (const item of doc.root.build) {
  const flat = flattenObject(doc, item.objectid, null);
  parts += flat.length;
  for (const f of flat) tris += (f.mesh.triangles ? f.mesh.triangles.length : f.mesh.indices.length) / 3;
}

console.log('build items:', doc.root.build.length);
console.log('objects in 3dmodel:', doc.root.objects.size);
console.log('parts:', parts);
console.log('triangles:', tris);
console.log('model_settings objects:', Object.keys(doc.settings).length);
console.log('OK: exported 3MF roundtrip-parses');
