/**
 * 生成仿 Bambu Studio 格式的测试 3mf，用于端到端验证读取/编辑/导出链路。
 * 用法：node tools/make-sample.mjs
 */
import { zipSync, strToU8 } from 'fflate';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../samples');

function box(w, d, h) {
  const x = w / 2, y = d / 2, z = h / 2;
  const v = [
    [-x, -y, -z], [x, -y, -z], [x, y, -z], [-x, y, -z],
    [-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z],
  ];
  const t = [
    [0, 2, 1], [0, 3, 2], // bottom
    [4, 5, 6], [4, 6, 7], // top
    [0, 1, 5], [0, 5, 4],
    [1, 2, 6], [1, 6, 5],
    [2, 3, 7], [2, 7, 6],
    [3, 0, 4], [3, 4, 7],
  ];
  return { v, t };
}

function prism(radius, height, sides) {
  const v = [];
  const t = [];
  const z = height / 2;
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    v.push([Math.cos(a) * radius, Math.sin(a) * radius, -z]);
  }
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    v.push([Math.cos(a) * radius, Math.sin(a) * radius, z]);
  }
  const cb = v.push([0, 0, -z]) - 1;
  const ct = v.push([0, 0, z]) - 1;
  for (let i = 0; i < sides; i++) {
    const n = (i + 1) % sides;
    t.push([cb, n, i]);
    t.push([ct, sides + i, sides + n]);
    t.push([i, n, sides + n]);
    t.push([i, sides + n, sides + i]);
  }
  return { v, t };
}

function meshXml(mesh) {
  const vs = mesh.v
    .map((p) => `     <vertex x="${p[0]}" y="${p[1]}" z="${p[2]}"/>`)
    .join('\n');
  const ts = mesh.t
    .map((f) => `     <triangle v1="${f[0]}" v2="${f[1]}" v3="${f[2]}"/>`)
    .join('\n');
  return `   <mesh>\n    <vertices>\n${vs}\n    </vertices>\n    <triangles>\n${ts}\n    </triangles>\n   </mesh>`;
}

const uuid = () =>
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });

const CORE = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
const PROD = 'http://schemas.microsoft.com/3dmanufacturing/production/2015/06';
const BBS = 'http://schemas.bambulab.com/package/2021';
const header = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="${CORE}" xmlns:BambuStudio="${BBS}" xmlns:p="${PROD}" requiredextensions="p">`;

// object_1.model：单零件立方体
const obj1 = `${header}
 <resources>
  <object id="1" p:UUID="${uuid()}" type="model">
${meshXml(box(24, 24, 24))}
  </object>
 </resources>
 <build/>
</model>
`;

// object_2.model：双零件（底座 + 立柱），用于验证多 part 与逐零件料槽
const obj2 = `${header}
 <resources>
  <object id="3" p:UUID="${uuid()}" type="model">
${meshXml(box(44, 44, 6))}
  </object>
  <object id="4" p:UUID="${uuid()}" type="model">
${meshXml(prism(9, 30, 16))}
  </object>
 </resources>
 <build/>
</model>
`;

const model = `${header}
 <metadata name="Application">BambuStudio-01.09.05.51</metadata>
 <metadata name="BambuStudio:3mfVersion">1</metadata>
 <metadata name="Copyright"></metadata>
 <metadata name="CreationDate">2026-08-10</metadata>
 <metadata name="Description"></metadata>
 <metadata name="Designer"></metadata>
 <metadata name="DesignerCover"></metadata>
 <metadata name="DesignerUserId">10086</metadata>
 <metadata name="License"></metadata>
 <metadata name="ModificationDate">2026-08-10</metadata>
 <metadata name="Origin"></metadata>
 <metadata name="Title">Sample Project</metadata>
 <resources>
  <object id="2" p:UUID="${uuid()}" type="model">
   <components>
    <component p:path="/3D/Objects/object_1.model" objectid="1" p:UUID="${uuid()}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>
   </components>
  </object>
  <object id="5" p:UUID="${uuid()}" type="model">
   <components>
    <component p:path="/3D/Objects/object_2.model" objectid="3" p:UUID="${uuid()}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>
    <component p:path="/3D/Objects/object_2.model" objectid="4" p:UUID="${uuid()}" transform="1 0 0 0 1 0 0 0 1 0 0 18"/>
   </components>
  </object>
 </resources>
 <build p:UUID="${uuid()}">
  <item objectid="2" p:UUID="${uuid()}" transform="1 0 0 0 1 0 0 0 1 90 128 12" printable="1"/>
  <item objectid="5" p:UUID="${uuid()}" transform="1 0 0 0 1 0 0 0 1 170 128 3" printable="1"/>
 </build>
</model>
`;

const modelSettings = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <object id="2">
    <metadata key="name" value="校准立方体"/>
    <metadata key="extruder" value="1"/>
    <part id="1" subtype="normal_part">
      <metadata key="name" value="cube.stl"/>
      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>
      <metadata key="source_file" value="cube.stl"/>
      <metadata key="source_object_id" value="0"/>
      <metadata key="source_volume_id" value="0"/>
      <mesh_stat edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/>
    </part>
  </object>
  <object id="5">
    <metadata key="name" value="双色底座"/>
    <metadata key="extruder" value="2"/>
    <part id="3" subtype="normal_part">
      <metadata key="name" value="base.stl"/>
      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>
      <metadata key="extruder" value="2"/>
      <mesh_stat edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/>
    </part>
    <part id="4" subtype="normal_part">
      <metadata key="name" value="pillar.stl"/>
      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 18 1"/>
      <metadata key="extruder" value="3"/>
      <mesh_stat edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/>
    </part>
  </object>
  <plate>
    <metadata key="plater_id" value="1"/>
    <metadata key="plater_name" value=""/>
    <metadata key="locked" value="false"/>
    <metadata key="thumbnail_file" value="Metadata/plate_1.png"/>
    <metadata key="top_file" value="Metadata/top_1.png"/>
    <metadata key="pick_file" value="Metadata/pick_1.png"/>
    <model_instance>
      <metadata key="object_id" value="2"/>
      <metadata key="instance_id" value="0"/>
      <metadata key="identify_id" value="463"/>
    </model_instance>
    <model_instance>
      <metadata key="object_id" value="5"/>
      <metadata key="instance_id" value="0"/>
      <metadata key="identify_id" value="521"/>
    </model_instance>
  </plate>
  <assemble>
   <assemble_item object_id="2" instance_id="0" transform="1 0 0 0 1 0 0 0 1 90 128 12" offset="0 0 0" />
   <assemble_item object_id="5" instance_id="0" transform="1 0 0 0 1 0 0 0 1 170 128 3" offset="0 0 0" />
  </assemble>
</config>
`;

const projectSettings = {
  printer_model: 'Bambu Lab P1S',
  printer_settings_id: 'Bambu Lab P1S 0.4 nozzle',
  printable_area: ['0x0', '256x0', '256x256', '0x256'],
  printable_height: '250',
  filament_colour: ['#00AE42', '#FFFFFF', '#F72323', '#0A2989'],
  filament_type: ['PLA', 'PLA', 'PETG', 'PLA'],
  filament_settings_id: ['Bambu PLA Basic', 'Bambu PLA Basic', 'Bambu PETG HF', 'Bambu PLA Basic'],
  layer_height: '0.2',
  sparse_infill_density: '15%',
  nozzle_diameter: ['0.4'],
};

const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
 <Default Extension="png" ContentType="image/png"/>
 <Default Extension="gcode" ContentType="text/x.gcode"/>
</Types>`;

const rootRels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
 <Relationship Target="/Metadata/plate_1.png" Id="rel-2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail"/>
</Relationships>`;

const modelRels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/Objects/object_1.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
 <Relationship Target="/3D/Objects/object_2.model" Id="rel-2" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

// 1x1 透明 PNG，占位缩略图，验证二进制条目能否原样保留
const pngStub = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
);

const files = {
  '[Content_Types].xml': strToU8(contentTypes),
  '_rels/.rels': strToU8(rootRels),
  '3D/3dmodel.model': strToU8(model),
  '3D/_rels/3dmodel.model.rels': strToU8(modelRels),
  '3D/Objects/object_1.model': strToU8(obj1),
  '3D/Objects/object_2.model': strToU8(obj2),
  'Metadata/model_settings.config': strToU8(modelSettings),
  'Metadata/project_settings.config': strToU8(JSON.stringify(projectSettings, null, 4)),
  'Metadata/slice_info.config': strToU8('<?xml version="1.0"?>\n<config><header/></config>\n'),
  'Metadata/plate_1.png': pngStub,
};

mkdirSync(outDir, { recursive: true });
const out = resolve(outDir, 'sample-bambu.3mf');
writeFileSync(out, zipSync(files, { level: 6 }));
console.log('已生成', out);

// 第二个样例：单个大圆柱，用于测试多文件组合
const obj3 = `${header}
 <resources>
  <object id="1" p:UUID="${uuid()}" type="model">
${meshXml(prism(18, 50, 32))}
  </object>
 </resources>
 <build/>
</model>
`;
const model2 = `${header}
 <metadata name="Application">BambuStudio-01.09.05.51</metadata>
 <metadata name="BambuStudio:3mfVersion">1</metadata>
 <metadata name="Title">Cylinder</metadata>
 <resources>
  <object id="2" p:UUID="${uuid()}" type="model">
   <components>
    <component p:path="/3D/Objects/object_1.model" objectid="1" p:UUID="${uuid()}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>
   </components>
  </object>
 </resources>
 <build p:UUID="${uuid()}">
  <item objectid="2" p:UUID="${uuid()}" transform="1 0 0 0 1 0 0 0 1 128 128 25" printable="1"/>
 </build>
</model>
`;
const modelSettings2 = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <object id="2">
    <metadata key="name" value="圆柱体"/>
    <metadata key="extruder" value="4"/>
    <part id="1" subtype="normal_part">
      <metadata key="name" value="cylinder.stl"/>
      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>
      <metadata key="extruder" value="4"/>
    </part>
  </object>
  <plate>
    <metadata key="plater_id" value="1"/>
    <model_instance>
      <metadata key="object_id" value="2"/>
      <metadata key="instance_id" value="0"/>
    </model_instance>
  </plate>
</config>
`;
writeFileSync(
  resolve(outDir, 'sample-cylinder.3mf'),
  zipSync(
    {
      '[Content_Types].xml': strToU8(contentTypes),
      '_rels/.rels': strToU8(rootRels),
      '3D/3dmodel.model': strToU8(model2),
      '3D/_rels/3dmodel.model.rels': strToU8(
        modelRels.replace(/ <Relationship Target="\/3D\/Objects\/object_2\.model"[^>]*>\n/, ''),
      ),
      '3D/Objects/object_1.model': strToU8(obj3),
      'Metadata/model_settings.config': strToU8(modelSettings2),
      'Metadata/project_settings.config': strToU8(JSON.stringify(projectSettings, null, 4)),
    },
    { level: 6 },
  ),
);
console.log('已生成', resolve(outDir, 'sample-cylinder.3mf'));
