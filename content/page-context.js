// page-context.js — runs in MAIN world, reads YouTube player data and posts it to content script

(function() {
  function getPlayerResponse() {
    return window.ytInitialPlayerResponse || null;
  }

  window.addEventListener('message', function(event) {
    if (event.source !== window) return;
    if (event.data?.type === 'PARCHMENT_GET_YT_DATA') {
      const playerResponse = getPlayerResponse();
      const captions = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
      
      // Find best English track
      const track = captions.find(t => t.languageCode === 'en' && !t.kind)
        || captions.find(t => t.languageCode === 'en')
        || captions[0]
        || null;

      window.postMessage({
        type: 'PARCHMENT_YT_DATA',
        baseUrl: track?.baseUrl || null,
        availableTracks: captions.map(t => ({ lang: t.languageCode, kind: t.kind, name: t.name?.simpleText })),
      }, '*');
    }
  });
})();
