/* ==========================================================================
   FREEDOMMUSIC — player (vanilla JS, no dependencies)
   --------------------------------------------------------------------------
   Track list: GET https://elysia-telegram-cloude-storage.vercel.app/api/music
   (backend must send Access-Control-Allow-Origin for localhost:3333).
   Audio:      <audio> plays Telegram file URLs directly — no CORS needed.

   Until the API answers, the page keeps its static mockup state
   ("Dark Horse / Prism - Katy Perry", "2:26 / 5:32") — pixel-identical
   to the PSD, so the visual-regression baselines stay valid.

   Behaviours:
     - click a playlist line or an album cover  -> play that track
     - play/pause, prev, next (wrap-around), seek (click/drag on timeline)
     - volume (click/drag on the volume bar)
     - repeat: off -> all -> one (badge "1"), shuffle: on/off (accent glow)
     - Space/K play-pause, arrows seek/volume, S shuffle, R repeat
     - Media Session metadata + OS media keys
     - broken/expired Telegram URL -> skip to the next track
   ========================================================================== */
(function () {
  'use strict';

  var API_URL = 'https://elysia-telegram-cloude-storage.vercel.app/api/music';

  /* White play triangle (swapped in place of ic-pause.png when paused). */
  var PLAY_ICON =
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 35 35'%3E%3Cpath d='M9 5.5 L29 17.5 L9 29.5 Z' fill='%23ffffff'/%3E%3C/svg%3E";
  var PAUSE_ICON = 'assets/ic-pause.png';

  function $(sel) { return document.querySelector(sel); }

  /* ---------------------------------------------------------------- state */
  var audio = new Audio();
  audio.preload = 'metadata';
  audio.volume = 0.55;                    /* matches the mockup volume fill */

  var queue = [];                         /* [{id,url,artist,title}] */
  var current = 0;
  var started = false;                    /* real (non-mockup) display on   */
  var playing = false;
  var wantPlay = false;                   /* intent, survives src switches  */
  var repeat = 'off';                     /* off | all | one */
  var shuffle = false;
  var consecutiveErrors = 0;

  var el = {
    btnPlay:    $('.pc-pause'),
    btnPrev:    $('.pc-prev'),
    btnNext:    $('.pc-next'),
    btnRepeat:  $('.pc-repeat'),
    btnShuffle: $('.pc-shuffle'),
    btnVolume:  $('.pc-volume'),
    title:      $('.now-title'),
    sub:        $('.now-sub'),
    timeCur:    $('.time-cur'),
    timeTotal:  $('.time-total'),
    timeline:   $('.timeline-track'),
    progress:   $('.timeline-progress'),
    volTrack:   $('.volume-track'),
    volFill:    $('.volume-progress'),
    tracklist:  $('.tracklist'),
    albums:     $('.albums')
  };
  if (!el.btnPlay || !el.timeline || !el.title) { return; }

  /* ------------------------------------------------------------- helpers */
  function fmt(sec) {
    if (!isFinite(sec) || sec < 0) { sec = 0; }
    var m = Math.floor(sec / 60);
    var s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function esc(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* "Artist - Title.mp3" -> {artist, title}; a few files have no dash and
     use a 3+ space gap instead ("Numb   Linkin Park"). */
  function parseName(fileName) {
    var name = String(fileName || '').replace(/\.[a-z0-9]+$/i, '');
    var parts = name.split(/\s+[-\u2013\u2014]\s+/);
    var artist, title;
    if (parts.length >= 2) {
      artist = parts[0];
      title = parts.slice(1).join(' - ');
    } else {
      parts = name.split(/\s{3,}/);
      if (parts.length >= 2) { artist = parts[0]; title = parts.slice(1).join(' '); }
      else { artist = ''; title = name; }
    }
    artist = artist.replace(/^\d{1,2}\s+/, '').trim();   /* "01 Gigi..." */
    return { artist: artist, title: title.trim() || name };
  }

  function label(t) { return t.artist ? t.artist + ' - ' + t.title : t.title; }

  function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

  /* --------------------------------------------------------------- render */
  function setPlayingUI(isPlaying) {
    playing = isPlaying;
    var img = el.btnPlay.querySelector('img');
    if (img) { img.src = isPlaying ? PAUSE_ICON : PLAY_ICON; }
    el.btnPlay.setAttribute('aria-label', isPlaying ? 'Pause' : 'Play');
  }

  function showRealTrack(t) {
    started = true;
    el.title.textContent = t.title;
    el.sub.textContent = t.artist || 'Unknown artist';
    el.timeCur.textContent = fmt(0);
    el.timeTotal.textContent = fmt(0);
    el.progress.style.width = '0%';
  }

  function renderTracklist() {
    if (!el.tracklist || !queue.length) { return; }
    var size = Math.min(8, queue.length);
    var html = '';
    for (var k = 0; k < size; k++) {
      var i = (current + k) % queue.length;
      var t = queue[i];
      html += '<a href="/?track=' + encodeURIComponent(t.id) + '" data-i="' + i + '"' +
        (k === 0 && started ? ' class="tl-active"' : '') + '>' +
        esc(label(t)) + '</a>';
    }
    el.tracklist.innerHTML = html;
  }

  function bindCovers() {
    if (!el.albums) { return; }
    var links = el.albums.querySelectorAll('.album > a[data-i]');
    Array.prototype.forEach.call(links, function (a) {
      var i = parseInt(a.getAttribute('data-i'), 10);
      var t = queue[i];
      if (t) {
        a.setAttribute('href', '/?track=' + encodeURIComponent(t.id));
        a.setAttribute('aria-label', 'Play: ' + label(t));
      }
    });
  }

  function mediaSession(t) {
    try {
      if (!('mediaSession' in navigator) || !window.MediaMetadata) { return; }
      navigator.mediaSession.metadata = new window.MediaMetadata({
        title: t.title,
        artist: t.artist || 'freedommusic',
        album: 'freedommusic',
        artwork: [{ src: 'assets/album-r1c1.png', sizes: '316x315', type: 'image/png' }]
      });
      navigator.mediaSession.setActionHandler('play', function () { doPlay(); });
      navigator.mediaSession.setActionHandler('pause', function () { pause(); });
      navigator.mediaSession.setActionHandler('previoustrack', function () { prev(playing); });
      navigator.mediaSession.setActionHandler('nexttrack', function () { next(playing); });
    } catch (e) { /* unsupported browser — ignore */ }
  }

  /* ------------------------------------------------------------- playback */
  function load(i, continuePlayback) {
    if (!queue.length) { return false; }
    if (!isFinite(i)) { i = 0; }
    current = ((i % queue.length) + queue.length) % queue.length;
    var t = queue[current];

    audio.src = t.url;
    audio.load();
    showRealTrack(t);
    renderTracklist();
    mediaSession(t);

    if (continuePlayback) { doPlay(); } else { wantPlay = false; setPlayingUI(false); }
    return true;
  }

  function doPlay() {
    if (!queue.length) { return; }
    wantPlay = true;
    if (!audio.src) { load(current, true); return; }     /* first activation */
    var p = audio.play();
    if (p && typeof p.catch === 'function') {
      p.catch(function (err) { console.warn('[player] play() rejected:', err); });
    }
  }

  function pause() { wantPlay = false; audio.pause(); }

  function toggle() {
    if (!queue.length) { return; }
    if (playing) { pause(); } else { doPlay(); }
  }

  function randomOther() {
    if (queue.length < 2) { return current; }
    var i;
    do { i = Math.floor(Math.random() * queue.length); } while (i === current);
    return i;
  }

  /* cont = keep playing if it was playing (click) / was playing (ended) */
  function next(cont) {
    if (!queue.length) { return; }
    var i;
    if (shuffle) {
      i = randomOther();
    } else {
      i = current + 1;
      if (i >= queue.length) {
        if (repeat === 'all' || !cont) { i = 0; }
        else { setPlayingUI(false); return; }             /* stop at the end */
      }
    }
    load(i, cont);
  }

  function prev(cont) {
    if (!queue.length) { return; }
    var i;
    if (shuffle) {
      i = randomOther();
    } else {
      i = current - 1;
      if (i < 0) { i = (repeat === 'all' || !cont) ? queue.length - 1 : 0; }
    }
    load(i, cont);
  }

  function handleEnded() {
    if (repeat === 'one') { audio.currentTime = 0; doPlay(); return; }
    next(true);
  }

  /* ------------------------------------------------------- toggles / UI  */
  function cycleRepeat() {
    repeat = repeat === 'off' ? 'all' : repeat === 'all' ? 'one' : 'off';
    el.btnRepeat.classList.toggle('on', repeat !== 'off');
    el.btnRepeat.classList.toggle('one', repeat === 'one');
    el.btnRepeat.setAttribute('aria-label', 'Repeat: ' + repeat);
  }

  function toggleShuffle() {
    shuffle = !shuffle;
    el.btnShuffle.classList.toggle('on', shuffle);
    el.btnShuffle.setAttribute('aria-label', 'Shuffle: ' + (shuffle ? 'on' : 'off'));
  }

  /* ------------------------------------------------------- pointer binds */
  function bindDrag(node, handler) {
    if (!node) { return; }
    function at(e) {
      var r = node.getBoundingClientRect();
      if (!r.width) { return; }
      handler(clamp01((e.clientX - r.left) / r.width));
    }
    node.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      at(e);
      try { node.setPointerCapture(e.pointerId); } catch (err) { /* noop */ }
      function move(ev) { at(ev); }
      function up() { node.removeEventListener('pointermove', move); }
      node.addEventListener('pointermove', move);
      node.addEventListener('pointerup', up, { once: true });
      node.addEventListener('pointercancel', up, { once: true });
    });
  }

  bindDrag(el.timeline, function (frac) {
    if (!queue.length) { return; }
    if (!audio.src) { load(current, false); }
    function seek() {
      if (!isFinite(audio.duration) || audio.duration <= 0) { return; }
      audio.currentTime = frac * audio.duration;
      el.progress.style.width = frac * 100 + '%';
      el.timeCur.textContent = fmt(audio.currentTime);
    }
    if (audio.readyState >= 1) { seek(); }
    else { audio.addEventListener('loadedmetadata', seek, { once: true }); }
  });

  bindDrag(el.volTrack, function (frac) {
    audio.volume = frac;
    if (el.volFill) {
      el.volFill.style.left = '0px';      /* drop the mockup -6px offset */
      el.volFill.style.width = frac * 100 + '%';
    }
  });

  /* ------------------------------------------------------ audio events    */
  audio.addEventListener('playing', function () {
    consecutiveErrors = 0;
    setPlayingUI(true);
  });
  audio.addEventListener('pause', function () { setPlayingUI(false); });
  audio.addEventListener('timeupdate', function () {
    if (!started) { return; }
    el.timeCur.textContent = fmt(audio.currentTime);
    if (isFinite(audio.duration) && audio.duration > 0) {
      el.progress.style.width = (audio.currentTime / audio.duration) * 100 + '%';
    }
  });
  audio.addEventListener('loadedmetadata', function () {
    if (started && isFinite(audio.duration)) { el.timeTotal.textContent = fmt(audio.duration); }
  });
  audio.addEventListener('ended', handleEnded);
  audio.addEventListener('error', function () {
    if (!started || !queue.length) { return; }
    consecutiveErrors++;
    if (consecutiveErrors >= Math.min(queue.length, 3)) {
      console.warn('[player] giving up — tracks unavailable');
      setPlayingUI(false);
      return;
    }
    console.warn('[player] track unavailable, skipping');
    next(wantPlay);
  });

  /* ------------------------------------------------------------- clicks   */
  if (el.btnPlay) { el.btnPlay.addEventListener('click', toggle); }
  if (el.btnNext) { el.btnNext.addEventListener('click', function () { next(playing); }); }
  if (el.btnPrev) {
    el.btnPrev.addEventListener('click', function () {
      if (audio.src && audio.currentTime > 3) { audio.currentTime = 0; return; }
      prev(playing);
    });
  }
  if (el.btnRepeat) { el.btnRepeat.addEventListener('click', cycleRepeat); }
  if (el.btnShuffle) { el.btnShuffle.addEventListener('click', toggleShuffle); }
  if (el.btnVolume) {
    el.btnVolume.addEventListener('click', function () {
      audio.muted = !audio.muted;
      el.btnVolume.classList.toggle('on', audio.muted);
      el.btnVolume.setAttribute('aria-label', audio.muted ? 'Unmute' : 'Mute');
    });
  }

  if (el.albums) {
    el.albums.addEventListener('click', function (e) {
      var a = e.target.closest ? e.target.closest('a[data-i]') : null;
      if (!a || !el.albums.contains(a)) { return; }
      e.preventDefault();                       /* never reload the page */
      if (!queue.length) { return; }
      var i = parseInt(a.getAttribute('data-i'), 10) || 0;
      load(i % queue.length, true);
    });
  }

  if (el.tracklist) {
    el.tracklist.addEventListener('click', function (e) {
      var a = e.target.closest ? e.target.closest('a[data-i]') : null;
      if (!a || !el.tracklist.contains(a)) { return; }
      e.preventDefault();
      if (!queue.length) { return; }
      load(parseInt(a.getAttribute('data-i'), 10) || 0, true);
    });
  }

  /* ----------------------------------------------------------- keyboard   */
  document.addEventListener('keydown', function (e) {
    if (e.target && e.target.closest && e.target.closest('a, button, input, textarea, select')) {
      return;                                   /* keep native a11y keys */
    }
    if (!queue.length) { return; }
    switch (e.code) {
      case 'Space': case 'KeyK':
        e.preventDefault(); toggle(); break;
      case 'ArrowRight':
        e.preventDefault();
        audio.currentTime = (isFinite(audio.duration) && audio.duration > 0)
          ? Math.min(audio.currentTime + 5, audio.duration)
          : audio.currentTime + 5;
        break;
      case 'ArrowLeft':
        e.preventDefault(); audio.currentTime = Math.max((audio.currentTime || 0) - 5, 0); break;
      case 'ArrowUp':
        e.preventDefault(); audio.volume = clamp01(audio.volume + 0.05); syncVolume(); break;
      case 'ArrowDown':
        e.preventDefault(); audio.volume = clamp01(audio.volume - 0.05); syncVolume(); break;
      case 'KeyS': toggleShuffle(); break;
      case 'KeyR': cycleRepeat(); break;
    }
  });

  function syncVolume() {
    if (el.volFill) {
      el.volFill.style.left = '0px';
      el.volFill.style.width = audio.volume * 100 + '%';
    }
  }

  /* -------------------------------------------------------------- boot    */
  function applyTrackList(data) {
    queue = data.map(function (item, idx) {
      var parsed = parseName(item.file_name || '');
      return {
        id: item.id || String(idx),
        url: item.download_url || item.url,
        artist: (item.artist !== undefined && item.artist !== null) ? item.artist : parsed.artist,
        title: (item.title !== undefined && item.title !== null) ? item.title : parsed.title
      };
    }).filter(function (t) { return !!t.url; });
    if (!queue.length) { throw new Error('no playable tracks'); }
    bindCovers();
    renderTracklist();
    /* Player keeps its mockup state until the first user action. */
  }

  function boot() {
    fetch(API_URL, { headers: { Accept: 'application/json' } })
      .then(function (r) { if (!r.ok) { throw new Error('HTTP ' + r.status); } return r.json(); })
      .then(function (data) {
        if (!Array.isArray(data)) { throw new Error('unexpected payload'); }
        applyTrackList(data);
        console.info('[player] ' + queue.length + ' tracks loaded');
      })
      .catch(function (err) {
        console.warn('[player] track list NOT loaded (CORS/backend?): ' + err.message);
      });
  }

  /* Test/debug handle (used by the visual verification loop). */
  window.FM = {
    audio: audio,
    getQueue: function () { return queue.slice(); },
    setQueue: function (list) { applyTrackList(list); },   /* [{url,artist,title}] */
    load: load,
    state: function () {
      return {
        current: current, started: started, playing: playing,
        repeat: repeat, shuffle: shuffle, queueLength: queue.length,
        time: audio.currentTime, duration: audio.duration, volume: audio.volume
      };
    }
  };

  boot();
})();
