// The car's sound, played according to what the simulation says the car is
// doing.
//
// What it plays is listed in `assets/sound/sounds.json`, which
// `tools/sounds.py` writes: each sound is a description in the game's own
// `sounds.json`, turned into a recording by ElevenLabs, and its `use` there
// says what it is for. Where that list has nothing for a use, the page does
// what it did before there was one: recordings of a real car stand in for
// engine and tyres (`tools/fetch-assets.sh`), shaped noise for road, wind
// and grass, and a kind of sound with no recording is not played.
//
// Every frame the game calls `window.soundCar(json)`: the view, the
// engine's speed, throttle, brake, gear, each wheel (what it is on and how
// hard its tyre works), a hit, and where the rival is. From that:
//
// - The engine is two sets of loops, each loop labelled with the engine
//   speed its pitch is: one set under load and one on the overrun, chosen
//   by the throttle and crossfaded in a few hundredths of a second. Within
//   a set the loop nearest the engine's speed plays, faster or slower so
//   its pitch is the engine's, blended with its neighbour only where both
//   are within a quarter of their labels. The speed of a loop is set at
//   once, never eased: a gear change is a step, with a short sound of its
//   own.
// - Tyres, the left wheels on the left and the right on the right: rolling
//   on what is under them (road, kerb, grass, gravel, each its own loop,
//   and stones thrown up on gravel); a howl from nine tenths of the tyre's
//   grip; past it a squeal, or the sound of a locked wheel, a slide or
//   wheelspin, whichever it is.
// - A hit by how hard and on what: a tap or a heavy hit on rail, tyres,
//   wall or car, never twice the same; contact that goes on is a scrape.
// - The rival's engine: louder as it nears, on its side, higher as it
//   closes and lower as it draws away.
// - Each view its own balance of engine, exhaust, tyres, wind and road.
//
// Everything goes through a limiter to the speakers. What is asked of
// every voice can be read (`soundAsked()`, and `soundShots` for the short
// sounds), so a test can check what the game asked for without hearing it;
// whether any of it sounds good is for a person.
//
// A browser only lets a page make sound after a key or a click, so it
// starts on the first one (`soundStart`, which the page calls from its own
// key and click handlers). The page says which scene it is in
// (`soundScene`): in the menus there is music and no car; while driving
// there is the car and no music. `soundPlay(name)` plays a short sound
// once: a start light, the lights going out (the same recording, higher),
// a lap, a move in a menu. `soundPause` stops everything and starts it
// again. Those requests are written to `window.soundLog`.

// Recordings of a real Corvette's V8 and of real tyres, used for whatever
// the made list does not cover.
const RECORDED = [
  { name: 'engine_idle.wav', use: 'engine', rpm: 950, file: 'assets/sound/engine_idle.wav' },
  { name: 'engine_3000.wav', use: 'engine', rpm: 2870, file: 'assets/sound/engine_3000.wav' },
  { name: 'tyres.wav', use: 'tyres', file: 'assets/sound/tyres.wav' },
];

// How far from its label a loop may be played: a quarter faster or slower.
const REACH = 0.25;
// Loudness is eased over this many seconds; the speed of a loop over none.
const EASE = 0.03;
// How loud each part is from each view (far chase, near chase, bonnet,
// driver's eye): behind the car the exhaust leads; in the car the engine,
// the wind and the road are close.
const VIEWS = [
  { engine: 0.7, exhaust: 1.0, tyres: 0.7, wind: 0.5, road: 0.5 },
  { engine: 0.8, exhaust: 0.95, tyres: 0.85, wind: 0.6, road: 0.6 },
  { engine: 1.0, exhaust: 0.7, tyres: 1.0, wind: 1.0, road: 0.8 },
  { engine: 0.95, exhaust: 0.6, tyres: 0.9, wind: 0.8, road: 1.0 },
];
// A hit this hard (newton seconds) is a heavy one.
const HEAVY = 1500;
// What each thing hit sounds like: a fence as a rail, a board as a wall.
const STRUCK = { rail: 'rail', tyres: 'tyres', wall: 'wall', car: 'car', fence: 'rail', board: 'wall' };

// The sounds to play, by use: the made ones where there are any.
async function listed() {
  let made = [];
  try {
    // Always asked for afresh: a browser that keeps an old list does not
    // know of sounds made since.
    const reply = await fetch('assets/sound/sounds.json', { cache: 'no-cache' });
    if (reply.ok) made = (await reply.json()).sounds ?? [];
  } catch { /* no list: recordings only */ }
  const of = use => made.filter(sound => sound.use === use);
  const first = use => of(use)[0] ?? RECORDED.find(sound => sound.use === use);
  // Engine loops, slowest first; one with no label cannot be played.
  const labelled = loops => loops.filter(sound => sound.rpm > 0).sort((a, b) => a.rpm - b.rpm);
  // The idle is the same recording on the throttle and off it.
  let load = labelled([...of('idle'), ...of('load')]);
  if (!labelled(of('load')).length) load = labelled(of('engine'));
  if (!load.length) load = labelled(RECORDED.filter(sound => sound.use === 'engine'));
  const overrun = labelled(of('overrun')).length ? labelled([...of('idle'), ...of('overrun')]) : [];
  window.soundSource = made.length ? `made (${made.map(sound => sound.name).join(', ')})` : 'recordings';
  return {
    load, overrun,
    tyres: { squeal: first('tyres'), howl: first('howl'), lock: first('lock'), slide: first('slide'), spin: first('spin') },
    ground: { road: first('road'), kerb: first('kerb'), grass: first('grass'), gravel: first('gravel') },
    wind: first('wind'),
    stones: of('stones'), shift: of('shift'), hit: of('hit'), scrape: of('scrape'),
    // Played once each: a start light, a lap, a menu move.
    once: Object.fromEntries(['light', 'lap', 'menu'].map(use => [use, first(use)])),
    music: first('music'),
  };
}

let audio = null, voices = null, muted = false, starting = null;
// How loud each part may be (the options set these), and where the page is.
const levels = { master: 0.8, car: 1, effects: 0.8, music: 0.6 };
let scene = 'menu', paused = false;
window.soundLog = [];
const note = (what, more = {}) => {
  window.soundLog.push({ what, scene, context: audio?.state ?? 'none', at: performance.now(), ...more });
  if (window.soundLog.length > 400) window.soundLog.shift();
};
// Every short sound of the car's that was asked for: which recording, how
// loud, how fast, from which side, and in which frame.
window.soundShots = [];

// The car as the game last described it, and what came of it.
let car = null, frame = 0, heard = false;
const was = { gear: null, shifting: false, contact: 0, clear: 99, push: 0 };
const now = { view: 1, parts: { ...VIEWS[1] }, tone: null, load: 0, overrun: 0, rival: 0, rivalPan: 0 };

const clamp = (value, low = 0, high = 1) => Math.max(low, Math.min(high, value));
// From 0 at `from` to 1 at `to`.
const ramp = (value, from, to) => clamp((value - from) / (to - from));

// Move a setting towards a value over a few hundredths of a second, asked
// only when the value changes.
function ease(param, value, over = EASE) {
  if (param.asked === value) return;
  param.asked = value;
  param.setTargetAtTime(value, audio.currentTime, over);
}
// Ask one voice for a loudness (eased) and a speed (at once).
function ask(voice, gain, rate) {
  voice.own = gain;
  ease(voice.gain.gain, gain);
  if (rate !== undefined && voice.source && voice.rate !== rate) {
    voice.rate = rate;
    voice.source.playbackRate.value = rate;
  }
}

// Set every part's loudness for the scene and the options as they are now.
function mix() {
  if (!voices) return;
  const time = audio.currentTime;
  voices.out.gain.setTargetAtTime(muted ? 0 : levels.master, time, 0.03);
  voices.car.gain.setTargetAtTime(scene === 'drive' ? levels.car : 0, time, 0.05);
  voices.effects.gain.setTargetAtTime(levels.effects, time, 0.03);
  voices.music.gain.setTargetAtTime(scene === 'menu' ? levels.music * 0.5 : 0, time, scene === 'menu' ? 0.6 : 0.08);
}
window.soundSet = wanted => { Object.assign(levels, wanted); mix(); };
window.soundScene = name => {
  if (name !== scene) note('scene', { name });
  scene = name;
  mix();
};
window.soundPlay = name => {
  // The lights going out are the light's own sound, half as high again.
  const buffer = voices?.once[name === 'go' ? 'light' : name];
  note('play', { name, have: !!buffer });
  if (!buffer || audio.state !== 'running') return;
  const source = audio.createBufferSource();
  source.buffer = buffer;
  // No two the same: each a shade higher or lower than the last.
  source.playbackRate.value = name === 'menu' ? 0.96 + Math.random() * 0.08 : name === 'go' ? 1.5 : 1;
  source.connect(voices.effects);
  source.start();
};
// Stop every sound where it is, and start again from there.
window.soundPause = stop => {
  paused = stop;
  note(stop ? 'pause' : 'resume');
  if (!audio) return;
  if (stop) audio.suspend(); else audio.resume();
};
window.soundMute = () => { muted = !muted; window.soundOn = !muted; mix(); };
// What a test may read: the state of the sound and what is turned up.
window.soundState = () => ({
  context: audio?.state ?? 'none', scene, paused, muted, ready: !!voices,
  have: voices ? { music: !!voices.musicBuffer, ...Object.fromEntries(Object.entries(voices.once).map(([k, v]) => [k, !!v])) } : {},
  music: voices?.music.gain.value ?? 0, car: voices?.car.gain.value ?? 0,
  musicAsked: scene === 'menu' ? levels.music * 0.5 : 0, carAsked: scene === 'drive' ? levels.car : 0,
  // The limiter, as it is set, and what the sound passes through on its
  // way out, in order.
  limiter: voices ? Object.fromEntries(['threshold', 'knee', 'ratio', 'attack', 'release'].map(k => [k, +voices.limiter[k].value.toFixed(4)])) : null,
  chain: voices?.chain ?? [],
  // The engine's loops and their labels, by set.
  engine: voices ? { load: voices.load.map(v => `${v.name} ${v.label}`), overrun: voices.overrun.map(v => `${v.name} ${v.label}`) } : {},
});

// How loud each voice's part of the mix is asked to be now.
const bus = {
  engine: () => now.load * now.parts.engine,
  exhaust: () => now.overrun * now.parts.exhaust,
  tyres: () => now.parts.tyres,
  surface: () => now.parts.road,
  wind: () => now.parts.wind,
  rival: () => now.rival,
  scrape: () => 1,
};
// What is asked of every voice now: its recording, its part, how loud
// (its own loudness times its part's, before the options' volumes), how
// fast it is played, and from which side (-1 left to 1 right).
window.soundAsked = () => ({
  ready: !!voices, frame, view: now.view, parts: { ...now.parts }, tone: now.tone,
  ease: { gain: EASE, rate: 0 },
  voices: voices ? voices.all.map(v => ({
    name: v.name, part: v.part, kind: v.kind, label: v.label,
    gain: v.own * bus[v.part](), rate: v.rate, pan: v.part === 'rival' ? now.rivalPan : v.pan,
  })) : [],
});
// How loud the two sets of the engine are at this moment (not what is
// asked: where the easing has got to).
window.soundLive = () => voices ? { load: voices.loadSet.gain.value, overrun: voices.overSet.gain.value } : null;

// Which loops of a set play at an engine speed, and how much of each: the
// two labelled either side of it, crossed over only where both are within
// their reach; where they leave a gap, the nearer in pitch alone.
function blend(set, rpm) {
  const shares = set.map(() => 0);
  if (!set.length) return shares;
  const above = set.findIndex(loop => loop.label >= rpm);
  if (above === 0) shares[0] = 1;
  else if (above < 0) shares[set.length - 1] = 1;
  else {
    const a = set[above - 1].label, b = set[above].label;
    const from = Math.max(a, b * (1 - REACH)), to = Math.min(b, a * (1 + REACH));
    const part = to > from ? ramp(rpm, from, to) : rpm * rpm > a * b ? 1 : 0;
    // Equal power, so the blend between two recordings does not dip.
    shares[above - 1] = part >= 1 ? 0 : Math.cos(part * Math.PI / 2);
    shares[above] = part <= 0 ? 0 : Math.sin(part * Math.PI / 2);
  }
  return shares;
}
function engine(set, rpm) {
  const shares = blend(set, rpm);
  set.forEach((loop, i) => ask(loop, shares[i], shares[i] > 0 ? rpm / loop.label : clamp(rpm / loop.label, 0.5, 2)));
}

// A short sound, once: logged whatever happens, heard while driving.
function shot(part, sound, gain, pan = 0, rate = 1, more = {}) {
  if (!sound) return;
  window.soundShots.push({ name: sound.name, part, gain, rate, pan, frame, ...more });
  if (window.soundShots.length > 400) window.soundShots.shift();
  if (audio.state !== 'running' || scene !== 'drive') return;
  const source = audio.createBufferSource();
  source.buffer = sound.buffer;
  source.playbackRate.value = rate;
  const level = audio.createGain();
  level.gain.value = gain;
  const side = audio.createStereoPanner();
  side.pan.value = pan;
  source.connect(level).connect(side).connect(voices.car);
  source.start();
}
const any = list => list[Math.floor(Math.random() * list.length)];

// One frame of the car, as the game describes it.
function play() {
  const view = VIEWS[car.view] ? car.view : 1;
  now.view = view;
  now.parts = { ...VIEWS[view] };
  const throttle = clamp(car.throttle ?? 0), speed = Math.abs(car.speed ?? 0), rpm = Math.max(car.rpm ?? 900, 1);
  const half = Math.PI / 2;

  // The engine: under load or on the overrun by the throttle. With no
  // overrun recordings, as before: quieter and duller off the throttle.
  if (voices.overrun.length) {
    const on = ramp(throttle, 0.02, 0.12);
    now.load = Math.sin(on * half) * (0.3 + 0.35 * throttle);
    now.overrun = Math.cos(on * half) * 0.4;
    now.tone = 18000;
  } else {
    now.load = 0.20 + 0.45 * throttle;
    now.overrun = 0;
    now.tone = view >= 2 ? 18000 : 900 + 9000 * throttle;
  }
  ease(voices.loadSet.gain, now.load);
  ease(voices.overSet.gain, now.overrun);
  ease(voices.tone.frequency, now.tone);
  for (const part of ['engine', 'exhaust', 'tyres', 'wind', 'road']) ease(voices.parts[part].gain, now.parts[part]);
  engine(voices.load, rpm);
  engine(voices.overrun, rpm);

  // A gear change: its own short sound, as the change begins.
  if (was.gear !== null && ((car.shifting && !was.shifting) || (car.gear !== was.gear && !car.shifting && !was.shifting))) {
    shot('shift', any(voices.shift), 0.3 * now.parts.engine, 0, 0.95 + Math.random() * 0.1);
  }
  was.gear = car.gear;
  was.shifting = !!car.shifting;

  // Tyres and what is under them, the left wheels then the right.
  let gravel = 0;
  voices.sides.forEach((side, s) => {
    const amount = { howl: 0, squeal: 0, lock: 0, slide: 0, spin: 0 };
    const under = { road: 0, kerb: 0, grass: 0, gravel: 0 };
    let hardest = 0, spun = 0;
    for (const i of [s, s + 2]) {
      const wheel = car.wheels?.[i];
      if (!wheel || wheel.on === 'air') continue;
      const on = wheel.on === 'runoff' || !(wheel.on in under) ? 'road' : wheel.on;
      under[on] += 0.5;
      if (on === 'gravel') gravel++;
      // Rubber sings on a hard surface only.
      if (on !== 'road' && on !== 'kerb') continue;
      const weight = Math.min(1, 0.5 + 0.5 * (wheel.load ?? 1));
      const use = wheel.use ?? 0, slip = wheel.slip ?? 0, slide = Math.abs(wheel.slide ?? 0);
      const moving = Math.min(speed / 5, 1);
      const past = ramp(use, 1, 1.25) * weight;
      hardest = Math.max(hardest, use);
      amount.howl = Math.max(amount.howl, ramp(use, 0.9, 1) * (1 - 0.7 * ramp(use, 1, 1.25)) * weight * Math.min(speed / 10, 1));
      if ((car.brake ?? 0) > 0.05 && slip < -1 && -slip >= slide) amount.lock = Math.max(amount.lock, past * moving);
      else if (slip > 1 && slip >= slide) { amount.spin = Math.max(amount.spin, past); spun = Math.max(spun, slip); }
      else {
        // Past the peak a squeal; well sideways, a slide.
        const far = ramp(slide, 1.3, 1.8);
        amount.slide = Math.max(amount.slide, past * far * moving);
        amount.squeal = Math.max(amount.squeal, past * (1 - far) * moving);
      }
    }
    // A kind with no recording of its own is a squeal, as it was.
    for (const kind of ['lock', 'slide', 'spin']) {
      if (!side.tyres[kind]) { amount.squeal = Math.max(amount.squeal, amount[kind]); amount[kind] = 0; }
    }
    if (side.tyres.howl) ask(side.tyres.howl, amount.howl * 0.3, 0.9 + 0.2 * Math.min(speed / 70, 1));
    if (side.tyres.squeal) ask(side.tyres.squeal, amount.squeal * 0.45, 0.9 + 0.25 * clamp(hardest - 1));
    if (side.tyres.lock) ask(side.tyres.lock, amount.lock * 0.45, 0.85 + 0.3 * Math.min(speed / 60, 1));
    if (side.tyres.slide) ask(side.tyres.slide, amount.slide * 0.45, 1);
    if (side.tyres.spin) ask(side.tyres.spin, amount.spin * 0.4, 0.9 + 0.2 * Math.min(spun / 5, 1));
    // What it rolls on. With no recording for kerb or gravel, as before:
    // kerb as road, gravel as grass.
    if (!side.ground.kerb) { under.road += under.kerb; under.kerb = 0; }
    if (!side.ground.gravel) { under.grass += under.gravel; under.gravel = 0; }
    const loose = Math.min(speed / 20, 1);
    if (side.ground.road) ask(side.ground.road, under.road * Math.min(speed / 80, 1) * side.ground.road.most);
    if (side.ground.kerb) ask(side.ground.kerb, under.kerb * Math.min(speed / 30, 1) * 0.4, clamp(0.6 + speed / 60, 0.6, 1.5));
    if (side.ground.grass) ask(side.ground.grass, under.grass * loose * side.ground.grass.most);
    if (side.ground.gravel) ask(side.ground.gravel, under.gravel * loose * 0.7);
  });
  // Stones against the car on gravel: more of them the faster and the
  // more wheels are in it, each unlike the last.
  if (gravel && speed > 3 && voices.stones.length && Math.random() < Math.min(0.12, gravel * speed / 2000)) {
    shot('stones', any(voices.stones), (0.2 + 0.3 * Math.random()) * now.parts.road, Math.random() * 1.6 - 0.8, 0.8 + 0.5 * Math.random());
  }

  // The wind grows with speed, faster than the road.
  const pace = Math.min(speed / 80, 1);
  ask(voices.wind, pace * pace * voices.wind.most);

  // A hit. The frame contact begins, the blow itself (and again if a much
  // harder one comes while touching); contact that goes on while moving
  // is a scrape.
  const hit = car.hit;
  if (hit && hit.push > 0) {
    const what = STRUCK[hit.what] ?? 'car';
    const fresh = was.contact === 0 && was.clear >= 3;
    if (fresh || (hit.push >= HEAVY && hit.push > 2.5 * was.push)) {
      const weight = hit.push >= HEAVY ? 'heavy' : 'tap';
      const of = voices.hit.filter(sound => sound.what === what);
      const sound = any(of.filter(sound => sound.weight === weight)) ?? any(of) ?? any(voices.hit);
      const loud = weight === 'heavy' ? 0.7 + 0.3 * ramp(hit.push, HEAVY, 6000) : 0.25 + 0.4 * clamp(hit.push / HEAVY);
      shot('hit', sound, loud * (0.9 + 0.2 * Math.random()), 0, 0.92 + 0.16 * Math.random(), { what, weight, push: hit.push });
    }
    was.contact++;
    was.clear = 0;
    was.push = hit.push;
    const along = was.contact >= 6 && speed > 2;
    for (const scrape of voices.scrape) {
      ask(scrape, along && scrape.what === (voices.scrape.some(s => s.what === what) ? what : 'rail') ? 0.5 * Math.min(speed / 30, 1) : 0, 0.8 + 0.4 * Math.min(speed / 60, 1));
    }
  } else if (++was.clear >= 3) {
    was.contact = 0;
    was.push = 0;
    for (const scrape of voices.scrape) ask(scrape, 0);
  }

  // The rival's engine: by how far it is, on its side, and higher or
  // lower as the gap closes or opens.
  const rival = car.rival;
  if (rival && voices.rival.length) {
    const far = Math.hypot(rival.ahead ?? 0, rival.left ?? 0);
    // Quieter off the throttle (the game says how far down the rival's is).
    now.rival = 0.5 * 8 / (8 + Math.max(far - 2, 0)) * (0.6 + 0.4 * (rival.throttle ?? 1));
    now.rivalPan = +(clamp(-(rival.left ?? 0) / Math.max(far, 3), -1, 1) * 0.9).toFixed(3);
    const low = voices.rival[0].label * (1 - REACH), high = voices.rival.at(-1).label * (1 + REACH);
    engine(voices.rival, clamp((rival.rpm ?? 3000) * 343 / (343 - clamp(rival.closing ?? 0, -80, 80)), low, high));
  } else {
    now.rival = 0;
  }
  ease(voices.rivalGain.gain, now.rival);
  ease(voices.rivalSide.pan, now.rivalPan);
}

window.soundCar = json => {
  let told;
  try { told = JSON.parse(json); } catch { return; }
  heard = true;
  car = told;
  frame++;
  if (voices) play();
};
// The five numbers the game gave before it described the whole car, for a
// game that still gives only those: the same car, all wheels alike.
window.sound = (rpm, throttle, speed, squeal, grass) => {
  if (heard) return;
  const off = Math.round(clamp(grass) * 4);
  car = {
    view: 1, rpm, throttle, brake: 0, gear: was.gear ?? 1, shifting: false, speed, hit: null, rival: null,
    wheels: [0, 1, 2, 3].map(i => ({ on: i < off ? 'grass' : 'road', use: squeal > 0 ? 1 + 0.25 * squeal : 0.3, slip: 0, slide: squeal > 0 ? 1 + 0.25 * squeal : 0, load: 1 })),
  };
  frame++;
  if (voices) play();
};

// What is sounding now, for a test that cannot hear: how loud, and the
// loudest note below 1,500 Hz.
window.soundProbe = () => {
  if (!voices) return null;
  const bins = new Float32Array(voices.ear.frequencyBinCount);
  voices.ear.getFloatFrequencyData(bins);
  const wave = new Float32Array(voices.ear.fftSize);
  voices.ear.getFloatTimeDomainData(wave);
  const each = audio.sampleRate / voices.ear.fftSize;
  let best = Math.ceil(40 / each);
  for (let i = best; i < 1500 / each; i++) if (bins[i] > bins[best]) best = i;
  return {
    level: Math.sqrt(wave.reduce((sum, v) => sum + v * v, 0) / wave.length),
    note: best * each,
    asked: { rpm: car?.rpm ?? 0, throttle: car?.throttle ?? 0, speed: car?.speed ?? 0 },
  };
};

// Record what is sounding for some seconds, for a test to look at as a
// picture: a promise of the recording as base64 (WebM, Opus).
window.soundRecord = seconds => new Promise(done => {
  const tap = audio.createMediaStreamDestination();
  voices.limiter.connect(tap);
  const recorder = new MediaRecorder(tap.stream);
  const parts = [];
  recorder.ondataavailable = event => parts.push(event.data);
  recorder.onstop = async () => {
    voices.limiter.disconnect(tap);
    const bytes = new Uint8Array(await new Blob(parts).arrayBuffer());
    let text = '';
    for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    done(btoa(text));
  };
  recorder.start();
  setTimeout(() => recorder.stop(), seconds * 1000);
});

// A recording, whole.
const whole = async file => audio.decodeAudioData(await (await fetch(file)).arrayBuffer());
// A recording, made to go round without a click: its last quarter second
// is faded out over its first, faded in, so the end runs into the start.
async function loop(file) {
  const all = await whole(file);
  const from = all.getChannelData(0);
  const lap = Math.floor(0.25 * all.sampleRate);
  const round = audio.createBuffer(1, from.length - lap, all.sampleRate);
  const to = round.getChannelData(0);
  to.set(from.subarray(0, to.length));
  for (let i = 0; i < lap; i++) {
    const part = i / lap;
    to[i] = from[i] * Math.sin(part * Math.PI / 2) + from[to.length + i] * Math.cos(part * Math.PI / 2);
  }
  return round;
}

async function start() {
  if (audio) return;
  audio = new AudioContext();
  note('start');
  // Everything leaves through one gain (the master volume), then a
  // limiter, so that no sum of voices can clip at the speakers.
  const out = audio.createGain();
  out.gain.value = levels.master;
  const limiter = audio.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.1;
  const ear = audio.createAnalyser();
  ear.fftSize = 8192;
  out.connect(limiter);
  limiter.connect(ear);
  limiter.connect(audio.destination);
  const chain = ['car | effects | music', 'master', 'limiter', 'speakers'];
  // Three parts under it: the car, the short sounds, the music.
  const gained = (into, value = 0) => { const gain = audio.createGain(); gain.gain.value = value; gain.connect(into); return gain; };
  const carBus = gained(out), effects = gained(out), music = gained(out);

  // The car's own parts, which each view balances: the engine (the loops
  // under load, through a filter that is open unless there are no overrun
  // recordings), the exhaust (the overrun loops, and the low end of the
  // loops under load), tyres, wind and road.
  const tone = audio.createBiquadFilter();
  tone.type = 'lowpass';
  tone.frequency.value = 18000;
  tone.connect(carBus);
  const parts = { engine: gained(tone, VIEWS[1].engine), exhaust: gained(carBus, VIEWS[1].exhaust), tyres: gained(carBus, VIEWS[1].tyres), wind: gained(carBus, VIEWS[1].wind), road: gained(carBus, VIEWS[1].road) };
  const loadSet = gained(parts.engine), overSet = gained(parts.exhaust);
  const low = audio.createBiquadFilter();
  low.type = 'lowpass';
  low.frequency.value = 220;
  loadSet.connect(low);
  low.connect(gained(parts.exhaust, 0.5));
  const rivalSide = audio.createStereoPanner();
  rivalSide.connect(carBus);
  const rivalGain = gained(rivalSide);

  // Every recording is fetched once, all at the same time; one that will
  // not load is left out and what it was for is not played.
  const sounds = await listed();
  const got = new Map();
  const fetched = (sound, how = loop) => {
    if (!sound?.file) return Promise.resolve(null);
    const key = `${how.name} ${sound.file}`;
    if (!got.has(key)) got.set(key, how(sound.file).catch(() => null));
    return got.get(key);
  };
  const all = [];
  // A recording going round and round, through a gain the game turns and
  // to one side or the middle.
  const playing = async (sound, into, part, more = {}) => {
    const buffer = await fetched(sound);
    if (!buffer) return null;
    const source = audio.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    const gain = audio.createGain();
    gain.gain.value = 0;
    source.connect(gain);
    if (more.pan) {
      const side = audio.createStereoPanner();
      side.pan.value = more.pan;
      gain.connect(side).connect(into);
    } else gain.connect(into);
    // Not all from the same moment: the same recording on both sides
    // would otherwise be one sound in the middle.
    source.start(0, Math.random() * buffer.duration);
    const voice = { name: sound.name ?? sound.file, part, label: sound.rpm, what: sound.what, source, gain, own: 0, rate: 1, pan: 0, ...more };
    all.push(voice);
    return voice;
  };
  // Road, wind and grass with no recording: two seconds of plain noise
  // going round, through a filter that gives it its character.
  let noise = null;
  const hissing = (name, into, part, kind, pitch, sharp, more) => {
    if (!noise) {
      const hiss = audio.createBuffer(1, audio.sampleRate * 2, audio.sampleRate);
      const samples = hiss.getChannelData(0);
      for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
      noise = audio.createBufferSource();
      noise.buffer = hiss;
      noise.loop = true;
      noise.start();
    }
    const filter = audio.createBiquadFilter();
    filter.type = kind;
    filter.frequency.value = pitch;
    filter.Q.value = sharp;
    const gain = audio.createGain();
    gain.gain.value = 0;
    noise.connect(filter).connect(gain);
    if (more.pan) {
      const side = audio.createStereoPanner();
      side.pan.value = more.pan;
      gain.connect(side).connect(into);
    } else gain.connect(into);
    const voice = { name, part, source: null, gain, own: 0, rate: 1, pan: 0, ...more };
    all.push(voice);
    return voice;
  };
  const settled = async list => (await Promise.all(list)).filter(Boolean);
  const [load, overrun, rival] = await Promise.all([
    settled(sounds.load.map(sound => playing(sound, loadSet, 'engine'))),
    settled(sounds.overrun.map(sound => playing(sound, overSet, 'exhaust'))),
    settled(sounds.load.map(sound => playing(sound, rivalGain, 'rival'))),
  ]);
  // The left wheels and the right, each side its own voices.
  const sides = await Promise.all([-1, 1].map(async way => {
    const tyres = {}, ground = {};
    await Promise.all([
      ...Object.entries(sounds.tyres).map(async ([kind, sound]) => { tyres[kind] = await playing(sound, parts.tyres, 'tyres', { kind, pan: 0.7 * way }); }),
      ...Object.entries(sounds.ground).map(async ([kind, sound]) => { ground[kind] = await playing(sound, parts.road, 'surface', { kind, pan: 0.5 * way }); }),
    ]);
    ground.road ??= hissing('noise for road', parts.road, 'surface', 'lowpass', 220, 0.7, { kind: 'road', pan: 0.5 * way, most: 0.07 });
    ground.grass ??= hissing('noise for grass', parts.road, 'surface', 'lowpass', 480, 1.2, { kind: 'grass', pan: 0.5 * way, most: 0.18 });
    ground.road.most ??= 0.28;
    ground.grass.most ??= 0.7;
    return { tyres, ground };
  }));
  const wind = await playing(sounds.wind, parts.wind, 'wind', { most: 0.48 })
    ?? hissing('noise for wind', parts.wind, 'wind', 'bandpass', 1400, 0.5, { most: 0.12 });
  const scrape = await settled(sounds.scrape.map(sound => playing(sound, carBus, 'scrape')));
  // The short sounds, whole; and the music, going round.
  const short = async list => (await Promise.all(list.map(async sound => ({ ...sound, buffer: await fetched(sound, whole) })))).filter(sound => sound.buffer);
  const [stones, shift, hit] = await Promise.all([short(sounds.stones), short(sounds.shift), short(sounds.hit)]);
  const once = {};
  await Promise.all(Object.entries(sounds.once).map(async ([use, sound]) => {
    const buffer = await fetched(sound, whole);
    if (buffer) once[use] = buffer;
  }));
  const musicBuffer = await fetched(sounds.music);
  if (musicBuffer) {
    const source = audio.createBufferSource();
    source.buffer = musicBuffer;
    source.loop = true;
    source.connect(music);
    source.start();
  }
  voices = {
    car: carBus, effects, music, once, musicBuffer, out, limiter, ear, chain,
    tone, parts, loadSet, overSet, rivalGain, rivalSide,
    load, overrun, rival, sides, wind, scrape, stones, shift, hit, all,
  };
  if (car) play();
  window.soundOn = true;
  mix();
}

// Called by the page from a key or a click, which is when a browser
// allows sound to begin. It is running by the time the promise is kept.
window.soundStart = () => {
  if (!starting) starting = start().catch(why => { window.lastError = `sound: ${why}`; });
  if (audio && !paused && audio.state === 'suspended') audio.resume();
  return starting;
};
