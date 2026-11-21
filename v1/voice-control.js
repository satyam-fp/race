// Voice Control System for Tachyon Sprint
// Seamlessly interfaces with the game engine via window.game

(function() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  let recognition = null;
  let isListening = false;
  let hasInteracted = false;

  const COMMANDS = [
    // Cruise / Autopilot / Flow
    {
      action: 'cruise',
      test: /\b(cruise|auto|autopilot|flow|relax|take over)\b/i,
      feedback: 'VOICE: CRUISE MODE'
    },
    // Manual Driving / Human Takeover
    {
      action: 'drive',
      test: /\b(drive|manual|my turn|i will drive|take control|stop cruise)\b/i,
      feedback: 'VOICE: MANUAL DRIVE'
    },
    // Back on the road / Recovery / Reset (R key)
    {
      action: 'back',
      test: /\b(back|reset|recover|respawn|on the road|back on road|help)\b/i,
      feedback: 'VOICE: BACK ON ROAD'
    },
    // Pause game
    {
      action: 'pause',
      test: /\b(pause|wait|hold on|stop)\b/i,
      feedback: 'VOICE: PAUSE'
    },
    // Resume game
    {
      action: 'resume',
      test: /\b(resume|continue|unpause|go|let'?s go)\b/i,
      feedback: 'VOICE: RESUME'
    },
    // Start race / start time trial
    {
      action: 'start',
      test: /\b(start|begin|race|play)\b/i,
      feedback: 'VOICE: START'
    },
    // Restart / Race again
    {
      action: 'restart',
      test: /\b(restart|retry|again|new race|race again|one more)\b/i,
      feedback: 'VOICE: RESTART'
    },
    // Camera views
    {
      action: 'view',
      payload: 0,
      test: /\b(far camera|far chase|far view)\b/i,
      feedback: 'VOICE: FAR CHASE CAM'
    },
    {
      action: 'view',
      payload: 1,
      test: /\b(near camera|near chase|near view|chase cam)\b/i,
      feedback: 'VOICE: NEAR CHASE CAM'
    },
    {
      action: 'view',
      payload: 2,
      test: /\b(bonnet|hood)\b/i,
      feedback: 'VOICE: BONNET CAM'
    },
    {
      action: 'view',
      payload: 4,
      test: /\b(cockpit|inside|interior|driver view|in car)\b/i,
      feedback: 'VOICE: COCKPIT VIEW'
    },
    {
      action: 'view',
      payload: 3,
      test: /\b(bumper|bumper view|road view)\b/i,
      feedback: 'VOICE: BUMPER CAM'
    },
    {
      action: 'view',
      test: /\b(camera|view|change view|switch view|angle)\b/i,
      feedback: 'VOICE: NEXT CAMERA'
    },
    // Audio Mute / Unmute (M key)
    {
      action: 'mute',
      test: /\b(mute|unmute|sound|audio|silence|quiet)\b/i,
      feedback: 'VOICE: TOGGLE AUDIO'
    },
    // Fullscreen (F key)
    {
      action: 'fullscreen',
      test: /\b(fullscreen|full screen|maximize)\b/i,
      feedback: 'VOICE: FULLSCREEN'
    },
    // Return to main menu / Quit / "I'm done"
    {
      action: 'menu',
      test: /\b(i'?m done|menu|main menu|exit|quit|leave|stop playing)\b/i,
      feedback: 'VOICE: MAIN MENU'
    }
  ];

  function showNotice(text) {
    const el = document.getElementById('notice');
    if (el) {
      el.textContent = text;
      el.hidden = false;
      clearTimeout(el._noticeTimer);
      el._noticeTimer = setTimeout(() => { el.hidden = true; }, 3000);
    }
  }

  function processTranscript(text) {
    if (!text) return;
    const clean = text.toLowerCase().trim();
    console.log('[Tachyon Voice] Heard:', clean);

    for (const cmd of COMMANDS) {
      if (cmd.test.test(clean)) {
        showNotice(cmd.feedback);
        if (window.game && typeof window.game.act === 'function') {
          window.game.act(cmd.action, cmd.payload);
        }
        return;
      }
    }
  }

  function initRecognition() {
    if (!SpeechRecognition) {
      console.warn('[Tachyon Voice] Web Speech API not supported in this browser.');
      return false;
    }

    try {
      recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = false;
      recognition.lang = 'en-US';

      recognition.onstart = () => {
        isListening = true;
        console.log('[Tachyon Voice] Listening active');
      };

      recognition.onresult = (event) => {
        for (let i = event.resultIndex; i < event.results.length; ++i) {
          if (event.results[i].isFinal) {
            processTranscript(event.results[i][0].transcript);
          }
        }
      };

      recognition.onerror = (event) => {
        if (event.error === 'not-allowed') {
          console.warn('[Tachyon Voice] Microphone permission denied');
          isListening = false;
        } else if (event.error !== 'no-speech') {
          console.warn('[Tachyon Voice] Recognition error:', event.error);
        }
      };

      recognition.onend = () => {
        // Automatically restart if user hasn't explicitly disabled it
        if (isListening) {
          try {
            recognition.start();
          } catch (e) {
            isListening = false;
          }
        }
      };

      return true;
    } catch (err) {
      console.error('[Tachyon Voice] Initialization error:', err);
      return false;
    }
  }

  function start() {
    if (!recognition && !initRecognition()) return false;
    try {
      isListening = true;
      recognition.start();
      showNotice('VOICE CONTROL LISTENING');
      return true;
    } catch (e) {
      // recognition already running or browser blocked
      return true;
    }
  }

  function stop() {
    if (recognition) {
      isListening = false;
      recognition.stop();
      showNotice('VOICE CONTROL OFF');
    }
  }

  function toggle() {
    if (isListening) {
      stop();
      return false;
    } else {
      return start();
    }
  }

  // Set up global hook
  window.voiceControl = {
    start,
    stop,
    toggle,
    status: () => ({ isListening, supported: !!SpeechRecognition }),
    execute: processTranscript
  };

  // Browser autoplay policy: Wait for first user interaction before requesting mic
  function setupOnFirstInteraction() {
    if (hasInteracted) return;
    hasInteracted = true;
    document.removeEventListener('click', setupOnFirstInteraction);
    document.removeEventListener('keydown', setupOnFirstInteraction);
    start();
  }

  document.addEventListener('click', setupOnFirstInteraction);
  document.addEventListener('keydown', setupOnFirstInteraction);
})();
