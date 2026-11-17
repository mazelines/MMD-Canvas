// GPU-only presentation copy. All scene rendering/shading remains in native DX12.
// Canvas2D must never retain the external DX12 VideoFrame: it can defer sampling
// it beyond drawImage/RAF. Copy to Chromium-owned storage and wait for that GPU
// copy before returning the external frame to the native producer.
class GpuPresenter {
  constructor() { this.initializing = null; }
  async initialize() {
    if (!this.initializing) {
      this.initializing = (async () => {
        const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
        if (!adapter || adapter.info.isFallbackAdapter) throw new Error('Failed to copy shared texture: GPU is not available');
        const device = await adapter.requestDevice();
        const canvas = new OffscreenCanvas(1, 1);
        const context = canvas.getContext('webgpu');
        context.configure({ device, format: navigator.gpu.getPreferredCanvasFormat(), alphaMode: 'opaque',
          usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
        const state = { device, canvas, context, lost: false };
        device.lost.then(() => { state.lost = true; this.initializing = null; });
        return state;
      })().catch(error => { this.initializing = null; throw error; });
    }
    return this.initializing;
  }
  async copy(frame) {
    const state = await this.initialize();
    const { device, canvas, context } = state;
    if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
      canvas.width = frame.displayWidth; canvas.height = frame.displayHeight;
    }
    device.pushErrorScope('validation');
    let copyError;
    try {
      device.queue.copyExternalImageToTexture({ source: frame }, { texture: context.getCurrentTexture() }, [canvas.width, canvas.height]);
      await device.queue.onSubmittedWorkDone();
    } catch (error) { copyError = error; }
    let validation;
    try { validation = await device.popErrorScope(); } catch (error) { copyError ||= error; }
    if (state.lost || copyError?.name === 'OperationError') throw new Error('Failed to copy shared texture: GPU is not available');
    if (copyError || validation) throw copyError || new Error(validation.message);
    return canvas;
  }
}
module.exports = { GpuPresenter };
