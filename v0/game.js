// The page's half of the game: menus, options, keys and pad, and the
// display over the picture. The simulation owns the race (`sim/src/race.rs`);
// this asks it for things and shows what it says.
//
// The game calls four functions of this page every frame or when needed:
//   gamePoll()        what is asked: a line of controls, then commands
//   gameState(json)   the race now
//   gameGhost()       the best lap kept in this browser, as bytes
//   gameKeep(bytes)   a new best lap to keep
// and `sound(...)` in sound.js. Everything a test needs to read is on
// `window.game`.

const $ = id => document.getElementById(id);
const query = new URLSearchParams(location.search);
// `?clean`: the race without its display, for pictures of the place.
if (query.has('clean')) document.documentElement.classList.add('clean');

// ---------------------------------------------------------------- options

const ACTIONS = {
  throttle: 'Throttle', brake: 'Brake / reverse', left: 'Steer left', right: 'Steer right',
  handbrake: 'Handbrake', up: 'Change up', down: 'Change down', back: 'Back on the road',
  view: 'Change view', mute: 'Sound on / off', fullscreen: 'Full screen',
};
const DEFAULTS = {
  level: 3, rivals: 'match', laps: 3, abs: true, tc: 'high', stability: true, gears: 'auto', line: 'corners', view: 0,
  master: 8, car: 10, effects: 8, music: 6, units: 'km/h', readout: false,
  keys: {
    throttle: ['KeyW', 'ArrowUp'], brake: ['KeyS', 'ArrowDown'], left: ['KeyA', 'ArrowLeft'],
    right: ['KeyD', 'ArrowRight'], handbrake: ['Space'], up: ['KeyE'], down: ['KeyQ'],
    back: ['KeyR'], view: ['KeyC'],
    mute: ['KeyM'], fullscreen: ['KeyF'],
  },
  // A standard pad's buttons for each action (I6): the triggers, the
  // shoulders, A, X, Y, the pad's arrows, Start. The left stick steers too.
  buttons: {
    throttle: 7, brake: 6, left: 14, right: 15, handbrake: 0, up: 5, down: 4,
    back: 2, view: 3, mute: null, fullscreen: null, pause: 9,
  },
};
const BUTTONS = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'Back', 'Start', 'LS', 'RS', 'Up', 'Down', 'Left', 'Right', 'Home'];
const VIEWS = ['Far chase', 'Near chase', 'Bonnet', 'Bumper'];
const store = {
  get(name) { try { return localStorage.getItem(`racing.${name}`); } catch { return null; } },
  set(name, value) { try { localStorage.setItem(`racing.${name}`, value); } catch { /* private window */ } },
  drop(name) { try { localStorage.removeItem(`racing.${name}`); } catch { /* the same */ } },
};
function loadSettings() {
  let kept = {};
  try { kept = JSON.parse(store.get('settings') ?? '{}'); } catch { /* damaged: start again */ }
  const settings = { ...structuredClone(DEFAULTS), ...kept };
  if (settings.tc === true) settings.tc = 'high';
  if (settings.tc === false) settings.tc = 'off';
  settings.keys = { ...structuredClone(DEFAULTS.keys), ...(kept.keys ?? {}) };
  settings.buttons = { ...structuredClone(DEFAULTS.buttons), ...(kept.buttons ?? {}) };
  // A first visit: nothing kept yet, so the aids are chosen for keys or a
  // pad when the first race begins, and the controls are shown then (F2).
  settings.firstRun = !store.get('settings');
  return settings;
}
const settings = loadSettings();
function saveSettings() {
  // Anything chosen by the player ends the first run: its aids are theirs.
  settings.firstRun = false;
  store.set('settings', JSON.stringify(settings));
  applySettings();
}
function applySettings() {
  const tc = { off: 0, low: 1, high: 2 }[settings.tc === true ? 'high' : settings.tc === false ? 'off' : settings.tc] ?? 2;
  ask(`aids ${+settings.abs} ${tc} ${+settings.stability} ${+(settings.gears !== 'hand')}`);
  ask(`line ${{ off: 0, corners: 1, full: 2 }[settings.line] ?? 1}`);
  ask(`view ${settings.view}`);
  window.soundSet?.({
    master: settings.master / 10, car: settings.car / 10,
    effects: settings.effects / 10, music: settings.music / 10,
  });
  document.body.classList.toggle('readout', settings.readout);
}

// ------------------------------------------------------- talking to the game

const asked = [];
const ask = command => asked.push(command);
const game = window.game = {
  state: null, screen: 'loading', settings, held: new Set(), pad: null,
  messages: [], started: 0, ask,
};

const PLAYERS = ['clean', 'mistake', 'careless'];
window.gameFast = () => Number(query.get('fast') ?? 1) || 1;
window.gameOff = () => query.get('off') ?? '';
window.gameChoice = name => query.get(name) ?? '';
// Changes of gear pressed since the game last asked (I8).
const shifts = { up: false, down: false };
window.gamePoll = () => {
  padPoll();
  const c = game.screen === 'drive' ? controls() : { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
  game.controls = c;
  const said = `i ${c.throttle.toFixed(3)} ${c.brake.toFixed(3)} ${c.steer.toFixed(3)} ${c.handbrake} ${+shifts.up} ${+shifts.down}\n${asked.join('\n')}`;
  shifts.up = shifts.down = false;
  asked.length = 0;
  return said;
};
// Loading (V11): what has come over the network, against what a first
// visit is expected to bring, shown on the loading screen; the title waits
// until the files have stopped coming (none for two and a half seconds,
// and three seconds at least after the program began asking for them),
// then the game is asked to carry its camera once round the lap so that
// everything is drawn once before a race (V10).
const EXPECTED_MB = 62;
const loading = { bytes: 0, files: 0, last: performance.now(), done: false };
try {
  new PerformanceObserver(list => {
    for (const entry of list.getEntries()) {
      loading.bytes += entry.transferSize || entry.encodedBodySize || 0;
      loading.files += 1;
      loading.last = performance.now();
    }
  }).observe({ type: 'resource', buffered: true });
} catch { /* an old browser: no progress, the title comes at once */ loading.done = true; }
game.loading = loading;
function progress() {
  const mb = loading.bytes / 1e6;
  const share = Math.min(0.99, mb / EXPECTED_MB);
  const note = $('note');
  if (note && !window.lastError) {
    note.innerHTML = `<div class="loading"><div>${game.state ? 'Loading the circuit' : 'Loading the program'}</div>
      <div class="bar"><i style="width:${(share * 100).toFixed(1)}%"></i></div>
      <div class="tag">${mb.toFixed(1)} MB · ${loading.files} files</div></div>`;
  }
  game.progress = share;
}
const ticker = setInterval(() => { if (loading.done) clearInterval(ticker); else progress(); }, 200);

// The circuit's outline, told once by the game: drawn as the display's
// map (H9), north up as the world has it, with the start line marked.
const map = { fit: null };
window.gameMap = json => {
  const told = JSON.parse(json);
  // The corners by name and station, for tools (`tools/takes.mjs`).
  game.circuit = { stations: told.stations, step: told.step, corners: told.corners };
  const points = told.outline;
  const xs = points.map(p => p[0]), zs = points.map(p => p[1]);
  const [x0, x1, z0, z1] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
  const scale = 92 / Math.max(x1 - x0, z1 - z0);
  const fit = map.fit = ([x, z]) => [4 + (x - x0) * scale + (92 - (x1 - x0) * scale) / 2, 4 + (z - z0) * scale + (92 - (z1 - z0) * scale) / 2];
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${fit(p).map(v => v.toFixed(1)).join(' ')}`).join('') + 'Z';
  $('map-road').setAttribute('d', d);
  // The line: a short stroke across the road at the first point.
  const [a, b] = [fit(points[0]), fit(points[1])];
  const along = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const [nx, ny] = [-(b[1] - a[1]) / along * 3.2, (b[0] - a[0]) / along * 3.2];
  $('map-line').setAttribute('d', `M${(a[0] - nx).toFixed(1)} ${(a[1] - ny).toFixed(1)}L${(a[0] + nx).toFixed(1)} ${(a[1] + ny).toFixed(1)}`);
};
function mapMark(state) {
  if (!map.fit || !state.where) return;
  // Every car of a race (H9), each in its colour; the player's dot is
  // drawn after them, on top.
  const cars = $('map-cars');
  const others = state.mode === 'race' ? state.tower.filter(row => row.car !== 0).sort((a, b) => a.car - b.car) : [];
  const made = others.map(row => row.colour).join();
  if (cars.dataset.made !== made) {
    cars.dataset.made = made;
    cars.innerHTML = others.map(row => `<circle r="3" fill="${row.colour}"/>`).join('');
  }
  others.forEach((row, i) => {
    const [x, y] = map.fit(row.at);
    cars.children[i].setAttribute('cx', x.toFixed(1));
    cars.children[i].setAttribute('cy', y.toFixed(1));
  });
  const [me] = state.where;
  // In a time trial the other dot is the ghost.
  const other = state.mode === 'race' ? null : state.where[1];
  if (me) { const [x, y] = map.fit(me); $('map-me').setAttribute('cx', x.toFixed(1)); $('map-me').setAttribute('cy', y.toFixed(1)); }
  const dot = $('map-other');
  const kind = !other ? 'none' : state.mode === 'race' ? 'rival' : 'ghost';
  if (dot.dataset.kind !== kind) dot.dataset.kind = kind;
  if (other) { const [x, y] = map.fit(other); dot.setAttribute('cx', x.toFixed(1)); dot.setAttribute('cy', y.toFixed(1)); }
}

window.gameState = json => {
  const first = !game.state;
  const state = game.state = JSON.parse(json);
  if (first) {
    applySettings();
    // `?auto=1`: the autopilot drives. `?auto=clean`, `mistake` or
    // `careless`: one of the game's test players does, in the keys' place
    // (`sim/src/players.rs`; `tools/takes.mjs` races them for a panel).
    // `?auto=hold120`: the clean player, never over 120 km/h.
    // `?auto=pace1`: the car drives itself at a level (1 is a
    // first-timer's pace), racing as the field's cars do.
    const named = query.get('auto') || '';
    if (named) ask(`auto ${PLAYERS.includes(named) || /^(hold\d+|pace-?[\d.]+)$/.test(named) ? named : 1}`);
  }
  if (first) loading.started = performance.now();
  // The title comes once the files have stopped coming and the game says
  // its cars are whole (a slow machine can still be making them).
  if (!loading.done && state.ready && performance.now() - loading.last > 2500 && performance.now() - loading.started > 3000) {
    loading.done = true;
    ask('warm');
    show('title');
  }
  for (const event of state.events) happened(event, state);
  rumble(state.feel);
  display(state);
  game.before = state;
};

// The best lap, kept between visits: the bytes the game gives, as text.
window.gameKeep = bytes => {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  store.set('ghost', btoa(text));
  // The lap's time is the eight bytes after the four that name the record.
  store.set('best', String(new DataView(bytes.buffer, bytes.byteOffset).getFloat64(4, true)));
};
window.gameGhost = () => {
  const kept = store.get('ghost');
  if (!kept) return new Uint8Array();
  try { return Uint8Array.from(atob(kept), c => c.charCodeAt(0)); } catch { return new Uint8Array(); }
};
const bestKept = () => Number(store.get('best')) || null;
const sectorsKept = () => { try { return JSON.parse(store.get('sectors')) ?? []; } catch { return []; } };

// ------------------------------------------------------------ rumble (I4)
// What the tyres and the body feel, as the game says each frame, sent to
// the pad's two motors, each cause its own pattern: a lock-up is a hard
// steady buzz in the heavy motor; wheelspin a fast buzz in the light one;
// a slide a soft pulse; a kerb a sharp beat as the ribs pass; grass a low
// uneven grumble; a hit one hard knock in both. The page writes what it
// asked to `window.rumbleLog`, which the test of I4 reads.
const FEEL = ['lock', 'spin', 'slide', 'kerb', 'grass', 'hit'];
const RUMBLE = {
  lock: t => [0.9, 0.15],
  spin: t => [0.15, 0.85],
  slide: t => [0.0, (t * 6) % 1 < 0.5 ? 0.45 : 0.1],
  kerb: t => [(t * 14) % 1 < 0.5 ? 0.8 : 0.0, 0.2],
  grass: t => [0.35 + 0.15 * Math.sin(t * 23) * Math.sin(t * 7), 0.25],
  hit: t => [1.0, 1.0],
};
window.rumbleLog = [];
// Each pattern at twenty moments over a second, for the test to compare.
window.RUMBLE_FOR_TEST = () => Object.fromEntries(Object.entries(RUMBLE).map(([k, f]) =>
  [k, Array.from({ length: 20 }, (_, i) => f(i / 20).map(v => +v.toFixed(2)))]));
let knock = 0;
function rumble(feel) {
  const pad = padNow();
  const motor = pad?.vibrationActuator;
  if (!motor || !feel || game.screen !== 'drive' || game.state?.paused) return;
  const t = performance.now() / 1000;
  // The strongest feeling now speaks; a hit is held for a fifth of a second.
  if (feel[5] > 0) knock = t + 0.2;
  let cause = null, level = 0;
  feel.forEach((v, i) => { if (v > level) { level = v; cause = FEEL[i]; } });
  if (t < knock) { cause = 'hit'; level = 1; }
  if (!cause) return;
  const [strong, weak] = RUMBLE[cause](t);
  const effect = { duration: 80, startDelay: 0, strongMagnitude: Math.min(1, strong * level), weakMagnitude: Math.min(1, weak * level) };
  motor.playEffect?.('dual-rumble', effect)?.catch?.(() => {});
  if (window.rumbleLog.length < 4000) window.rumbleLog.push({ cause, ...effect });
}

// ------------------------------------------------------------ keys and pad

const DEAD = 0.1;
function controls() {
  const key = action => settings.keys[action].some(code => game.held.has(code)) ? 1 : 0;
  const pad = padNow();
  const button = action => {
    const at = settings.buttons[action];
    return at == null ? 0 : pad?.buttons[at]?.value ?? 0;
  };
  const stick = pad && Math.abs(pad.axes[0]) > DEAD ? (pad.axes[0] - Math.sign(pad.axes[0]) * DEAD) / (1 - DEAD) : 0;
  return {
    throttle: Math.max(key('throttle'), button('throttle')),
    brake: Math.max(key('brake'), button('brake')),
    // The game's steering is positive to the left; a stick's is positive to the right.
    steer: Math.max(-1, Math.min(1, key('left') - key('right') + button('left') - button('right') - stick)),
    handbrake: key('handbrake') || (button('handbrake') > 0.5 ? 1 : 0),
  };
}

const padNow = () => [...(navigator.getGamepads?.() ?? [])].find(pad => pad && pad.connected) ?? null;
const padWas = [];
let stickWas = 0;
// A pad has no events for its buttons: look each frame for what changed.
function padPoll() {
  const pad = padNow();
  if (!pad) return;
  if (!game.pad) noticePad(pad);
  const pressed = i => pad.buttons[i]?.pressed && !padWas[i];
  const stick = Math.abs(pad.axes[1]) > 0.6 ? Math.sign(pad.axes[1]) : Math.abs(pad.axes[0]) > 0.6 ? 2 * Math.sign(pad.axes[0]) : 0;
  const pushed = stick !== stickWas ? stick : 0;
  if (padBinding) {
    const which = pad.buttons.findIndex((b, i) => b.pressed && !padWas[i]);
    if (which >= 0) {
      settings.buttons[padBinding] = which;
      padBinding = binding = null;
      saveSettings();
      render();
    }
  } else if (game.screen === 'drive') {
    const mine = action => settings.buttons[action] != null && pressed(settings.buttons[action]);
    if (mine('pause')) pause();
    for (const action of ['up', 'down', 'back', 'view', 'mute', 'fullscreen']) if (mine(action)) act(action);
  } else {
    if (pressed(12) || pushed === -1) move(-1);
    if (pressed(13) || pushed === 1) move(1);
    if (pressed(14) || pushed === -2) turn(-1);
    if (pressed(15) || pushed === 2) turn(1);
    if (pressed(0)) choose();
    if (pressed(1) || (pressed(9) && game.screen === 'pause')) back();
  }
  pad.buttons.forEach((button, i) => { padWas[i] = button.pressed; });
  stickWas = stick;
}
function noticePad(pad) {
  if (game.pad) return;
  game.pad = pad.id || 'gamepad';
  document.body.classList.add('pad');
  notice('GAMEPAD CONNECTED');
}
// A word to the player on any screen, for a few seconds.
let noticeEnds = null;
function notice(text) {
  $('notice').textContent = text;
  $('notice').hidden = false;
  clearTimeout(noticeEnds);
  noticeEnds = setTimeout(() => { $('notice').hidden = true; }, 3500);
}
addEventListener('gamepadconnected', event => noticePad(event.gamepad));
addEventListener('gamepaddisconnected', () => { game.pad = null; document.body.classList.remove('pad'); });
$('pause-button').addEventListener('click', () => pause());
// The pause button is for a mouse: it shows while one moves and for a
// moment after, not through a race driven by keys or a pad (the panel's
// judge of H8: "a web page's control that no released racing game's
// display carries").
let pointed = null;
addEventListener('pointermove', () => {
  document.body.classList.add('pointing');
  clearTimeout(pointed);
  pointed = setTimeout(() => document.body.classList.remove('pointing'), 2500);
});

// Something a key or a button does once, while driving.
function act(action) {
  if (action === 'up' || action === 'down') shifts[action] = true;
  if (action === 'back') ask('back');
  if (action === 'view') { settings.view = (settings.view + 1) % VIEWS.length; saveSettings(); }
  if (action === 'mute') window.soundMute?.();
  if (action === 'fullscreen') fullscreen();
}
function fullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}

let binding = null, padBinding = null;
addEventListener('keydown', event => {
  if (event.repeat) return event.preventDefault();
  window.soundStart?.();
  if (binding) {
    event.preventDefault();
    if (event.code !== 'Escape') { settings.keys[binding] = [event.code]; saveSettings(); }
    binding = padBinding = null;
    return render();
  }
  if (game.screen === 'drive') {
    if (event.code === 'Escape') return pause();
    if (event.metaKey || event.ctrlKey) return;
    game.held.add(event.code);
    for (const action of ['up', 'down', 'back', 'view', 'mute', 'fullscreen'])
      if (settings.keys[action].includes(event.code)) act(action);
    // Only for a developer or a test: hand the car to the autopilot.
    if (event.code === 'KeyP' && query.has('dev')) ask(`auto ${+!game.state.auto}`);
    return event.preventDefault();
  }
  const menu = {
    ArrowUp: () => move(-1), KeyW: () => move(-1), ArrowDown: () => move(1), KeyS: () => move(1),
    ArrowLeft: () => turn(-1), KeyA: () => turn(-1), ArrowRight: () => turn(1), KeyD: () => turn(1),
    Enter: choose, Space: choose, Escape: back,
  }[event.code];
  if (menu) { event.preventDefault(); menu(); }
  if (settings.keys.fullscreen.includes(event.code)) fullscreen();
});
addEventListener('keyup', event => game.held.delete(event.code));
addEventListener('pointerdown', () => window.soundStart?.());
// Hidden or out of focus: the race stops and every key is let go.
function away() {
  game.held.clear();
  if (game.screen === 'drive') pause();
}
addEventListener('blur', away);
document.addEventListener('visibilitychange', () => { if (document.hidden) away(); });

// ------------------------------------------------------------------ menus

const clock = (seconds, places = 3) => {
  if (seconds == null) return '–:––.–––'.slice(0, 5 + places);
  const whole = Math.floor(seconds / 60);
  return `${whole}:${(seconds - whole * 60).toFixed(places).padStart(places + 3, '0')}`;
};
const keyName = code => code.replace(/^Key|^Digit/, '').replace('Arrow', '').replace('Space', 'Space bar');
const onOff = flag => (flag ? 'On' : 'Off');
const medalOf = (time, medals) => time == null ? null : ['gold', 'silver', 'bronze'].find((_, i) => time <= medals[i]) ?? null;

// A choice among a few values, as a row of the options.
const choice = (label, name, values, text = String) => ({
  label, value: () => text(settings[name]),
  turn: by => {
    const at = values.indexOf(settings[name]);
    settings[name] = values[(at + by + values.length) % values.length];
    saveSettings();
  },
});
const level = (label, name) => ({
  label, value: () => '▮'.repeat(settings[name]) + '▯'.repeat(10 - settings[name]),
  turn: by => { settings[name] = Math.max(0, Math.min(10, settings[name] + by)); saveSettings(); },
});

let optionsFrom = 'title';
const SCREENS = {
  title: {
    title: 'TACHYON SPRINT', lead: 'One hill circuit. Seven rivals. Or the clock.',
    items: () => [
      { label: 'Race', go: () => show('race') },
      { label: 'Time trial', go: () => show('trial') },
      { label: 'Options', go: () => { optionsFrom = 'title'; show('options'); } },
    ],
  },
  race: {
    title: 'RACE', back: () => show('title'),
    body: () => `<p>A standing start under the lights. ${settings.laps} lap${settings.laps > 1 ? 's' : ''} against seven others in the same car.
      You start fifth of eight.</p><p class="facts"><span>Laps <b>${settings.laps}</b></span><span>${settings.rivals === 'match' ? 'Rivals <b>at your pace</b>' : `Level of the quickest <b>${settings.level} of 10</b>`}</span></p>`,
    items: () => [
      { label: 'Start', go: startRace },
      choice('Laps', 'laps', [1, 3, 5]),
      choice('Rivals', 'rivals', ['match', 'level'], v => v === 'match' ? 'Match my pace' : 'A fixed level'),
      choice('Fixed level', 'level', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
      { label: 'Back', go: () => show('title') },
    ],
  },
  trial: {
    title: 'TIME TRIAL', back: () => show('title'),
    body: () => {
      const medals = game.state.medals, best = bestKept();
      const row = (name, time) => `<span class="medal ${name}"><i></i>${name[0].toUpperCase() + name.slice(1)} <b>${clock(time)}</b></span>`;
      const won = medalOf(best, medals);
      return `<p>Flying laps against the ghost of your own best lap. The clock starts when you cross the line.</p>
        <p class="facts" id="medals">${row('gold', medals[0])}${row('silver', medals[1])}${row('bronze', medals[2])}</p>
        <p class="facts"><span>Your best <b id="kept-best">${clock(best)}</b>${won ? ` <em class="medal ${won}"><i></i>${won}</em>` : ''}</span></p>`;
    },
    items: () => [
      { label: 'Start', go: startTrial },
      { label: 'Back', go: () => show('title') },
    ],
  },
  options: {
    title: 'OPTIONS', back: () => show(optionsFrom),
    items: () => [
      { heading: 'Difficulty' },
      choice('Rival level', 'level', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], value => `${value} of 10`),
      { heading: 'Laps' },
      choice('Race length', 'laps', [1, 3, 5], value => `${value} lap${value > 1 ? 's' : ''}`),
      { heading: 'Aids' },
      choice('Anti-lock brakes', 'abs', [true, false], onOff),
      choice('Traction control', 'tc', ['high', 'low', 'off'], value => ({ high: 'High', low: 'Low', off: 'Off', true: 'High', false: 'Off' })[value]),
      choice('Stability control', 'stability', [true, false], onOff),
      choice('Gears', 'gears', ['auto', 'hand'], value => value === 'hand' ? 'By hand' : 'Automatic'),
      choice('Racing line', 'line', ['off', 'corners', 'full'], value => ({ off: 'Off', corners: 'Corners', full: 'Full' })[value]),
      { heading: 'View' },
      choice('Camera', 'view', [0, 1, 2, 3], value => VIEWS[value]),
      { label: 'Full screen', value: () => onOff(!!document.fullscreenElement), turn: fullscreen },
      { heading: 'Volumes' },
      level('Everything', 'master'), level('Car', 'car'), level('Lights, laps and menus', 'effects'), level('Menu music', 'music'),
      { heading: 'Controls' },
      { label: 'Keys', value: () => 'Change…', go: () => show('controls') },
      { heading: 'Display' },
      choice('Speed in', 'units', ['km/h', 'mph']),
      choice('Readout for developers', 'readout', [false, true], onOff),
      { label: 'Back', go: () => show(optionsFrom) },
    ],
  },
  controls: {
    title: 'CONTROLS', back: () => show('options'),
    body: () => `<p>Choose an action, then press the key for it, or the pad's button for it.
      Escape always pauses as well. The pad's left stick always steers.</p>`,
    items: () => [
      ...Object.entries(ACTIONS).map(([action, label]) => ({
        label, bind: action,
        value: () => binding === action ? 'Press a key or a button…'
          : `${settings.keys[action].map(keyName).join(' or ')}${settings.buttons[action] != null ? ` · pad ${BUTTONS[settings.buttons[action]] ?? settings.buttons[action]}` : ''}`,
        go: () => { binding = padBinding = action; render(); },
      })),
      { label: 'Pause', bind: 'pause',
        value: () => binding === 'pause' ? 'Press a pad button…' : `Escape · pad ${BUTTONS[settings.buttons.pause] ?? '-'}`,
        go: () => { padBinding = 'pause'; binding = null; render(); } },
      { label: 'Put all back as they were', go: () => { settings.keys = structuredClone(DEFAULTS.keys); settings.buttons = structuredClone(DEFAULTS.buttons); saveSettings(); render(); } },
      { label: 'Back', go: () => show('options') },
    ],
  },
  pause: {
    title: 'PAUSED', back: resume,
    items: () => [
      { label: 'Resume', go: resume },
      { label: 'Restart', go: again },
      { label: 'Options', go: () => { optionsFrom = 'pause'; show('options'); } },
      { label: 'Leave for the menu', go: toMenu },
    ],
  },
  result: {
    title: 'RESULT', back: toMenu,
    body: () => '<table id="result"></table><p id="suggest" class="lead"></p>',
    items: () => [
      { label: 'Race again', go: again },
      { label: 'Menu', go: toMenu },
    ],
  },
};

let items = [], focus = 0;
function show(screen) {
  const was = game.screen;
  game.screen = screen;
  binding = null;
  document.body.dataset.screen = screen;
  // Leaving options for where it was opened from puts the cursor back there.
  focus = 0;
  render();
  if (screen !== 'drive' && was !== screen) window.soundPlay?.('menu');
  // Music in the menus only: never while driving, and not while paused,
  // when all sound stops.
  window.soundScene?.(screen === 'drive' ? 'drive' : screen === 'pause' || (screen !== 'result' && inRace()) ? 'paused' : 'menu');
}
const inRace = () => !!game.mode;

function render() {
  const menu = $('menu');
  const screen = SCREENS[game.screen];
  if (!screen) { menu.hidden = true; return; }
  menu.hidden = false;
  items = screen.items();
  written.delete('result');
  const rows = items.map((item, i) => item.heading
    ? `<li class="heading">${item.heading}</li>`
    : `<li class="item${item.turn ? ' turns' : ''}" data-item="${i}"${item.bind ? ` data-bind="${item.bind}"` : ""}><span class="label">${item.label}</span>${
      item.value ? `<span class="value">${item.turn ? '<b class="less">‹</b>' : ''}<span>${item.value()}</span>${item.turn ? '<b class="more">›</b>' : ''}</span>` : ''}</li>`);
  menu.innerHTML = `<div class="card"><h1>${screen.title}</h1>${screen.lead ? `<p class="lead">${screen.lead}</p>` : ''}
    <div class="body">${screen.body?.() ?? ''}</div><ul>${rows.join('')}</ul>
    <p class="hint"><span class="for-keys">↑ ↓ choose · ← → change · Enter select · Esc back</span><span class="for-pad">Stick or D-pad choose · A select · B back</span></p></div>`;
  if (items[focus]?.heading) move(1, true);
  mark();
  if (game.screen === 'result') result(game.state);
}
const pickable = i => items[i] && !items[i].heading;
function mark() {
  for (const row of $('menu').querySelectorAll('.item')) row.classList.toggle('on', +row.dataset.item === focus);
  $('menu').querySelector('.item.on')?.scrollIntoView({ block: 'nearest' });
}
function move(by, quiet) {
  let next = focus;
  do next = (next + by + items.length) % items.length; while (!pickable(next) && next !== focus);
  focus = next;
  mark();
  if (!quiet) window.soundPlay?.('menu');
}
function refresh() {
  const at = focus;
  render();
  focus = at;
  mark();
}
function turn(by) {
  const item = items[focus];
  if (!item?.turn) return;
  item.turn(by);
  window.soundPlay?.('menu');
  refresh();
}
function choose() {
  const item = items[focus];
  if (!item) return;
  if (item.go) return item.go();
  turn(1);
}
function back() { SCREENS[game.screen]?.back?.(); }
document.addEventListener('fullscreenchange', () => { if (game.screen === 'options') refresh(); });
$('menu').addEventListener('pointermove', event => {
  const row = event.target.closest('.item');
  if (row && +row.dataset.item !== focus) { focus = +row.dataset.item; mark(); }
});
$('menu').addEventListener('click', event => {
  const row = event.target.closest('.item');
  if (!row) return;
  focus = +row.dataset.item;
  mark();
  if (event.target.closest('.less')) return turn(-1);
  choose();
});

// ---------------------------------------------------------------- the race

// The first race of a first visit (F2): the aids chosen for what the
// player drives with, and the controls shown for that.
function firstRun() {
  if (!settings.firstRun) return;
  settings.firstRun = false;
  const pad = !!padNow();
  // On keys every aid is on, high; a pad's triggers and stick can hold a
  // slide, so traction control is low; the racing line near corners for
  // both, a first time round.
  Object.assign(settings, pad
    ? { abs: true, tc: 'low', stability: true, gears: 'auto', line: 'corners' }
    : { abs: true, tc: 'high', stability: true, gears: 'auto', line: 'corners' });
  saveSettings();
  const k = action => settings.keys[action].map(keyName).join(' / ');
  const text = pad
    ? 'LEFT STICK STEER · RT THROTTLE · LT BRAKE · A HANDBRAKE · RB / LB GEARS · Y VIEW · START PAUSE'
    : `${k('throttle')} THROTTLE · ${k('brake')} BRAKE · ${k('left')} ${k('right')} STEER · ${k('handbrake')} HANDBRAKE · ${k('view')} VIEW · ESC PAUSE`;
  $('firstrun').innerHTML = `<b>${pad ? 'Gamepad' : 'Keys'}</b><span>${text.split(' · ').map(item => `<i>${item}</i>`).join('')}</span><em>Aids set for ${pad ? 'a pad' : 'keys'}: change them in Options</em>`;
  $('firstrun').hidden = false;
  setTimeout(() => { $('firstrun').hidden = true; }, 9000);
}

function begin(mode, command) {
  firstRun();
  game.mode = mode;
  game.started += 1;
  game.messages.length = 0;
  clearTimeout(resultSoon);
  resultSoon = null;
  $('messages').innerHTML = '';
  ask(command);
  ask('pause 0');
  applySettings();
  window.soundPause?.(false);
  show('drive');
}
function startRace() {
  // The seed decides how long the lights hold: by chance for a person,
  // `?seed=7` for a tool that wants the same race every time.
  // `?field=2` for a test that wants the one rival (and what six more cars cost).
  // The field meets the player (O9) unless a fixed level is chosen or a
  // test asks for fewer cars: from level 3 on a first visit, from what the
  // last race read after that.
  const match = settings.rivals === 'match' && !query.get('field') && !query.get('fixed');
  game.matched = match;
  begin('race', `race ${settings.laps} ${match ? 3 : settings.level} ${Number(query.get('seed')) || Math.floor(Math.random() * 1e9)} ${Number(query.get('field')) || 8} ${match ? 1 : 0} ${match ? Number(store.get('read')) || 0 : 0}`);
}
function startTrial() {
  const sectors = sectorsKept();
  begin('trial', `trial ${[0, 1, 2].map(i => sectors[i] ?? 0).join(' ')}`);
  game.sawGhost = false;
}
function again() { (game.mode === 'trial' ? startTrial : startRace)(); }
function toMenu() {
  game.mode = null;
  clearTimeout(resultSoon);
  resultSoon = null;
  ask('demo');
  ask('pause 0');
  window.soundPause?.(false);
  show('title');
}
function pause() {
  if (game.screen !== 'drive') return;
  game.held.clear();
  ask('pause 1');
  window.soundPause?.(true);
  show('pause');
}
function resume() {
  ask('pause 0');
  window.soundPause?.(false);
  show('drive');
}

// What the simulation says happened, said and sounded at that moment.
let resultSoon = null;
function happened(event, state) {
  const [what, a, b, c] = event;
  if (state.mode === 'demo') return;
  if (what === 'light') window.soundPlay?.('light');
  if (what === 'out') window.soundPlay?.('go');
  if (what === 'sector') {
    // Against the best of that sector as it stood before this one.
    const best = state.bestSectors[a], stood = game.before?.bestSectors[a];
    const against = stood == null ? '' : `  ${signed(b - stood)}`;
    say(`SECTOR ${a + 1}  ${b.toFixed(3)}${against}${c ? '  BEST' : ''}`, c ? 'best' : 'plain', true);
    if (c && state.mode === 'trial' && best != null) {
      const kept = sectorsKept();
      kept[a] = best;
      store.set('sectors', JSON.stringify(kept));
    }
  }
  if (what === 'lap') {
    window.soundPlay?.('lap');
    const why = game.ruled ? 'TRACK LIMITS' : 'PUT BACK ON THE ROAD';
    say(c ? `LAP ${clock(a)}${b ? '  BEST LAP' : ''}` : `LAP ${clock(a)}  NOT COUNTED: ${why}`, b ? 'best' : c ? 'plain' : 'warn');
    game.ruled = false;
  }
  // Past the track limits for an advantage (R8): in a race, time added;
  // in a time trial, the lap will not count.
  if (what === 'ruling') {
    const kind = a ? 'CORNER CUT' : 'TRACK LIMITS';
    if (state.mode === 'race') say(`${kind}  +${c.toFixed(3)} s PENALTY`, 'warn');
    else { game.ruled = true; say(`${kind}  LAP WILL NOT COUNT`, 'warn'); }
  }
  if (what === 'final') say('FINAL LAP', 'note');
  if (what === 'finish' && a === 0) say(`FINISH  ${['1ST', '2ND'][b - 1] ?? b}`, 'flag');
  if (what === 'back') say('BACK ON THE ROAD', 'note');
  if (what === 'ghost') say('NEW GHOST', 'best');
}

// A message at the top of the screen, for a few seconds.
function say(text, kind = 'plain', brief = false) {
  game.messages.push({ text, kind, at: performance.now() });
  const line = document.createElement('div');
  line.className = `message ${kind}`;
  line.textContent = text;
  $('messages').append(line);
  while ($('messages').children.length > 3) $('messages').firstChild.remove();
  setTimeout(() => line.remove(), brief ? 2600 : 3800);
}

// ------------------------------------------------------------- the display

const written = new Map();
function write(id, text, kind) {
  const was = written.get(id);
  if (was?.text === text && was?.kind === kind) return;
  written.set(id, { text, kind });
  const element = $(id);
  if (element.textContent !== text) element.textContent = text;
  if (kind !== undefined) element.dataset.kind = kind;
}
// A difference in seconds with its sign; one that rounds to nothing has none.
const signed = (seconds, places = 3) => {
  const shown = Math.abs(seconds).toFixed(places);
  return `${+shown === 0 ? '' : seconds < 0 ? '−' : '+'}${shown}`;
};

const LEDS = 12;
$('leds').innerHTML = '<i></i>'.repeat(LEDS);
$('lights').innerHTML = '<i></i>'.repeat(5);

// A car beside or behind (H5): a mark at each side of the screen for the
// nearest car on that side, "close" while it is behind within 25 m,
// "level" once its nose reaches the player's rear wheels; nothing while
// it is ahead and in view. `game.nearMark` says what is shown, for a
// test: "none", or such as "level left" or "close left, level right".
function nearMark(state) {
  const shown = [];
  ['left', 'right'].forEach((side, i) => {
    const near = state.mode === 'race' ? state.sides?.[i] : null;
    const kind = !near ? 'none' : near[0] > -4.5 ? 'level' : 'close';
    const mark = $(`near-${side}`);
    if (mark.dataset.kind !== kind) mark.dataset.kind = kind;
    if (near) shown.push(`${kind} ${side}`);
  });
  game.nearMark = shown.join(', ') || 'none';
}

// The order of the field (H10): every car's place, number and name and
// its gap to the car a place ahead, as the simulation gives them
// (`Race::tower`); the player's row is marked. Each car keeps its row,
// which is moved to its place, so a change of places is seen to happen.
// A gap is shown to a tenth while the cars race (it changes every frame)
// and to a thousandth once both have finished.
const towerText = row => row.out ? 'OUT'
  : row.gap == null ? (row.place === 1 ? (row.finished ? '' : 'LEADER') : '')
    : `+${row.gap.toFixed(row.finished ? 3 : 1)}`;
function tower(state) {
  const box = $('tower');
  const rows = state.mode === 'race' ? state.tower : [];
  const made = rows.map(row => row.car).sort((a, b) => a - b).join();
  if (box.dataset.made !== made) {
    box.dataset.made = made;
    box.style.height = `calc(${rows.length} * var(--row))`;
    box.innerHTML = [...rows].sort((a, b) => a.car - b.car).map(row =>
      `<div class="car${row.car === 0 ? ' you' : ''}" data-car="${row.car}" style="--c:${row.colour}"><b></b><i></i><u>${row.number}</u><span>${row.name}</span><em></em></div>`).join('');
  }
  for (const row of rows) {
    const line = box.querySelector(`[data-car="${row.car}"]`);
    const text = towerText(row);
    const now = `${row.place} ${text} ${row.finished} ${row.out}`;
    if (line.dataset.now === now) continue;
    line.dataset.now = now;
    line.dataset.place = row.place;
    line.dataset.state = row.out ? 'out' : row.finished ? 'finished' : 'racing';
    line.style.transform = `translateY(calc(${row.place - 1} * var(--row)))`;
    line.children[0].textContent = row.place;
    line.children[4].textContent = text;
    line.children[4].dataset.kind = /^[A-Z]/.test(text) ? 'word' : 'time';
  }
}

function display(state) {
  nearMark(state);
  mapMark(state);
  const driving = game.screen === 'drive' || game.screen === 'pause';
  document.body.classList.toggle('driving', driving && state.mode !== 'demo');
  document.body.dataset.mode = state.mode;
  const mph = settings.units === 'mph';
  const speed = Math.round(state.speed * (mph ? 0.621371 : 1));
  // What a test or a tool can read of the car without the display.
  window.hudText = `${speed} ${settings.units}   gear ${state.gear}   ${state.rpm} rpm\n${state.mode} ${state.phase}   place ${state.place} of ${state.cars}   lap ${state.lap} of ${state.laps}   ${clock(state.time)}\n${state.frame.toFixed(1)} ms a frame   ${state.auto ? 'autopilot' : 'driver'}   ${game.screen}`;
  if (settings.readout) write('readout', `${window.hudText}\nthrottle ${state.throttle} brake ${state.brake} steer ${state.steer}\n${state.hash}`);
  if (state.mode === 'demo') return;

  // Speed, gear, revs: a bar to the red line, and lights that fill
  // towards the change and flash at it.
  write('speed', String(speed));
  write('unit', settings.units.toUpperCase());
  write('gear', state.gear);
  const revs = Math.min(1, state.rpm / state.redline);
  $('revs-fill').style.width = `${(revs * 100).toFixed(1)}%`;
  $('revs-red').style.left = `${(state.shift / state.redline * 100).toFixed(1)}%`;
  const lit = Math.round(Math.max(0, Math.min(1, (state.rpm - 0.6 * state.shift) / (0.37 * state.shift))) * LEDS);
  const change = state.rpm >= 0.97 * state.shift;
  if (written.get('leds') !== `${lit}${change}`) {
    written.set('leds', `${lit}${change}`);
    [...$('leds').children].forEach((led, i) => { led.className = i < lit ? (change ? 'change' : i < 5 ? 'low' : i < 9 ? 'mid' : 'high') : ''; });
  }
  write('rpm', `${(state.rpm / 1000).toFixed(1)}`);

  // Place, lap and times.
  const race = state.mode === 'race';
  write('place', race ? `${state.place}` : '');
  write('of', race ? `/${state.cars}` : '');
  write('lap', race ? `${state.lap}` : `${Math.max(1, state.lap)}`);
  write('laps', race ? `/${state.laps}` : '');
  const running = state.phase === 'racing' && !state.finished && !state.out;
  write('time', race && state.phase === 'lights' ? clock(0) : running || state.time ? clock(state.time) : clock(null));
  write('last', clock(state.last));
  write('best', clock(state.best));

  // Ahead of the best lap or behind it: by sign, by word and by colour.
  const delta = running ? state.delta : null;
  const even = delta != null && +Math.abs(delta).toFixed(3) === 0;
  write('delta', delta == null ? '' : `${even ? '●' : delta < 0 ? '▼' : '▲'} ${signed(delta)}`, delta == null ? 'none' : even ? 'level' : delta < 0 ? 'ahead' : 'behind');

  // The order of the field, and the gaps to the car ahead on the road
  // and to the car behind, in seconds (H4).
  tower(state);
  for (const [id, value] of [['gap-ahead', state.ahead], ['gap-behind', state.behind]]) {
    const gap = race && running ? value : null;
    write(id, gap == null ? '' : `${gap.toFixed(gap < 10 ? 2 : 1)} s`, gap == null ? 'none' : 'gap');
  }
  // A penalty held (R8) is in sight while it is held.
  const held = race && state.penalty > 0;
  if ($('pen-row').hidden === held) $('pen-row').hidden = !held;
  write('pen', held ? `+${state.penalty.toFixed(3)} s` : '');

  // Sectors of this lap, against the best of each. Through the first
  // sector of a lap the three of the lap just finished stay up, so the
  // third is seen.
  const shown = state.sectors[0] == null && state.lapSectors[2] != null ? state.lapSectors : state.sectors;
  for (let i = 0; i < 3; i++) {
    const time = shown[i], best = state.bestSectors[i];
    const kind = time == null ? (state.sector === i && running ? 'now' : 'none') : best != null && time <= best + 5e-4 ? 'best' : 'slower';
    $(`s${i + 1}`).parentElement.classList.toggle('last-lap', shown !== state.sectors);
    write(`s${i + 1}`, time == null ? '–' : time.toFixed(3), kind);
  }

  // The time trial's targets, and whether the ghost is out.
  if (!race) {
    const medals = state.medals;
    const won = medalOf(state.best, medals);
    const next = won === 'gold' ? null : won === 'silver' ? 0 : won === 'bronze' ? 1 : 2;
    write('target', next == null ? 'GOLD' : `${['GOLD', 'SILVER', 'BRONZE'][next]} ${clock(medals[next])}`, won ?? 'none');
    write('ghost', state.ghostOn ? 'GHOST: YOUR BEST' : state.ghost ? 'GHOST AT THE LINE' : 'NO GHOST YET');
    // A lap kept from before that the game would not take is forgotten.
    if (state.clock > 0.1 && !game.sawGhost) {
      game.sawGhost = true;
      if (!state.ghost && store.get('ghost')) { store.drop('ghost'); store.drop('best'); store.drop('sectors'); }
    }
  }

  // The start lights.
  const lights = state.phase === 'lights' ? state.lights : 0;
  $('lights').dataset.on = state.phase === 'lights' ? 'yes' : 'no';
  if (written.get('lights') !== lights) {
    written.set('lights', lights);
    [...$('lights').children].forEach((light, i) => light.classList.toggle('lit', i < lights));
  }
  $('wrong').hidden = !state.wrong || !running;

  // Past the flag, or out: the result, after a moment to see the flag.
  if (race && (state.finished || state.out) && game.screen === 'drive' && !resultSoon) {
    if (state.out) say('DID NOT FINISH', 'warn');
    resultSoon = setTimeout(() => { resultSoon = null; if (game.screen === 'drive') show('result'); }, 1600);
  }
  if (game.screen === 'result') result(state);
}

function result(state) {
  const table = $('result');
  if (!table || !state) return;
  // Every car of the field (R4): those past the flag with their times,
  // the others as still racing, filled in as each crosses the line.
  const cars = new Map(state.tower.map(row => [row.car, row]));
  const rows = state.result.map(row => {
    const done = row.time != null;
    const gap = row.place === 1 ? '' : row.gap != null ? `+${row.gap.toFixed(3)}` : done ? `+${state.result[0].laps - row.laps} lap` : '';
    const car = cars.get(row.car);
    return `<tr class="${row.car === 0 ? 'you' : ''}"><td>${row.place}</td><td><i style="--c:${car?.colour}">${car?.number ?? ''}</i>${car?.name ?? ''}</td>
      <td>${done ? clock(row.time) : row.out ? 'Did not finish' : 'Still racing'}${row.penalty > 0 ? ` <small>incl. +${row.penalty.toFixed(3)} s penalty</small>` : ''}</td><td>${clock(row.best)}</td><td>${gap}</td></tr>`;
  });
  const html = `<tr><th></th><th style="text-align:left">Driver</th><th>Race time</th><th>Best lap</th><th>Gap</th></tr>${rows.join('')}`;
  if (written.get('result') !== html) { written.set('result', html); table.innerHTML = html; }
  // A level to try next (O8): the quickest rival that laps no faster than
  // the player's best lap of this race. Each level is 2 % of a lap from the
  // next and the tenth is 0.8 % off the reference lap, which the gold time
  // is 2 % off (O3, R9). Said between races only, here.
  const mine = state.result.find(row => row.car === 0);
  const gold = state.medals?.[0];
  let text = '';
  if (mine?.best != null && mine.time != null && gold) {
    const lap = level => gold * 0.988 * 1.02 ** (10 - level);
    let fits = 1;
    for (let level = 1; level <= 10; level++) if (lap(level) >= mine.best * 0.995) fits = level;
    game.suggested = fits;
    text = fits === settings.level ? `Rival level ${fits} of 10 is about your pace.`
      : `Your best lap was ${clock(mine.best)}: a rival at level ${fits} of 10 laps about as fast (this one was level ${settings.level}). Change it under Race.`;
  }
  // A field that met the player says what it read, and the next race
  // begins there.
  if (game.matched && state.read != null) {
    store.set('read', String(state.read));
    text = `The field took your measure on the first lap: level ${state.read.toFixed(1)} of 10. Your next race starts there.`;
  }
  if ($('suggest') && $('suggest').textContent !== text) $('suggest').textContent = text;
}
