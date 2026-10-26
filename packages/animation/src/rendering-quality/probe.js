/* SPDX-License-Identifier: MIT */

export const inputEvents = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'touchmove', 'scroll'];
// Retain the startup probe's existing cache across this API migration.
const cachePrefix = 'mun:backdrop-quality:v1:';
export const screenKey = owner => JSON.stringify([owner.navigator.userAgent, owner.screen.width, owner.screen.height, owner.screen.colorDepth, owner.devicePixelRatio]);
const isQuality = value => value === 'full' || value === 'reduced' || value === 'none';
const requiredAPIs = ['requestIdleCallback', 'cancelIdleCallback', 'requestAnimationFrame', 'cancelAnimationFrame'];

function classifyFrames(baseline, filtered) {
  if (baseline.length !== 2 || filtered.length !== 2) return undefined;
  if ([...baseline, ...filtered].some(ms => !Number.isFinite(ms) || ms < 4 || ms > 100)) return undefined;
  const base = (baseline[0] + baseline[1]) / 2;
  if (base > 40 || Math.abs(baseline[0] - baseline[1]) > Math.max(2, base * 0.2)) return undefined;
  const slow = Math.min(...filtered);
  if (Math.max(...filtered) > slow * 1.25) return undefined;
  if (slow >= Math.max(48, base * 2.5)) return 'none';
  if (slow >= Math.max(24, base * 1.5)) return 'reduced';
  return 'full';
}

/** Compatibility classifier: uncertainty defaults to full only for initial selection. */
export function qualityFromFrames(baseline, filtered) {
  return classifyFrames(baseline, filtered) ?? 'full';
}

/** A single cancellable, bounded CSS backdrop sample. Repeat calls bypass the cache. */
export function probeRenderingQuality(owner, { cached = false, signal } = {}) {
  return new Promise(resolve => {
    if (!owner || signal?.aborted) return resolve({ source: 'unavailable', reason: 'aborted' });
    const document = owner.document;
    const missing = requiredAPIs.filter(name => typeof owner[name] !== 'function');
    if (missing.length) return resolve({ source: 'unavailable', reason: 'unsupported-api', missing });
    const key = screenKey(owner);
    let done = false, frame = 0, idle = 0, quiet = 0, watchdog = 0;
    let sample;
    const finish = (result = { source: 'unavailable' }) => {
      if (done) return;
      done = true;
      owner.cancelAnimationFrame(frame);
      owner.cancelIdleCallback(idle);
      owner.clearTimeout(quiet);
      owner.clearTimeout(watchdog);
      owner.removeEventListener('load', loaded);
      owner.removeEventListener('pagehide', cancel);
      document.removeEventListener('visibilitychange', cancel);
      owner.removeEventListener('resize', cancel);
      signal?.removeEventListener('abort', cancel);
      for (const event of inputEvents) owner.removeEventListener(event, cancel, true);
      sample?.remove();
      resolve(result);
    };
    const cancel = event => finish({ source: 'unavailable', reason: event?.type ?? 'timeout' });
    const safe = work => { try { work(); } catch { finish({ source: 'unavailable', reason: 'exception' }); } };
    const available = () => !done && document.visibilityState === 'visible' && screenKey(owner) === key;
    const whenIdle = work => {
      idle = owner.requestIdleCallback(deadline => safe(() => {
        if (!available()) return finish({ source: 'unavailable', reason: 'not-visible-or-screen-changed' });
        if (deadline.didTimeout || deadline.timeRemaining() < 8) return finish({ source: 'unavailable', reason: 'insufficient-idle-budget' });
        work();
      }));
    };
    const measure = next => {
      const times = [];
      const tick = time => safe(() => {
        if (!available()) return finish({ source: 'unavailable', reason: 'not-visible-or-screen-changed' });
        times.push(time);
        if (times.length === 3) return next([times[1] - times[0], times[2] - times[1]]);
        sample.style.backgroundPosition = `${times.length % 2}px 0px`;
        frame = owner.requestAnimationFrame(tick);
      });
      frame = owner.requestAnimationFrame(tick);
    };
    const probe = () => {
      if (cached) {
        try {
          const quality = owner.localStorage.getItem(cachePrefix + key);
          if (isQuality(quality)) return finish({ quality, source: 'cache' });
        } catch { /* storage is optional */ }
      }
      if (!owner.CSS?.supports('backdrop-filter', 'blur(1px)') && !owner.CSS?.supports('-webkit-backdrop-filter', 'blur(1px)')) return finish({ source: 'unavailable', reason: 'unsupported-backdrop-filter' });
      sample = document.createElement('div');
      sample.setAttribute('aria-hidden', 'true');
      sample.dataset.pbProbe = '';
      const dpr = Math.max(1, owner.devicePixelRatio || 1);
      sample.style.cssText = `position:fixed;right:0;bottom:0;width:${32 / dpr}px;height:${32 / dpr}px;z-index:2147483647;pointer-events:none;overflow:hidden;background:repeating-linear-gradient(90deg,#888 0px,#888 1px,#999 1px,#999 2px)`;
      document.body.append(sample);
      owner.clearTimeout(watchdog);
      watchdog = owner.setTimeout(cancel, 250);
      measure(baseline => whenIdle(() => {
        // The same three equal-variance layers and 17-stop linear masks as the
        // original radius-6 edge probe, without depending on a particular renderer.
        for (let index = 0; index < 3; index++) {
          const stops = Array.from({ length: 17 }, (_, sample) => {
            const t = sample / 16;
            const alpha = Math.round(Math.min(1, Math.max(0, 3 * t * t - index)) * 1000) / 1000;
            return `rgba(0,0,0,${alpha}) calc(100% - ${(Math.round((1 - t) * 32 / dpr * 100) / 100)}px)`;
          }).join(',');
          const element = document.createElement('div');
          const mask = `linear-gradient(to bottom,${stops})`;
          element.style.cssText = `position:absolute;inset:0;backdrop-filter:blur(${3.46 / dpr}px);-webkit-backdrop-filter:blur(${3.46 / dpr}px);mask-image:${mask};-webkit-mask-image:${mask}`;
          sample.append(element);
        }
        measure(filtered => finish({ quality: classifyFrames(baseline, filtered), source: 'probe', baselineMs: (baseline[0] + baseline[1]) / 2, baseline, filtered }));
      }));
    };
    const loaded = () => safe(() => {
      frame = owner.requestAnimationFrame(() => {
        frame = owner.requestAnimationFrame(() => {
          quiet = owner.setTimeout(() => safe(() => whenIdle(probe)), 1000);
        });
      });
    });
    for (const event of inputEvents) owner.addEventListener(event, cancel, { capture: true, passive: true });
    document.addEventListener('visibilitychange', cancel);
    owner.addEventListener('pagehide', cancel);
    owner.addEventListener('resize', cancel);
    signal?.addEventListener('abort', cancel, { once: true });
    watchdog = owner.setTimeout(cancel, 5000);
    if (document.readyState === 'complete') loaded();
    else owner.addEventListener('load', loaded, { once: true });
  }).catch(() => ({ source: 'unavailable' }));
}

/** Persist the selected policy, rather than a noisy raw sample, outside input work. */
export function cacheRenderingQuality(owner, key, quality) {
  if (typeof owner.requestIdleCallback !== 'function') return;
  owner.requestIdleCallback(deadline => {
    if (deadline.timeRemaining() < 2) return;
    try { owner.localStorage.setItem(cachePrefix + key, quality); } catch { /* blocked or full storage */ }
  });
}
