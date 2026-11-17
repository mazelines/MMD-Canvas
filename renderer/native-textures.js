import * as THREE from 'three';

// Encodings are shared with native/dx12/renderer.h. Compressed blocks and their
// original mip levels go directly to DX12; no browser 3D context is needed.
const BLOCK_FORMATS = new Map([
  [THREE.RGB_S3TC_DXT1_Format, 1], [THREE.RGBA_S3TC_DXT1_Format, 1],
  [THREE.RGBA_S3TC_DXT3_Format, 2], [THREE.RGBA_S3TC_DXT5_Format, 3],
  [THREE.RGB_BPTC_SIGNED_Format, 4], [THREE.RGB_BPTC_UNSIGNED_Format, 5],
  [THREE.RGBA_BPTC_Format, 6],
]);

export function nativeTexture(texture) {
  const image = texture.source?.data || texture.image;
  if (!image || !(image.width || image.videoWidth) || image.complete === false) return null;
  const width = image.width || image.videoWidth, height = image.height || image.videoHeight;
  if (texture.isCompressedTexture) {
    if (!texture.mipmaps.length) return null;
    const encoding = BLOCK_FORMATS.get(texture.format);
    if (encoding) return { width, height, encoding, mips: texture.mipmaps.map(m => m.data) };
    // DDSLoader also uses CompressedTexture for uncompressed RGBA DDS images.
    if (texture.format === THREE.RGBAFormat) return { width, height, encoding: 0, mips: [texture.mipmaps[0].data] };
    throw new Error(`DX12에서 지원하지 않는 압축 텍스처 형식입니다: ${texture.format}`);
  }
  if ('data' in image && !image.data) return null;
  if (image.data) {
    const count = width * height, channels = image.data.length / count, out = new Uint8Array(count * 4);
    if (![1, 2, 3, 4].includes(channels)) throw new Error('Invalid native texture channels');
    const value = i => texture.type === THREE.HalfFloatType ? THREE.DataUtils.fromHalfFloat(image.data[i]) * 255
      : image.data instanceof Float32Array ? image.data[i] * 255 : image.data[i];
    for (let i = 0; i < count; i++) for (let c = 0; c < 4; c++)
      out[i * 4 + c] = c === 3 && channels < 4 ? 255 : Math.round(Math.max(0, Math.min(255, value(i * channels + Math.min(c, channels - 1)))));
    return { width, height, encoding: 0, mips: [out] };
  }
  const canvas = new OffscreenCanvas(width, height), ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, 0, 0);
  return { width, height, encoding: 0, mips: [ctx.getImageData(0, 0, width, height).data] };
}
