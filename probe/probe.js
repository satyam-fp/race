// What a page's start asks of the GPU, and what it costs, reported to the counter as one event
// (`race_probe`). For measuring on a machine nobody here can sit at (Windows): never shipped.
// Written 2026-11-23 ("Windows takes minutes to start", PLAN.md).
//
// Put it in a copy of a release's page, as a classic script anywhere before the page's module
// script runs (before `<script src="config.js">` is simplest), and open the copy with
// `?count=1&probe=1&tag=<a word>`. It measures with `probe=1` (kept as `window.__probe`) and sends only with `count=1` too, to the counter's own PostHog
// (`TACHYON_DEPLOY.count` in config.js), marked `test`.
//
// It changes nothing the page or the program does: each of GPUDevice's createShaderModule,
// createRenderPipeline(Async), createComputePipeline(Async) is wrapped to call the browser's own
// with the same arguments and return what it returned; the page's marks, long tasks and frames are
// only listened to. The one thing it adds: after each pipeline, `queue.onSubmittedWorkDone()` is
// asked (a promise, nothing submitted) and the moment it resolves kept. The GPU process takes the
// page's calls in order, so the time from one pipeline's answer to the next is what that pipeline
// cost there (compiling its shaders, on Windows through Direct3D's compiler), less anything else
// the page asked for in between (the frames' own work, textures).
//
// Per stage (start, first_frame, cars, lap0, lap1, title, by the marks `first-frame`,
// `cars-whole`, `lap-begun`, `lap-done`, `title`): p (pipelines), m (shader modules), kb (their
// WGSL), call_ms (the page's thread inside those calls), gpu_s (the GPU process's time, as above),
// fr (frames), worst_ms (the longest frame), gap_s (time in frames over 250 ms), block_s (the page's
// thread blocked, long tasks), s (the stage's length). And: top (the 25 pipelines that cost the GPU
// process most: label, stage, KB of WGSL, ms), bands (pipelines by that cost), the adapter's info.
(() => {
  const ask = new URLSearchParams(location.search);
  if (ask.get('probe') !== '1' || typeof GPUDevice === 'undefined') return;
  const STAGES = [['first_frame', 'first-frame'], ['cars', 'cars-whole'], ['lap0', 'lap-begun'], ['lap1', 'lap-done'], ['title', 'title']];
  const per = {};
  const S = s => per[s] ??= { p: 0, m: 0, kb: 0, call: 0, gpu: 0, fr: 0, worst: 0, gap: 0, block: 0, from: performance.now() };
  let stage = 'start';
  S(stage);
  const pipes = [];
  const sizes = new WeakMap();
  let lastDone = 0, sent = false;
  try {
    new PerformanceObserver(list => {
      for (const e of list.getEntries()) {
        const hit = STAGES.find(([, name]) => name === e.name);
        if (hit && !per[hit[0]]) { stage = hit[0]; S(stage).from = e.startTime; }
        if (e.name === 'title') setTimeout(() => send(false), 5000);
      }
    }).observe({ type: 'mark', buffered: true });
  } catch { /* no stages */ }
  try { new PerformanceObserver(list => { for (const e of list.getEntries()) S(stage).block += e.duration; }).observe({ type: 'longtask', buffered: true }); } catch { /* none */ }
  let last = 0;
  const frame = now => {
    if (last && !document.hidden) { const dt = now - last, s = S(stage); s.fr++; if (dt > s.worst) s.worst = dt; if (dt > 250) s.gap += dt; }
    last = now;
    if (!sent) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  const P = GPUDevice.prototype;
  const module = P.createShaderModule;
  P.createShaderModule = function (d) {
    const m = module.apply(this, arguments);
    try { const n = String(d?.code ?? '').length; sizes.set(m, n); const s = S(stage); s.m++; s.kb += n / 1000; } catch { /* as it is */ }
    return m;
  };
  for (const name of ['createRenderPipeline', 'createComputePipeline', 'createRenderPipelineAsync', 'createComputePipelineAsync']) {
    const real = P[name];
    if (!real) continue;
    P[name] = function (d) {
      const t = performance.now();
      const r = real.apply(this, arguments);
      try {
        const now = performance.now(), s = S(stage);
        s.p++;
        s.call += now - t;
        const kb = ((sizes.get(d?.vertex?.module ?? d?.compute?.module) ?? 0) + (sizes.get(d?.fragment?.module) ?? 0)) / 1000;
        const one = { label: String(d?.label ?? name).slice(0, 28), stage, kb: Math.round(kb), at: now, ms: 0 };
        pipes.push(one);
        this.queue?.onSubmittedWorkDone?.().then(() => {
          const done = performance.now();
          one.ms = Math.max(0, done - Math.max(lastDone, one.at));
          lastDone = Math.max(lastDone, done);
          S(one.stage).gpu += one.ms;
        }, () => {});
      } catch { /* as it is */ }
      return r;
    };
  }
  const r1 = x => Math.round(x * 10) / 10;
  const send = closing => {
    if (sent) return;
    sent = true;
    try {
      const deploy = window.TACHYON_DEPLOY?.count ?? {};
      const props = { game: 'tachyon-sprint', test: true, probe: 1, tag: (ask.get('tag') || '').slice(0, 40), closing, seconds: r1(performance.now() / 1000),
        query: location.search.replace(/[?&](count|probe|tag)=[^&]*/g, '').slice(0, 120), ua: (navigator.userAgentData?.brands ?? []).map(b => `${b.brand} ${b.version}`).join(', ').slice(0, 120) };
      const names = ['start', ...STAGES.map(([s]) => s)];
      names.forEach((s, i) => {
        const v = per[s];
        if (!v) return;
        const next = names.slice(i + 1).map(n => per[n]?.from).find(x => x != null) ?? performance.now();
        Object.assign(props, { [`p_${s}`]: v.p, [`m_${s}`]: v.m, [`kb_${s}`]: Math.round(v.kb), [`call_ms_${s}`]: Math.round(v.call), [`gpu_s_${s}`]: r1(v.gpu / 1000),
          [`fr_${s}`]: v.fr, [`worst_ms_${s}`]: Math.round(v.worst), [`gap_s_${s}`]: r1(v.gap / 1000), [`block_s_${s}`]: r1(v.block / 1000), [`s_${s}`]: r1((next - v.from) / 1000) });
      });
      props.pipelines = pipes.length;
      props.gpu_s = r1(pipes.reduce((a, p) => a + p.ms, 0) / 1000);
      props.top = [...pipes].sort((a, b) => b.ms - a.ms).slice(0, 25).map(p => `${p.label}|${p.stage}|${p.kb}|${Math.round(p.ms)}`).join(';');
      const bands = [10, 100, 300, 1000, 3000, 1e9], names2 = ['lt10ms', 'lt100ms', 'lt300ms', 'lt1s', 'lt3s', 'ge3s'];
      names2.forEach((n, i) => { const sel = pipes.filter(p => p.ms < bands[i] && (i === 0 || p.ms >= bands[i - 1])); props[`n_${n}`] = sel.length; props[`s_${n}`] = r1(sel.reduce((a, p) => a + p.ms, 0) / 1000); });
      // Big shaders against small: the GPU process's time for pipelines over 60 KB of WGSL and under.
      const big = pipes.filter(p => p.kb >= 60);
      Object.assign(props, { big_n: big.length, big_s: r1(big.reduce((a, p) => a + p.ms, 0) / 1000), small_s: r1(pipes.filter(p => p.kb < 60).reduce((a, p) => a + p.ms, 0) / 1000) });
      try {
        const a = window.game?.detail?.gpu?.adapter, info = a?.info ?? {};
        Object.assign(props, { gpu_vendor: String(info.vendor ?? '').slice(0, 30), gpu_arch: String(info.architecture ?? '').slice(0, 30),
          gpu_desc: String(info.description ?? '').slice(0, 80), shader_model: info.d3dShaderModel ?? '', backend: String(info.backend ?? info.backendType ?? '') });
      } catch { /* as it is */ }
      window.__probe = props;
      if (ask.get('count') !== '1' || !deploy.key || !deploy.capture) return;
      const body = JSON.stringify({ api_key: deploy.key, event: 'race_probe', distinct_id: 'probe', properties: { $process_person_profile: false, ...props } });
      let ok = false;
      if (closing) try { ok = navigator.sendBeacon?.(deploy.capture, new Blob([body], { type: 'text/plain;charset=UTF-8' })) === true; } catch { /* the fetch */ }
      if (!ok) fetch(deploy.capture, { method: 'POST', keepalive: true, headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body }).catch(() => {});
    } catch { /* never stops the page */ }
  };
  addEventListener('pagehide', () => send(true));
  window.__probeSend = () => send(false);
})();
