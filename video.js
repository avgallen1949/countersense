(/*
 * prelinger-bg.js
 * Cycling video wallpaper from the Prelinger Archives on archive.org.
 *
 * Usage — one tag, no CSS:
 *   <script src="prelinger-bg.js"></script>
 *
 * Options via data attributes:
 *   data-rotate="20000"   ms per clip
 *   data-tint="0.5"       brightness multiplier, 1 = untouched
 *   data-seek="true"      jump to a random timestamp (costs ~1-3s per clip)
 *   data-credit="true"    show title + link bottom-left
 *   data-fallback="/x.mp4"
 *
 * Control: PrelingerBackground.stop() / .start() / .next()
 */
(function () {
  'use strict';

  var script = document.currentScript;
  function attr(name, fallback) {
    var value = script && script.dataset[name];
    return value === undefined ? fallback : value;
  }

  var CONFIG = {
    collection: attr('collection', 'prelinger'),
    rotateMs: Number(attr('rotate', 20000)),
    brightness: Number(attr('tint', 0.65)),
    randomSeek: attr('seek', 'false') === 'true',
    showCredit: attr('credit', 'false') === 'true',
    fallbackVideo: attr('fallback', ''),
    fadeMs: 1200,
    poolSize: 50,
    cacheKey: 'prelinger-bg-pool',
    cacheMaxAge: 1000 * 60 * 60 * 24 * 7   // one week
  };

  var players = [];
  var creditEl = null;
  var startButton = null;
  var activeIndex = 0;
  var pool = [];
  var prepared = null;      // { clip, playerIndex } waiting in the wings
  var timer = null;
  var stopped = false;
  var firstPaint = true;

  /* ---------------- styles ---------------- */
  function injectStyles() {
    var css =
      'html, body { background-color: transparent !important; }' +
      '.prelinger-bg-layer {' +
        'position: fixed; inset: 0; z-index: -1;' +
        'pointer-events: none; overflow: hidden; background-color: #0b0a08;' +
      '}' +
      '.prelinger-bg-layer video {' +
        'position: absolute; inset: 0; width: 100%; height: 100%;' +
        'object-fit: cover; opacity: 0;' +
        'transition: opacity ' + CONFIG.fadeMs + 'ms ease-in-out;' +
        'filter: sepia(0.2) brightness(' + CONFIG.brightness + ');' +
      '}' +
      '.prelinger-bg-layer video.is-visible { opacity: 1; }' +
      '.prelinger-bg-credit {' +
        'position: fixed; left: 1rem; bottom: 1rem; z-index: 2147483000;' +
        'font: 400 0.7rem/1.4 ui-monospace, Menlo, monospace;' +
        'letter-spacing: 0.06em; text-transform: uppercase;' +
        'color: rgba(255,255,255,0.55); max-width: 50ch;' +
      '}' +
      '.prelinger-bg-credit a { color: inherit; }' +
      '.prelinger-bg-start {' +
        'position: fixed; right: 1rem; bottom: 1rem; z-index: 2147483000;' +
        'display: none; padding: 0.55rem 0.9rem; cursor: pointer;' +
        'background: rgba(0,0,0,0.6); color: #fff; font: inherit; font-size: 0.8rem;' +
        'border: 1px solid rgba(255,255,255,0.4);' +
      '}' +
      '.prelinger-bg-start.is-shown { display: block; }' +
      '@media (prefers-reduced-motion: reduce) {' +
        '.prelinger-bg-layer video { transition: none; }' +
      '}';

    var style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  }

  function buildLayer() {
    var layer = document.createElement('div');
    layer.className = 'prelinger-bg-layer';

    for (var i = 0; i < 2; i++) {
      var video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.preload = 'auto';
      video.setAttribute('aria-hidden', 'true');
      layer.appendChild(video);
      players.push(video);
    }
    document.body.appendChild(layer);

    if (CONFIG.showCredit) {
      creditEl = document.createElement('p');
      creditEl.className = 'prelinger-bg-credit';
      document.body.appendChild(creditEl);
    }

    startButton = document.createElement('button');
    startButton.className = 'prelinger-bg-start';
    startButton.textContent = 'Play background';
    startButton.addEventListener('click', function () {
      startButton.classList.remove('is-shown');
      showNext();
    });
    document.body.appendChild(startButton);
  }

  /* ---------------- identifier pool ----------------
   * The search endpoint is the slowest call in the whole chain, so its result
   * is cached. Repeat visits skip it entirely and go straight to metadata.
   */
  function readCache() {
    try {
      var raw = localStorage.getItem(CONFIG.cacheKey);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (Date.now() - parsed.savedAt > CONFIG.cacheMaxAge) return null;
      return parsed.docs && parsed.docs.length ? parsed.docs : null;
    } catch (e) {
      return null;
    }
  }

  function writeCache(docs) {
    try {
      localStorage.setItem(CONFIG.cacheKey, JSON.stringify({
        savedAt: Date.now(),
        docs: docs
      }));
    } catch (e) { /* private mode or quota — not worth handling */ }
  }

  function fetchPool() {
    var query = 'collection:(' + CONFIG.collection + ') AND mediatype:(movies)';
    var url = 'https://archive.org/advancedsearch.php' +
      '?q=' + encodeURIComponent(query) +
      '&fl%5B%5D=identifier&fl%5B%5D=title' +
      '&rows=' + CONFIG.poolSize +
      '&page=' + (1 + Math.floor(Math.random() * 3)) +
      '&output=json';

    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('Search failed: ' + r.status);
      return r.json();
    }).then(function (data) {
      var docs = (data && data.response && data.response.docs) || [];
      if (!docs.length) throw new Error('No items returned');
      writeCache(docs);
      return docs;
    });
  }

  function ensurePool() {
    if (pool.length) return Promise.resolve();
    var cached = readCache();
    if (cached) {
      pool = shuffle(cached);
      return Promise.resolve();
    }
    return fetchPool().then(function (docs) { pool = shuffle(docs); });
  }

  function shuffle(list) {
    var copy = list.slice();
    for (var i = copy.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = copy[i]; copy[i] = copy[j]; copy[j] = tmp;
    }
    return copy;
  }

  /* ---------------- clip resolution ----------------
   * Three metadata requests go out at once and the first usable result wins.
   * Sequential retries were the main source of multi-second stalls, since a
   * fair number of items carry no streamable mp4 derivative.
   */
  function resolveClip() {
    return ensurePool().then(function () {
      var batch = pool.splice(0, 3);
      if (!batch.length) return null;

      return Promise.all(batch.map(inspectItem)).then(function (results) {
        for (var i = 0; i < results.length; i++) {
          if (results[i]) return results[i];
        }
        return pool.length ? resolveClip() : null;
      });
    });
  }

  function inspectItem(item) {
    return fetch('https://archive.org/metadata/' + item.identifier)
      .then(function (r) {
        if (!r.ok) throw new Error('metadata ' + r.status);
        return r.json();
      })
      .then(function (meta) {
        var candidates = (meta.files || []).filter(function (file) {
          var name = (file.name || '').toLowerCase();
          return name.slice(-4) === '.mp4' &&
            name.indexOf('thumb') === -1 &&
            Number(file.size) > 1000000;
        });
        if (!candidates.length) return null;

        // The 512Kb derivative is the smallest streamable one, so it reaches
        // a playable state fastest. That matters more here than resolution.
        var chosen = null;
        for (var i = 0; i < candidates.length; i++) {
          if (candidates[i].format === '512Kb MPEG4') { chosen = candidates[i]; break; }
        }
        if (!chosen) {
          chosen = candidates.sort(function (a, b) {
            return Number(a.size) - Number(b.size);
          })[0];
        }

        return {
          url: 'https://archive.org/download/' + item.identifier + '/' +
               encodeURIComponent(chosen.name),
          poster: 'https://archive.org/services/img/' + item.identifier,
          title: item.title || item.identifier,
          identifier: item.identifier
        };
      })
      .catch(function () { return null; });
  }

  /* ---------------- prepare / show ----------------
   * prepare() loads a clip into the idle player during the current clip's
   * 20 seconds, so show() only has to flip opacity and call play().
   */
  function prepare() {
    if (stopped || prepared) return Promise.resolve();

    return resolveClip().then(function (clip) {
      if (!clip) return;

      var idleIndex = 1 - activeIndex;
      var video = players[idleIndex];
      video.poster = clip.poster;
      video.src = clip.url;
      video.load();

      // loadeddata fires a readyState earlier than canplay — one frame is
      // decoded, which is all a crossfade needs.
      return waitFor(video, 'loadeddata', 10000).then(function (ready) {
        if (!ready) return;
        prepared = { clip: clip, index: idleIndex };
      });
    });
  }

  function showNext() {
    if (stopped) return Promise.resolve();

    var ready = prepared ? Promise.resolve() : prepare();

    return ready.then(function () {
      if (!prepared) {
        if (firstPaint && CONFIG.fallbackVideo) useFallback();
        return prepare();   // try again for the next tick
      }

      var clip = prepared.clip;
      var nextIndex = prepared.index;
      var next = players[nextIndex];
      var current = players[activeIndex];
      prepared = null;

      // Seeking forces a fresh byte-range request and a re-buffer, which is
      // where a second or three used to disappear. Off unless asked for.
      if (CONFIG.randomSeek && next.duration && isFinite(next.duration) && next.duration > 90) {
        next.currentTime = Math.random() * (next.duration - CONFIG.rotateMs / 1000 - 5);
      }

      return next.play().then(function () {
        startButton.classList.remove('is-shown');
        next.classList.add('is-visible');
        current.classList.remove('is-visible');
        activeIndex = nextIndex;
        firstPaint = false;

        if (creditEl) {
          creditEl.innerHTML = escapeHtml(clip.title) +
            ' · <a href="https://archive.org/details/' + clip.identifier +
            '" target="_blank" rel="noopener">Prelinger Archives</a>';
        }

        setTimeout(function () {
          current.pause();
          current.removeAttribute('src');
          current.removeAttribute('poster');
          current.load();
          prepare();          // start loading the following clip right away
        }, CONFIG.fadeMs);
      }).catch(function () {
        startButton.classList.add('is-shown');
      });
    });
  }

  function useFallback() {
    var video = players[activeIndex];
    video.src = CONFIG.fallbackVideo;
    video.loop = true;
    video.classList.add('is-visible');
    video.play().catch(function () {});
  }

  function waitFor(video, eventName, timeoutMs) {
    return new Promise(function (resolve) {
      var settled = false;
      function finish(value) {
        if (settled) return;
        settled = true;
        video.removeEventListener(eventName, onReady);
        video.removeEventListener('error', onFail);
        resolve(value);
      }
      function onReady() { finish(true); }
      function onFail() { finish(false); }
      video.addEventListener(eventName, onReady);
      video.addEventListener('error', onFail);
      setTimeout(function () { finish(false); }, timeoutMs);
    });
  }

  function escapeHtml(text) {
    var div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /* ---------------- lifecycle ---------------- */
  function start() {
    stopped = false;
    clearInterval(timer);
    timer = setInterval(showNext, CONFIG.rotateMs);
    players[activeIndex].play().catch(function () {});
  }

  function stop() {
    stopped = true;
    clearInterval(timer);
    players.forEach(function (video) { video.pause(); });
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      clearInterval(timer);
      players[activeIndex].pause();
    } else if (!stopped) {
      start();
    }
  });

  function init() {
    injectStyles();
    buildLayer();
    showNext()
      .then(start)
      .then(prepare)
      .catch(function (error) {
        console.error('[prelinger-bg] Could not reach the Internet Archive:', error);
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.PrelingerBackground = { start: start, stop: stop, next: showNext, config: CONFIG };
})();)