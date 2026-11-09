// WMS API Client & Audio Feedback Utility

const API = {
  getToken() {
    return localStorage.getItem('wms_token');
  },

  setToken(token) {
    if (token) localStorage.setItem('wms_token', token);
    else localStorage.removeItem('wms_token');
  },

  getUser() {
    try {
      return JSON.parse(localStorage.getItem('wms_user') || 'null');
    } catch (e) {
      return null;
    }
  },

  setUser(user) {
    if (user) localStorage.setItem('wms_user', JSON.stringify(user));
    else localStorage.removeItem('wms_user');
  },

  async request(endpoint, options = {}) {
    const token = this.getToken();
    const headers = options.headers || {};

    if (token && !headers['Authorization']) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    if (!(options.body instanceof FormData) && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }

    const res = await fetch(endpoint, { ...options, headers });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      if (res.status === 401) {
        this.setToken(null);
        this.setUser(null);
      }
      throw new Error(data.message || `Request failed (${res.status})`);
    }

    return data;
  },

  // Web Audio Scanner Beep
  playBeep(success = true) {
    try {
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();

      osc.type = success ? 'sine' : 'sawtooth';
      osc.frequency.setValueAtTime(success ? 880 : 220, audioCtx.currentTime); // High pitch for success, low buzz for error

      gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + (success ? 0.15 : 0.4));

      osc.connect(gain);
      gain.connect(audioCtx.destination);

      osc.start();
      osc.stop(audioCtx.currentTime + (success ? 0.15 : 0.4));

      // Haptic vibration feedback if supported
      if ('vibrate' in navigator) {
        navigator.vibrate(success ? 80 : [100, 50, 150]);
      }
    } catch (e) {}
  }
};
