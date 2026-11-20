export const RELEASE_API = 'https://api.github.com/repos/mazelines/MMD-Canvas/releases/latest';
export const CHECK_INTERVAL = 6 * 60 * 60 * 1000;

// Only published stable releases are offered. Build metadata does not affect order.
const parseVersion = value => {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(value));
  return match && { parts: match.slice(1, 4).map(BigInt), prerelease: !!match[4] };
};
export function releaseUpdate(release, currentVersion) {
  if (!release || release.draft || release.prerelease) return null;
  const current = parseVersion(currentVersion), next = parseVersion(release.tag_name);
  if (!current || !next || next.prerelease) return null;
  const differing = next.parts.findIndex((part, i) => part !== current.parts[i]);
  if (differing < 0 ? !current.prerelease : next.parts[differing] < current.parts[differing]) return null;
  const version = next.parts.join('.');
  // Build our own destination: never launch an arbitrary URL from a response.
  return { version, url: `https://github.com/mazelines/MMD-Canvas/releases/tag/${encodeURIComponent(release.tag_name)}` };
}

export function createUpdateChecker({ version, fetchRelease = globalThis.fetch, onUpdate = () => {},
  intervalMs = CHECK_INTERVAL, timeoutMs = 10000 }) {
  let latest = null, timer = null, request = null, controller = null, stopped = false;
  const check = () => {
    if (stopped) return Promise.resolve(latest);
    if (request) return request;
    request = (async () => {
      controller = new AbortController();
      const deadline = setTimeout(() => controller?.abort(), timeoutMs);
      deadline.unref?.();
      try {
        const response = await fetchRelease(RELEASE_API, {
          headers: { Accept: 'application/vnd.github+json', 'User-Agent': `MMD-Canvas/${version}` },
          signal: controller.signal,
        });
        if (!response.ok) return latest;
        const update = releaseUpdate(await response.json(), version);
        if (!stopped) {
          const changed = update?.version !== latest?.version;
          latest = update;
          if (changed) onUpdate(latest);
        }
      } catch { /* Offline, timeout and rate limits must not interrupt editing. */ }
      finally { clearTimeout(deadline); controller = null; }
      return latest;
    })().finally(() => { request = null; });
    return request;
  };
  return {
    get latest() { return latest; },
    check,
    start() {
      if (timer || stopped) return;
      void check();
      timer = setInterval(() => { void check(); }, intervalMs);
      timer.unref?.();
    },
    stop() { stopped = true; clearInterval(timer); timer = null; controller?.abort(); },
  };
}
