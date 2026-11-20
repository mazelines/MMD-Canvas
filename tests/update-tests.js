import assert from 'node:assert/strict';
import { createUpdateChecker, releaseUpdate, RELEASE_API } from '../electron/update-checker.js';

export function registerUpdateTests(test) {
  test('Release updates compare stable semantic versions and constrain download URLs', () => {
    const release = tag_name => ({ tag_name, html_url: 'https://untrusted.example/' });
    for (const tag of ['v0.8.3', '0.9.0', 'v0.10.0', 'v1.0.0']) {
      const update = releaseUpdate(release(tag), '0.8.2');
      assert.ok(update);
      assert.equal(update.url, `https://github.com/mazelines/MMD-Canvas/releases/tag/${tag}`);
    }
    for (const tag of ['v0.8.2', 'v0.8.1', 'v0.7.99', 'v0.9.0-beta.1', 'latest', 'v01.9.0', 'v0.9.0/evil']) {
      assert.equal(releaseUpdate(release(tag), '0.8.2'), null, tag);
    }
    assert.equal(releaseUpdate({ ...release('v0.9.0'), draft: true }, '0.8.2'), null);
    assert.equal(releaseUpdate({ ...release('v0.9.0'), prerelease: true }, '0.8.2'), null);
    assert.equal(releaseUpdate(release('v0.8.2+build.2'), '0.8.2+build.1'), null);
    assert.ok(releaseUpdate(release('v0.8.2'), '0.8.2-rc.1'));
  });
  test('Update checks coalesce requests, preserve offline state, and detect later releases', async () => {
    let calls = 0, release = { tag_name: 'v0.8.3' }, fail = false, status = 200;
    const events = [];
    const checker = createUpdateChecker({ version: '0.8.2', onUpdate: update => events.push(update),
      fetchRelease: async (url, options) => {
        calls++;
        assert.equal(url, RELEASE_API); assert.ok(options.signal instanceof AbortSignal);
        if (fail) throw new Error('offline');
        return { ok: status === 200, json: async () => release };
      },
    });
    try {
      const first = checker.check(); assert.equal(checker.check(), first); await first;
      assert.equal(calls, 1); assert.equal(checker.latest.version, '0.8.3');
      await checker.check(); assert.equal(events.length, 1);
      fail = true; await checker.check(); assert.equal(checker.latest.version, '0.8.3');
      fail = false; status = 403; await checker.check(); assert.equal(events.length, 1);
      status = 200; release = { tag_name: 'v0.9.0' }; await checker.check();
      assert.equal(events.at(-1).version, '0.9.0');
      release = { tag_name: 'v0.8.2' }; await checker.check(); assert.equal(checker.latest, null);
      checker.stop(); const before = calls; await checker.check(); assert.equal(calls, before);
    } finally { checker.stop(); }
  });
  test('Update checker starts automatically, repeats and aborts stalled requests', async () => {
    let calls = 0;
    const checker = createUpdateChecker({ version: '0.8.2', intervalMs: 15, timeoutMs: 5,
      fetchRelease: (_url, { signal }) => new Promise((_resolve, reject) => {
        calls++; signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
    });
    try {
      checker.start(); checker.start();
      assert.equal(calls, 1);
      await new Promise(resolve => setTimeout(resolve, 65));
      assert.ok(calls >= 2); checker.stop(); const stopped = calls;
      await new Promise(resolve => setTimeout(resolve, 35)); assert.equal(calls, stopped);
    } finally { checker.stop(); }
  });
}
