import assert from 'node:assert/strict';
import * as THREE from 'three';
import { nativeTexture } from '../renderer/native-textures.js';
import { nativeModel } from '../renderer/dx12.js';

export function registerNativeRendererTests(test) {
  test('DX12 textures: block-compressed DDS mips are preserved without a browser context', () => {
    const mips = [{width:8,height:8,data:new Uint8Array(32)}, {width:4,height:4,data:new Uint8Array(8)}];
    const texture = new THREE.CompressedTexture(mips,8,8,THREE.RGB_S3TC_DXT1_Format);
    const result = nativeTexture(texture);
    assert.equal(result.encoding,1);assert.equal(result.mips[0],mips[0].data);assert.equal(result.mips[1],mips[1].data);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(),new THREE.MeshLambertMaterial({map:texture}));
    const packet=nativeModel(mesh),head=new Uint32Array(packet,0,4);
    const offset=16+head[0]*32+head[1]*16+head[2]*128,header=new Uint32Array(packet,offset,6);
    assert.deepEqual([...header],[8,8,0,1,2,32]);
    assert.equal(new DataView(packet).getUint32(offset+24+32,true),8);
    texture.format=THREE.RGB_ETC1_Format;
    assert.throws(()=>nativeTexture(texture),/DX12/);
  });
  test('DX12 textures: loading placeholders, RGBA DDS and half-float data are handled explicitly', () => {
    assert.equal(nativeTexture(new THREE.DataTexture(null,1,1)),null);
    const rgba=new Uint8Array([128,64,32,255]);
    const dds=new THREE.CompressedTexture([{width:1,height:1,data:rgba}],1,1,THREE.RGBAFormat);
    assert.equal(nativeTexture(dds).mips[0],rgba);
    const half=new THREE.DataTexture(new Uint16Array([0x3800,0x3c00,0,0x3c00]),1,1,THREE.RGBAFormat,THREE.HalfFloatType);
    assert.deepEqual([...nativeTexture(half).mips[0]],[128,255,0,255]);
  });
  test('DX12 scene: empty and hidden scenes retain valid matching pose packets', () => {
    const mesh=new THREE.Mesh(new THREE.BoxGeometry(),new THREE.MeshLambertMaterial({visible:false}));
    for(const root of [new THREE.Group(),mesh]){
      const packet=nativeModel(root),header=new Uint32Array(packet,0,4),pose=nativeModel(root,true);
      assert.ok(header[0]>0);assert.equal(header[1],1);assert.equal(pose.byteLength,header[0]*32);
      const triangle=new Uint32Array(packet,16+header[0]*32,4);assert.equal(triangle[0],triangle[1]);assert.equal(triangle[1],triangle[2]);
    }
    const unsupported=new THREE.Mesh(new THREE.BoxGeometry(),new THREE.ShaderMaterial());
    assert.throws(()=>nativeModel(unsupported),/DX12/);
  });
}
