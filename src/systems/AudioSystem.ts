import * as THREE from "three";
import type { DebrisManager } from "./DebrisManager";
import type { PlayerController } from "./PlayerController";
import type { TornadoSystem } from "./TornadoSystem";
import type { WindField } from "./WindField";

/**
 * Procedural audio — every voice is synthesized with WebAudio, no asset
 * files. Individual voices can later be swapped for real samples without
 * touching the wiring; the mix logic (what rides what) is the point:
 *
 *   siren   — two detuned sines on a slow pitch LFO. Rides the round phase
 *             (Game passes a level): loud during the warning, faint after.
 *   rumble  — looped brown noise through a lowpass. Gain AND cutoff swell
 *             with tornado proximity: far = a felt sub-bass presence,
 *             close = a roar. This channel carries most of the fear.
 *   wind    — looped pink noise through a bandpass; gain and brightness
 *             follow the wind speed at the player's own position.
 *   groans  — sparse low sine bursts with a pitch drop, scheduled at random
 *             intervals that shorten as the tornado nears — structures
 *             creaking under strain.
 *   whoosh  — a bandpass noise sweep, stereo-panned, fired when fast debris
 *             passes near the player (poor man's Doppler).
 *   thunder — a long lowpassed noise burst, delayed 0.2–1.2 s after the
 *             lightning flash (light beats sound).
 *
 * Browsers refuse to start audio without a user gesture, so the whole graph
 * is built lazily on the first click/keypress. Continuous parameters are
 * retargeted at ~10 Hz with setTargetAtTime (smooth, and far fewer
 * automation events than per-frame writes).
 */
export class AudioSystem {
  private ctx: AudioContext | null = null;
  private master!: GainNode;

  private sirenGain!: GainNode;
  private rumbleGain!: GainNode;
  private rumbleFilter!: BiquadFilterNode;
  private windGain!: GainNode;
  private windFilter!: BiquadFilterNode;

  private pinkBuffer!: AudioBuffer;
  private brownBuffer!: AudioBuffer;

  private sirenLevel = 0;
  private retargetTimer = 0;
  private groanTimer = 4;
  private whooshCooldown = 0;
  private proximity = 0; // 0..1 tornado nearness (set in retargetChannels)
  private heartTimer = 0; // countdown to the next heartbeat thud
  private impactCooldown = 0; // throttle on block-break impacts

  // scratch
  private readonly windVec = new THREE.Vector3();
  private readonly playerPos = new THREE.Vector3();
  private readonly rel = new THREE.Vector3();

  constructor(
    private readonly tornado: TornadoSystem,
    private readonly player: PlayerController,
    private readonly windField: WindField,
    private readonly debris: DebrisManager,
  ) {
    const unlock = (): void => {
      if (this.ctx) return;
      this.ctx = new AudioContext();
      void this.ctx.resume();
      this.buildGraph();
    };
    window.addEventListener("click", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
  }

  /** `sirenLevel` 0..1 comes from the round state machine (Game). */
  setSirenLevel(level: number): void {
    this.sirenLevel = level;
  }

  update(dt: number, time: number): void {
    if (!this.ctx) return;
    this.whooshCooldown = Math.max(0, this.whooshCooldown - dt);
    this.impactCooldown = Math.max(0, this.impactCooldown - dt);

    // Retarget the continuous channels at ~10 Hz.
    this.retargetTimer += dt;
    if (this.retargetTimer >= 0.1) {
      this.retargetTimer = 0;
      this.retargetChannels(time);
    }

    this.scheduleGroans(dt);
    this.scheduleHeartbeat(dt);
    this.scanForWhooshes();
  }

  /**
   * Heartbeat — the dread cue. Only when the funnel is close (proximity high);
   * the interval shortens as it bears down, so a near pass literally makes your
   * pulse race. Two quick low thumps per beat.
   */
  private scheduleHeartbeat(dt: number): void {
    if (this.proximity < 0.5) {
      this.heartTimer = 0;
      return;
    }
    this.heartTimer -= dt;
    if (this.heartTimer > 0) return;
    // ~0.9 s between beats far, ~0.45 s when right on top of you.
    this.heartTimer = 1.3 - this.proximity * 0.85;
    this.playHeart(this.proximity);
  }

  private retargetChannels(time: number): void {
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    this.playerPos.copy(this.player.position);

    // Proximity 0..1: how much tornado the player's ears should get. Felt from
    // further out (÷300) so an approaching pass is heard before it's seen.
    // NEAREST funnel drives it (§2a), so a second funnel raises the dread on
    // its own.
    const proximity = this.tornado.feltIntensity(this.playerPos.x, this.playerPos.z, 300);
    this.proximity = proximity;

    // Rumble is THE approaching-swell voice: louder and swelling earlier than
    // before (^1.3 · 1.55), with the lowpass opening wider so "closer" reads as
    // a growing ROAR, not merely "louder". This is the dread lever.
    this.rumbleGain.gain.setTargetAtTime(proximity ** 1.3 * 1.55, now, 0.22);
    this.rumbleFilter.frequency.setTargetAtTime(40 + proximity * 380, now, 0.22);

    // Local wind bed follows the wind speed at the player.
    this.windField.sample(this.windVec, this.playerPos, time);
    const windSpeed = this.windVec.length();
    const windLevel = THREE.MathUtils.clamp(windSpeed / 45, 0, 1);
    this.windGain.gain.setTargetAtTime(windLevel * 0.5, now, 0.2);
    this.windFilter.frequency.setTargetAtTime(250 + windLevel * 900, now, 0.2);

    this.sirenGain.gain.setTargetAtTime(this.sirenLevel * 0.16, now, 0.5);
  }

  /** Structures creaking: sparse, closer together as danger rises. */
  private scheduleGroans(dt: number): void {
    const danger = this.tornado.feltIntensity(this.player.position.x, this.player.position.z, 130);
    if (danger < 0.1) return;

    this.groanTimer -= dt;
    if (this.groanTimer > 0) return;
    this.groanTimer = (2 + Math.random() * 5) / Math.max(danger, 0.25);
    this.playGroan(danger);
  }

  /** Fast debris passing close by → panned whoosh. */
  private scanForWhooshes(): void {
    if (this.whooshCooldown > 0) return;
    this.playerPos.copy(this.player.position);
    let fired = false;
    this.debris.forEachActive((body) => {
      if (fired) return;
      const t = body.translation();
      this.rel.set(t.x, t.y, t.z).sub(this.playerPos);
      if (this.rel.lengthSq() > 7 * 7) return;
      const v = body.linvel();
      const speed = Math.hypot(v.x, v.y, v.z);
      if (speed < 15) return;
      // Pan by which side of the view the debris is on (player yaw space).
      const yaw = this.player.yaw;
      const side = this.rel.x * Math.cos(yaw) + this.rel.z * -Math.sin(yaw);
      this.playWhoosh(THREE.MathUtils.clamp(side / 5, -1, 1), speed);
      fired = true;
    });
    if (fired) this.whooshCooldown = 0.25;
  }

  /** Delayed thunder for a lightning strike (Atmosphere.onLightning). */
  thunder(): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const start = ctx.currentTime + 0.2 + Math.random(); // light beats sound
    const dur = 1.5 + Math.random() * 1.5;

    const src = ctx.createBufferSource();
    src.buffer = this.brownBuffer;
    src.playbackRate.value = 0.6 + Math.random() * 0.3;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(400, start);
    filter.frequency.exponentialRampToValueAtTime(90, start + dur);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(0.35 + Math.random() * 0.3, start + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.001, start + dur);
    src.connect(filter).connect(gain).connect(this.master);
    src.start(start);
    src.stop(start + dur + 0.1);
  }

  /** A heartbeat: two low sine thumps ("lub-dub"), louder when very close. */
  private playHeart(proximity: number): void {
    const ctx = this.ctx!;
    const vol = 0.12 + proximity * 0.22;
    for (const [offset, level] of [
      [0, vol],
      [0.16, vol * 0.7],
    ] as const) {
      const t = ctx.currentTime + offset;
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(62, t);
      osc.frequency.exponentialRampToValueAtTime(38, t + 0.14);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(level, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
      osc.connect(gain).connect(this.master);
      osc.start(t);
      osc.stop(t + 0.18);
    }
  }

  /**
   * A structural break impact — a low thud + a short debris crack. Called by
   * StructureSystem when a break sweep releases blocks (throttled here so a
   * whole wall coming down is one weighty crash, not a machine-gun of clicks).
   */
  impact(count: number): void {
    if (!this.ctx || this.impactCooldown > 0) return;
    this.impactCooldown = 0.12;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const heavy = THREE.MathUtils.clamp(count / 6, 0.3, 1);

    // Low thud (body of the impact).
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(120, now);
    osc.frequency.exponentialRampToValueAtTime(45, now + 0.18);
    const oGain = ctx.createGain();
    oGain.gain.setValueAtTime(0.28 * heavy, now);
    oGain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
    osc.connect(oGain).connect(this.master);
    osc.start(now);
    osc.stop(now + 0.22);

    // Crack (transient noise burst through a lowpass).
    const src = ctx.createBufferSource();
    src.buffer = this.brownBuffer;
    src.playbackRate.value = 1.4;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 1400;
    const nGain = ctx.createGain();
    nGain.gain.setValueAtTime(0.22 * heavy, now);
    nGain.gain.exponentialRampToValueAtTime(0.001, now + 0.13);
    src.connect(filter).connect(nGain).connect(this.master);
    src.start(now, Math.random());
    src.stop(now + 0.16);
  }

  private playGroan(danger: number): void {
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const dur = 0.6 + Math.random() * 0.8;
    const f0 = 55 + Math.random() * 60;

    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(f0, now);
    osc.frequency.exponentialRampToValueAtTime(f0 * 0.6, now + dur); // sagging pitch
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 300;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.05 + danger * 0.1, now + dur * 0.3);
    gain.gain.exponentialRampToValueAtTime(0.001, now + dur);
    osc.connect(filter).connect(gain).connect(this.master);
    osc.start(now);
    osc.stop(now + dur + 0.05);
  }

  private playWhoosh(pan: number, speed: number): void {
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const dur = 0.45;

    const src = ctx.createBufferSource();
    src.buffer = this.pinkBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.Q.value = 1.2;
    // Rising-then-falling center frequency ≈ a Doppler swish.
    filter.frequency.setValueAtTime(350, now);
    filter.frequency.exponentialRampToValueAtTime(900 + speed * 12, now + dur * 0.4);
    filter.frequency.exponentialRampToValueAtTime(300, now + dur);
    const panner = ctx.createStereoPanner();
    panner.pan.setValueAtTime(pan, now);
    panner.pan.linearRampToValueAtTime(-pan, now + dur); // fly across the head
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.4, now + dur * 0.35);
    gain.gain.exponentialRampToValueAtTime(0.001, now + dur);
    src.connect(filter).connect(gain).connect(panner).connect(this.master);
    src.start(now, Math.random());
    src.stop(now + dur + 0.05);
  }

  private buildGraph(): void {
    const ctx = this.ctx!;
    this.master = ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(ctx.destination);

    this.pinkBuffer = createNoiseBuffer(ctx, "pink");
    this.brownBuffer = createNoiseBuffer(ctx, "brown");

    // --- siren: two detuned sines, slow pitch LFO (classic wail) ---
    this.sirenGain = ctx.createGain();
    this.sirenGain.gain.value = 0;
    this.sirenGain.connect(this.master);
    for (const detune of [0, 7]) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = 560;
      osc.detune.value = detune;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.11;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 130; // sweep ±130 Hz around the base
      lfo.connect(lfoGain).connect(osc.frequency);
      osc.connect(this.sirenGain);
      osc.start();
      lfo.start();
    }

    // --- rumble: looped brown noise → lowpass ---
    this.rumbleFilter = ctx.createBiquadFilter();
    this.rumbleFilter.type = "lowpass";
    this.rumbleFilter.frequency.value = 45;
    this.rumbleGain = ctx.createGain();
    this.rumbleGain.gain.value = 0;
    const rumbleSrc = ctx.createBufferSource();
    rumbleSrc.buffer = this.brownBuffer;
    rumbleSrc.loop = true;
    rumbleSrc.connect(this.rumbleFilter).connect(this.rumbleGain).connect(this.master);
    rumbleSrc.start();

    // --- local wind: looped pink noise → bandpass ---
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = "bandpass";
    this.windFilter.frequency.value = 300;
    this.windFilter.Q.value = 0.7;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    const windSrc = ctx.createBufferSource();
    windSrc.buffer = this.pinkBuffer;
    windSrc.loop = true;
    windSrc.connect(this.windFilter).connect(this.windGain).connect(this.master);
    windSrc.start();
  }
}

/** 2-second looping noise buffers. Pink = Paul Kellet's filter cascade;
 *  brown = leaky integrator over white noise (deep, rumbly). */
function createNoiseBuffer(ctx: AudioContext, kind: "pink" | "brown"): AudioBuffer {
  const seconds = 2;
  const buffer = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
  const data = buffer.getChannelData(0);

  if (kind === "brown") {
    let last = 0;
    for (let i = 0; i < data.length; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.5;
    }
  } else {
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < data.length; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.969 * b2 + white * 0.153852;
      b3 = 0.8665 * b3 + white * 0.3104856;
      b4 = 0.55 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.016898;
      data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
      b6 = white * 0.115926;
    }
  }
  return buffer;
}
