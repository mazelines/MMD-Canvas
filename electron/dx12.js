import { app, sharedTexture } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const GPU_RECOVERY_MS = 5000;
const GPU_RETRY_MS = 100;
// Electron may have a window before its main-thread raster context is usable,
// and recreates that context asynchronously after a GPU-process restart.
const gpuUnavailable = error => /shared texture.*GPU is not available/i.test(error.message);

/** Native DX12 owns all 3D passes; Chromium only presents its shared GPU texture. */
export class Dx12Host {
  constructor(root, getWindow) {
    this.root = root; this.getWindow = getWindow; this.child = null; this.pending = null;
    this.frames = new Set(); this.slotWaiters = new Set(); this.frameId = 0;
    // Serialize native-channel requests (renders and shader loads) so a shader
    // hot-swap never collides with an in-flight frame, without pausing the flush.
    this.chain = Promise.resolve();
  }
  serial(fn) { const p = this.chain.then(() => fn()); this.chain = p.then(() => {}, () => {}); return p; }
  get executable() { return app.isPackaged ? path.join(path.dirname(app.getPath('exe')), 'native/dx12/mmd-dx12.exe') : path.join(this.root, 'out/dx12/mmd-dx12.exe'); }
  get available() { return process.platform === 'win32' && fs.existsSync(this.executable); }
  async start() {
    if (this.capabilities && this.child) return this.capabilities;
    if (!this.available) throw new Error('DX12 실행 파일이 없습니다. npm run build:dx12로 빌드해 주세요.');
    this.child = spawn(this.executable, ['--serve', String(process.pid)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    this.child.stderr.on('data', b => { stderr = (stderr + b).slice(-8192); if (process.env.MMDCONV_DX12_VALIDATION) console.error(b.toString()); });
    const child = this.child;
    child.stdin.on('error', e => { if (this.child === child) this.fail(e); });
    this.child.on('error', e => { if(this.child === child) this.fail(e); });
    this.child.on('exit', code => { if(this.child !== child) return; this.child = null; this.capabilities = null; this.frames.clear(); this.fail(new Error(stderr.trim() || `DX12 renderer exited (${code})`)); });
    readline.createInterface({ input: this.child.stdout }).on('line', line => {
      if (this.child !== child) return;
      try { this.receive(JSON.parse(line), child).catch(e => { if (this.child === child) this.fail(e); }); } catch (e) { this.fail(e); }
    });
    const result = await this.wait('ready'); this.capabilities = result.capabilities; return this.capabilities;
  }
  fail(error) {
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(error); this.pending = null; }
    if (this.presentation) { clearTimeout(this.presentation.timer); this.presentation.reject(error); this.presentation = null; }
    for (const wake of this.slotWaiters) wake(error);
  }
  async waitForFrameSlot(owner) {
    if (!owner || owner !== this.child) throw new Error('DX12 renderer is not running');
    if (this.frames.size < 3) return;
    await new Promise((resolve, reject) => {
      const wake = error => {
        if (!error && owner === this.child && this.frames.size >= 3) return;
        clearTimeout(timer); this.slotWaiters.delete(wake);
        if (error || owner !== this.child) reject(error || new Error('DX12 renderer stopped'));
        else resolve();
      };
      const timer = setTimeout(() => wake(new Error('DX12 presentation did not return its GPU frame within 5 seconds')), GPU_RECOVERY_MS);
      this.slotWaiters.add(wake);
    });
  }
  presented(sender, id, error) {
    const p = this.presentation;
    if (!p || p.id !== id || p.owner !== this.child || sender !== this.getWindow()?.webContents) return;
    clearTimeout(p.timer); this.presentation = null;
    if (error) p.reject(new Error(String(error))); else p.resolve();
  }
  async present(imported, win, owner, id) {
    let acknowledgement;
    const displayed = new Promise((resolve, reject) => {
      acknowledgement = { id, owner, resolve, reject,
        timer: setTimeout(() => reject(new Error('DX12 presentation acknowledgement timed out')), 2000) };
      this.presentation = acknowledgement;
    });
    try {
      // Electron acknowledges transfer before the receiver has drawn the frame.
      // Wait for our receiver too, so a lost Canvas2D context cannot look successful.
      await Promise.all([sharedTexture.sendSharedTexture({ frame: win.webContents.mainFrame, importedSharedTexture: imported }, id), displayed]);
    } finally {
      clearTimeout(acknowledgement.timer);
      if (this.presentation === acknowledgement) this.presentation = null;
      acknowledgement.resolve();
    }
  }
  wait(type) {
    if (this.pending) throw new Error('DX12 request already in flight');
    return new Promise((resolve, reject) => {
      this.pending = { type, resolve, reject, timer: setTimeout(() => { this.fail(new Error(`DX12 ${type} timed out`)); this.stop(); }, 60000) };
    });
  }
  complete(value) { const p = this.pending; if (!p || p.type !== value.type) return; this.pending = null; clearTimeout(p.timer); p.resolve(value); }
  send(type, bytes = new ArrayBuffer(0)) {
    if (!this.child || this.child.stdin.destroyed || this.child.stdin.writableEnded) throw new Error('DX12 renderer is not running');
    const body = Buffer.from(bytes), header = Buffer.alloc(8); header.writeUInt32LE(type, 0); header.writeUInt32LE(body.byteLength, 4);
    this.child.stdin.write(header); if (body.length) this.child.stdin.write(body);
  }
  request(type, opcode, bytes) {
    const result = this.wait(type);
    try { this.send(opcode, bytes); } catch (error) { this.fail(error); }
    return result;
  }
  async model(bytes) { if (!(bytes instanceof ArrayBuffer) || bytes.byteLength > 512 * 1024 * 1024) throw new Error('Invalid native model packet'); return this.request('model', 1, bytes); }
  async pose(bytes) { if (!(bytes instanceof ArrayBuffer) || bytes.byteLength > 160 * 1024 * 1024) throw new Error('Invalid native pose packet'); return this.request('pose', 5, bytes); }
  // Hot-swap the character color PSOs with runtime-compiled blobs. Pass null to
  // restore the build-time default shader. Layout: u32 colorLen, color, u32 aaLen, aa.
  async shader(colorBlob, aaBlob) {
    let bytes;
    if (!colorBlob) bytes = new ArrayBuffer(0);
    else {
      const color = Buffer.from(colorBlob), aa = Buffer.from(aaBlob);
      const colorLen = Buffer.alloc(4), aaLen = Buffer.alloc(4);
      colorLen.writeUInt32LE(color.length, 0); aaLen.writeUInt32LE(aa.length, 0);
      bytes = Buffer.concat([colorLen, color, aaLen, aa]);
    }
    const result = await this.serial(() => this.request('shader', 6, bytes));
    if (!result.ok) throw new Error(result.error || 'Shader load failed');
    return result;
  }
  // Fire-and-forget: parameter uploads queue between renders on the single-threaded
  // native loop (fence-waited, so safe) and must not collide with the render channel.
  setParams(data) { if (!(data instanceof ArrayBuffer)) throw new Error('Invalid shader params'); this.send(7, data); }
  async render(bytes) {
    if (!(bytes instanceof ArrayBuffer) || bytes.byteLength !== 308) throw new Error('Invalid native frame packet');
    // Backpressure: the native command loop must stay free to receive release
    // messages instead of allocating more surfaces or exiting on pool exhaustion.
    const owner = this.child;
    try { await this.waitForFrameSlot(owner); }
    catch (error) {
      if (owner && owner === this.child) {
        this.logPresentation('pool-timeout', { error: error.message, retainedFrames: this.frames.size });
        this.stop();
      }
      throw error;
    }
    // A renderer reload resets its JS counter, while old GPU references can still
    // be returning. Host-issued IDs keep release messages unique across reloads.
    new Uint32Array(bytes, 0, 1)[0] = ++this.frameId;
    return this.serial(() => this.request('frame', 2, bytes));
  }
  async receive(value, owner) {
    if (process.env.MMDCONV_DX12_VALIDATION) console.log('Native DX12:', value);
    if (value.type !== 'frame') { this.complete(value); return; }
    const win = this.getWindow(); if (!win || win.isDestroyed()) { this.stop(); return; }
    const ntHandle = Buffer.alloc(8); ntHandle.writeBigUInt64LE(BigInt(value.handle));
    const lease = { owner, id: value.id }; this.frames.add(lease);
    let released = false;
    const releaseFrame = () => {
      if (released) return;
      released = true;
      if (this.child === owner) { try { this.send(3, new Uint32Array([value.id]).buffer); } catch (error) { this.fail(error); } }
      this.frames.delete(lease);
      for (const wake of this.slotWaiters) wake();
    };
    let attempts = 0, references = 0, finished = false;
    const releaseImport = () => { references--; if (finished && references === 0) releaseFrame(); };
    const deadline = Date.now() + GPU_RECOVERY_MS;
    try {
      // Keep this same native frame alive through import AND presentation retries.
      // A lost renderer context can require importing again on the new GPU channel.
      for (;;) {
        if (this.child !== owner || win.isDestroyed()) throw new Error('DX12 presentation cancelled');
        let imported;
        try {
          imported = sharedTexture.importSharedTexture({
            textureInfo: { pixelFormat: 'rgba', codedSize: { width: value.width, height: value.height }, handle: { ntHandle }, timestamp: value.id * 1000 },
            allReferencesReleased: releaseImport,
          });
          references++;
          await this.present(imported, win, owner, value.id);
          break;
        } catch (error) {
          if (!gpuUnavailable(error) || Date.now() >= deadline) throw error;
          attempts++;
          await new Promise(resolve => setTimeout(resolve, GPU_RETRY_MS));
        } finally {
          imported?.release();
        }
      }
      if (attempts) this.logPresentation('recovered', { attempts, frame: value.id });
    } catch (error) {
      this.logPresentation('failed', { error: error.message, attempts, frame: value.id });
      if (gpuUnavailable(error)) {
        throw new Error(`DX12 렌더링은 완료됐지만 화면 합성용 GPU 연결을 복구하지 못했습니다. 다시 시도해 주세요. (${error.message})`);
      }
      throw error;
    } finally {
      // An import failure has no Electron release callback. It must still return
      // the native pool slot, including on timeout/cancellation/manual retry.
      finished = true;
      if (references === 0) releaseFrame();
    }
    if (this.child === owner) this.complete(value);
  }
  logPresentation(event, details) {
    const record = { time: new Date().toISOString(), event, ...details,
      nativeGPU: this.capabilities?.gpu, hardwareAcceleration: app.isHardwareAccelerationEnabled(),
      features: app.getGPUFeatureStatus() };
    console.warn('[DX12 presentation]', JSON.stringify(record));
    const directory = path.join(app.getPath('userData'), 'logs');
    fs.promises.mkdir(directory, { recursive: true }).then(() =>
      fs.promises.appendFile(path.join(directory, 'dx12-presentation.log'), JSON.stringify(record) + '\n')
    ).catch(() => {});
  }
  stop() { this.fail(new Error('DX12 renderer stopped')); this.capabilities = null; const child = this.child; this.child = null; this.frames.clear(); if (child) child.stdin.end(); }
}
