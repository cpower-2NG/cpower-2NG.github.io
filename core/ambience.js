// BIFROST 环境音：按相位程序化生成的声音氛围，不依赖任何音频素材文件。
// 默认关闭；在访客主动开启之前不会创建 AudioContext（浏览器自动播放策略）。
// 对外接口：window.BifrostAmbience

(() => {
  const STORAGE_KEY = 'bifrost:sound';
  const FADE = 1.4;
  const BASS_SET = [440, 523.25, 587.33, 659.25, 783.99];

  let context = null;
  let master = null;
  let noiseBuffer = null;
  let voice = null;
  let voicePhase = '';
  let enabled = false;
  let started = false;
  let bellTimer = 0;
  let onStateChange = () => {};

  function readPreference() {
    try {
      return localStorage.getItem(STORAGE_KEY) === 'on';
    } catch (_error) {
      return false;
    }
  }

  function writePreference(value) {
    try {
      localStorage.setItem(STORAGE_KEY, value ? 'on' : 'off');
    } catch (_error) {
      // 无痕模式等场景下忽略写入失败
    }
  }

  function ensureContext() {
    if (context) {
      return true;
    }

    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) {
      return false;
    }

    context = new Ctor();
    master = context.createGain();
    master.gain.value = 0;
    master.connect(context.destination);

    const seconds = 3;
    noiseBuffer = context.createBuffer(1, context.sampleRate * seconds, context.sampleRate);
    const channel = noiseBuffer.getChannelData(0);
    let previous = 0;
    for (let i = 0; i < channel.length; i += 1) {
      const white = Math.random() * 2 - 1;
      // 略微低通，得到更接近"空气"而非"雪花"的底噪
      previous = (previous + 0.02 * white) / 1.02;
      channel[i] = previous * 3.2;
    }

    return true;
  }

  function createNoiseSource() {
    const source = context.createBufferSource();
    source.buffer = noiseBuffer;
    source.loop = true;
    return source;
  }

  function buildLogicVoice(output) {
    const nodes = [];
    const droneBus = context.createGain();
    droneBus.gain.value = 0.62;
    droneBus.connect(output);

    const droneFilter = context.createBiquadFilter();
    droneFilter.type = 'lowpass';
    droneFilter.frequency.value = 240;
    droneFilter.Q.value = 0.6;
    droneFilter.connect(droneBus);

    [
      { type: 'sine', frequency: 55, gain: 0.5 },
      { type: 'sine', frequency: 82.5, gain: 0.22, detune: 7 },
      { type: 'triangle', frequency: 110, gain: 0.08, detune: -5 },
    ].forEach((spec) => {
      const osc = context.createOscillator();
      osc.type = spec.type;
      osc.frequency.value = spec.frequency;
      if (spec.detune) {
        osc.detune.value = spec.detune;
      }
      const gain = context.createGain();
      gain.gain.value = spec.gain;
      osc.connect(gain).connect(droneFilter);
      osc.start();
      nodes.push(osc);
    });

    const air = createNoiseSource();
    const airFilter = context.createBiquadFilter();
    airFilter.type = 'lowpass';
    airFilter.frequency.value = 420;
    const airGain = context.createGain();
    airGain.gain.value = 0.055;
    air.connect(airFilter).connect(airGain).connect(output);
    air.start();
    nodes.push(air);

    // 极慢的滤波器摆动，让嗡鸣不至于完全静止
    const lfo = context.createOscillator();
    lfo.frequency.value = 0.045;
    const lfoDepth = context.createGain();
    lfoDepth.gain.value = 90;
    lfo.connect(lfoDepth).connect(droneFilter.frequency);
    lfo.start();
    nodes.push(lfo);

    return () => nodes.forEach((node) => {
      try {
        node.stop();
      } catch (_error) {
        // 已停止的节点
      }
    });
  }

  function buildFantasyVoice(output) {
    const nodes = [];

    const wind = createNoiseSource();
    const windFilter = context.createBiquadFilter();
    windFilter.type = 'bandpass';
    windFilter.frequency.value = 780;
    windFilter.Q.value = 0.7;
    const windGain = context.createGain();
    windGain.gain.value = 0.1;
    wind.connect(windFilter).connect(windGain).connect(output);
    wind.start();
    nodes.push(wind);

    const breath = context.createOscillator();
    breath.frequency.value = 0.07;
    const breathDepth = context.createGain();
    breathDepth.gain.value = 0.05;
    breath.connect(breathDepth).connect(windGain.gain);
    breath.start();
    nodes.push(breath);

    return () => nodes.forEach((node) => {
      try {
        node.stop();
      } catch (_error) {
        // 已停止的节点
      }
    });
  }

  function scheduleBell() {
    clearTimeout(bellTimer);
    if (!enabled || voicePhase !== 'fantasy' || !context) {
      return;
    }

    const now = context.currentTime;
    const frequency = BASS_SET[Math.floor(Math.random() * BASS_SET.length)];
    const osc = context.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = frequency;

    const shimmer = context.createOscillator();
    shimmer.type = 'sine';
    shimmer.frequency.value = frequency * 2.004;

    const tone = context.createGain();
    tone.gain.setValueAtTime(0, now);
    tone.gain.linearRampToValueAtTime(0.15, now + 0.02);
    tone.gain.exponentialRampToValueAtTime(0.0001, now + 3.2);

    const shimmerGain = context.createGain();
    shimmerGain.gain.value = 0.2;

    osc.connect(tone);
    shimmer.connect(shimmerGain).connect(tone);
    tone.connect(master);

    osc.start(now);
    shimmer.start(now);
    osc.stop(now + 3.4);
    shimmer.stop(now + 3.4);

    bellTimer = window.setTimeout(scheduleBell, 6000 + Math.random() * 11000);
  }

  function fadeMaster(target) {
    if (!context) {
      return;
    }
    const now = context.currentTime;
    master.gain.cancelScheduledValues(now);
    master.gain.setValueAtTime(master.gain.value, now);
    master.gain.linearRampToValueAtTime(target, now + FADE);
  }

  function stopVoice() {
    clearTimeout(bellTimer);
    if (voice) {
      voice();
      voice = null;
    }
    voicePhase = '';
  }

  function startVoice(phase) {
    stopVoice();
    if (!context) {
      return;
    }
    // 每位面各有一个独立的总线增益，切换时交叉淡入淡出
    const bus = context.createGain();
    bus.gain.value = 0;
    bus.connect(master);

    const dispose = phase === 'fantasy' ? buildFantasyVoice(bus) : buildLogicVoice(bus);
    const now = context.currentTime;
    bus.gain.setValueAtTime(0, now);
    bus.gain.linearRampToValueAtTime(1, now + FADE);

    voice = () => {
      const stopAt = context.currentTime;
      bus.gain.cancelScheduledValues(stopAt);
      bus.gain.setValueAtTime(bus.gain.value, stopAt);
      bus.gain.linearRampToValueAtTime(0, stopAt + FADE * 0.7);
      window.setTimeout(dispose, FADE * 900);
    };
    voicePhase = phase;

    if (phase === 'fantasy') {
      bellTimer = window.setTimeout(scheduleBell, 2500 + Math.random() * 5000);
    }
  }

  function notify() {
    onStateChange(status());
  }

  function status() {
    if (!enabled) {
      return 'off';
    }
    return started ? 'on' : 'pending';
  }

  async function start() {
    if (!ensureContext()) {
      enabled = false;
      writePreference(false);
      notify();
      return false;
    }

    if (context.state === 'suspended') {
      try {
        await context.resume();
      } catch (_error) {
        return false;
      }
    }

    started = true;
    startVoice(voicePhase || 'logic');
    fadeMaster(0.72);
    notify();
    return true;
  }

  function stop() {
    started = false;
    fadeMaster(0);
    stopVoice();
    notify();
  }

  const api = {
    // 页面加载时恢复偏好：只记录意图，真正的播放交给首次用户交互
    restore(handler) {
      if (typeof handler === 'function') {
        onStateChange = handler;
      }
      enabled = readPreference();
      notify();
      return enabled;
    },

    async resume() {
      if (!enabled || started) {
        return false;
      }
      return start();
    },

    async toggle() {
      enabled = !enabled;
      writePreference(enabled);
      if (enabled) {
        const ok = await start();
        if (!ok) {
          return false;
        }
      } else {
        stop();
      }
      notify();
      return enabled;
    },

    setPhase(phase) {
      voicePhase = phase;
      if (started && context) {
        startVoice(phase);
      }
    },

    isEnabled() {
      return enabled;
    },

    status,
  };

  window.BifrostAmbience = api;
})();
