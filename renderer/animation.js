// Playback of the animation clips a loaded model carries (FBX takes, glTF animations, …).
// Time is owned here rather than by the mixer, so scrubbing, pausing and "play once" share one path.

import * as THREE from 'three';

const BOUNDS_SAMPLES = 32;

/** Clips worth offering: at least one track and a real length. */
export function playableClips(clips) {
  const playable = [];
  for (const clip of clips || []) {
    if (!clip?.tracks?.length) continue;
    if (!(clip.duration > 0)) clip.resetDuration(); // some loaders leave -1 ("derive from the tracks")
    if (clip.duration > 0) playable.push(clip);
  }
  return playable;
}

export class ModelAnimation {
  /** @param {THREE.Object3D} root  @param {THREE.AnimationClip[]} clips non-empty, see playableClips */
  constructor(root, clips) {
    this.root = root;
    this.clips = clips;
    this.mixer = new THREE.AnimationMixer(root);
    this.action = null;
    this.index = -1;
    this.time = 0;
    this.playing = false;
    this.loop = true;
    this.speed = 1;
    this.bounds = new Map(); // clip index -> swept world bounds

    // Measured in the bind pose, before any clip moves the bones.
    root.updateMatrixWorld(true);
    this.skinned = [];
    this.margin = 0; // how far skin reaches past its joints; one radius, because poses rotate it onto any axis
    const bones = new THREE.Box3(), point = new THREE.Vector3();
    root.traverse((o) => {
      if (!o.isSkinnedMesh || o.userData.viewportOutline || !o.skeleton?.bones.length) return;
      this.skinned.push(o);
      o.frustumCulled = false; // its rest-pose bounding sphere does not follow the motion
      o.computeBoundingBox();
      const mesh = o.boundingBox.clone().applyMatrix4(o.matrixWorld);
      bones.makeEmpty();
      for (const bone of o.skeleton.bones) bones.expandByPoint(point.setFromMatrixPosition(bone.matrixWorld));
      const low = point.subVectors(bones.min, mesh.min);
      this.margin = Math.max(this.margin, low.x, low.y, low.z);
      const high = point.subVectors(mesh.max, bones.max);
      this.margin = Math.max(this.margin, high.x, high.y, high.z);
    });
    this.select(0);
  }

  get clip() { return this.clips[this.index]; }
  get duration() { return this.clip.duration; }

  select(index) {
    if (!this.clips[index] || index === this.index) return false;
    this.action?.stop();
    this.index = index;
    this.action = this.mixer.clipAction(this.clips[index]);
    this.action.play();
    this.seek(0);
    return true;
  }

  /** Pose the model at `time` seconds (clamped to the clip). */
  seek(time) {
    this.time = Math.min(Math.max(Number.isFinite(time) ? time : 0, 0), this.duration);
    this.action.time = this.time;
    this.mixer.update(0); // a zero step evaluates the tracks at action.time without wrapping
  }

  play() {
    if (this.time >= this.duration) this.seek(0); // finished "play once": start over
    this.playing = true;
  }

  pause() { this.playing = false; }

  setSpeed(speed) {
    if (Number.isFinite(speed) && speed > 0) this.speed = Math.min(speed, 16);
  }

  /** Step playback by `dt` seconds of wall time. @returns {boolean} whether the pose changed */
  advance(dt) {
    if (!this.playing || !(dt > 0)) return false;
    let time = this.time + dt * this.speed;
    if (time >= this.duration) {
      if (this.loop) time %= this.duration;
      else { time = this.duration; this.playing = false; }
    }
    this.seek(time);
    return true;
  }

  state() {
    return {
      clips: this.clips.map((clip) => ({ name: clip.name || '', duration: clip.duration })),
      index: this.index, time: this.time, duration: this.duration,
      playing: this.playing, loop: this.loop, speed: this.speed,
    };
  }

  /** Conservative world bounds of the current pose (skinned meshes: their joints plus the bind-pose margin). */
  poseBounds(target = new THREE.Box3()) {
    const box = new THREE.Box3(), point = new THREE.Vector3();
    target.makeEmpty();
    this.root.updateMatrixWorld(true);
    this.root.traverse((o) => {
      if (!o.geometry || o.userData.viewportOutline) return;
      if (this.skinned.includes(o)) {
        box.makeEmpty();
        for (const bone of o.skeleton.bones) box.expandByPoint(point.setFromMatrixPosition(bone.matrixWorld));
        box.expandByScalar(this.margin);
      } else {
        if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
        box.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld);
      }
      target.union(box);
    });
    return target;
  }

  /** Everything the current clip reaches, so one shadow-map fit lasts for the whole motion. */
  sweptBounds() {
    let swept = this.bounds.get(this.index);
    if (!swept) {
      swept = new THREE.Box3();
      const pose = new THREE.Box3(), time = this.time;
      for (let i = 0; i <= BOUNDS_SAMPLES; i++) {
        this.seek((this.duration * i) / BOUNDS_SAMPLES);
        swept.union(this.poseBounds(pose));
      }
      this.seek(time);
      this.bounds.set(this.index, swept);
    }
    return swept;
  }

  dispose() {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.root);
  }
}
