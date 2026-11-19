import assert from 'node:assert/strict';
import { parseLayer, parseStack, packParams, hlslDeclarations, injectDeclarations, parseDefault, libraryStride, packMaterialParams } from '../src/core/shader-stack.js';

export function registerShaderStackTests(test) {
  test('shader stack: property annotation parsing', () => {
    const code = `//@property float strength = 0.5 [0,1] "림 강도"
//@property float3 tint = (1,0,0) "색상"
//@property bool active = true "활성"
//@property int steps = 4 [2,8] "단계"
//@property color glow = #ff8800 "발광"
void RimLight(inout ShadingContext ctx) { ctx.color += tint * strength; }`;
    const info = parseLayer(code);
    assert.equal(info.name, 'RimLight');
    assert.deepEqual(info.errors, []);
    assert.equal(info.properties.length, 5);
    const [strength, tint, active, steps, glow] = info.properties;
    assert.deepEqual({ type: strength.type, default: strength.default, min: strength.min, max: strength.max, label: strength.label },
      { type: 'float', default: 0.5, min: 0, max: 1, label: '림 강도' });
    assert.deepEqual(tint.default, [1, 0, 0]);
    assert.equal(active.default, 1);
    assert.equal(steps.default, 4);
    assert.deepEqual(glow.default, [1, 0x88 / 255, 0]);
  });

  test('shader stack: signature validation and defaults', () => {
    assert.ok(parseLayer('float4 bad(inout ShadingContext ctx){return 0;}').errors.length > 0);
    assert.ok(parseLayer('void NoCtx(float x){}').errors.length > 0);
    assert.equal(parseLayer('void Ok(inout ShadingContext ctx){}').name, 'Ok');
    assert.deepEqual(parseDefault('float2', '(0.25,0.75)'), [0.25, 0.75]);
    assert.deepEqual(parseDefault('float4', '1,2,3,4'), [1, 2, 3, 4]);
    assert.equal(parseDefault('bool', 'false'), 0);
  });

  test('shader stack: global slot layout and parameter packing', () => {
    const layers = [
      { id: 'a', name: 'A', code: '//@property float x = 0.5 [0,1] "X"\nvoid A(inout ShadingContext ctx){}', enabled: true },
      { id: 'b', name: 'B', code: '//@property float3 c = (1,1,1) "C"\n//@property float y = 2 [0,4] "Y"\nvoid B(inout ShadingContext ctx){}', enabled: true },
    ];
    const { layers: parsed, slotCount } = parseStack(layers);
    assert.equal(slotCount, 3);
    assert.equal(parsed[0].properties[0].slot, 0);
    assert.equal(parsed[1].properties[0].slot, 1);
    assert.equal(parsed[1].properties[1].slot, 2);
    // Defaults pack into float4 slots.
    const def = packParams(layers, {});
    assert.equal(def.length, 12);
    assert.equal(def[0], 0.5);
    assert.deepEqual([...def.slice(4, 7)], [1, 1, 1]);
    assert.equal(def[8], 2);
    // Overrides replace defaults; arrays fill components.
    const mod = packParams(layers, { a: { x: 0.9 }, b: { c: [0, 0.5, 1] } });
    assert.ok(Math.abs(mod[0] - 0.9) < 1e-6); // Float32 storage
    assert.deepEqual([...mod.slice(4, 7)], [0, 0.5, 1]);
    assert.equal(mod[8], 2);
  });

  test('shader stack: per-material stride packing (Unity instances)', () => {
    const stackA = { name: 'A', outline: false, layers: [{ id: 'a', name: 'A', code: '//@property float x = 0.5 [0,1] "X"\nvoid A(inout ShadingContext ctx){}', enabled: true }] };
    const stackB = { name: 'B', outline: false, layers: [{ id: 'b', name: 'B', code: '//@property float3 c = (1,1,1) "C"\n//@property float y = 2 [0,4] "Y"\nvoid B(inout ShadingContext ctx){}', enabled: true }] };
    const library = [stackA, stackB];
    const stride = libraryStride(library); // max slotCount = 2 (stack B)
    assert.equal(stride, 2);
    // Local slots are 0-based per stack; runtime index adds materialId*stride.
    assert.match(hlslDeclarations(parseStack(stackB.layers).layers[0], stride), /float3 c = userParams\[materialId\*2 \+ 0\]\.xyz;/);
    // Two native materials: mat0 -> stackA (x=0.25), mat1 -> stackB (c=[.1,.2,.3], y=3).
    const instances = [{ stackId: 1, params: { a: { x: 0.25 } } }, { stackId: 2, params: { b: { c: [0.1, 0.2, 0.3], y: 3 } } }];
    const panelIndices = [0, 1]; // nativeId -> panel index
    const data = packMaterialParams(library, instances, panelIndices, stride, 2);
    // mat0 region base 0: x at slot 0.
    assert.ok(Math.abs(data[0] - 0.25) < 1e-6);
    // mat1 region base 2: c at slot 2 (offset 8), y at slot 3 (offset 12).
    assert.ok(Math.abs(data[8] - 0.1) < 1e-6 && Math.abs(data[9] - 0.2) < 1e-6 && Math.abs(data[10] - 0.3) < 1e-6);
    assert.ok(Math.abs(data[12] - 3) < 1e-6);
  });

  test('shader stack: HLSL declaration injection', () => {
    const layer = { id: 'a', name: 'A', code: '//@property float x = 0.5 [0,1] "X"\n//@property int n = 3 [1,8] "N"\nvoid A(inout ShadingContext ctx){ ctx.color *= x; }', enabled: true };
    const parsed = parseStack([layer]).layers[0];
    const decls = hlslDeclarations(parsed, 4);
    assert.match(decls, /float x = userParams\[materialId\*4 \+ 0\]\.x;/);
    assert.match(decls, /int n = \(int\)userParams\[materialId\*4 \+ 1\]\.x;/);
    const injected = injectDeclarations(layer.code, parsed, 4);
    // Declarations land inside the body, exactly one opening brace.
    assert.match(injected, /void A\(inout ShadingContext ctx\)\s*\{\n\s*float x = userParams\[materialId\*4 \+ 0\]\.x;/);
    assert.equal((injected.match(/\{/g) || []).length, 1);
    assert.ok(injected.includes('ctx.color *= x;'));
  });
}
