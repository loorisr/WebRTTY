/* WebRTTY core: RTTY demodulator, Baudot codec, AFSK encoder, multi-channel host.
   No DOM. Runs in a page, an AudioWorklet, or Node.js. */
(function (root) {
  'use strict';
  const LTRS_CH = ['\0','E','\n','A',' ','S','I','U','\r','D','R','J','N','F','C','K','T','Z','L','W','H','Y','P','Q','O','B','G',null,'M','X','V',null];
  const FIGS_CH = ['\0','3','\n','-',' ','\x07','8','7','\r','$','4',"'",',','!',':','(','5','"',')','2','#','6','0','1','9','?','&',null,'.','/',';',null];
  const C_FIGS = 0x1B, C_LTRS = 0x1F, C_SPACE = 4;
  const TWO_PI = 6.283185307179586;

  function butterLP(fc, fs, order) {
    const out = [];
    for (let k = 0; k < order / 2; k++) {
      const Q = 1 / (2 * Math.cos(Math.PI * (2 * k + 1) / (2 * order)));
      const w0 = 2 * Math.PI * fc / fs, c = Math.cos(w0), al = Math.sin(w0) / (2 * Q);
      const a0 = 1 + al;
      out.push({ b0: (1 - c) / 2 / a0, b1: (1 - c) / a0, b2: (1 - c) / 2 / a0, a1: -2 * c / a0, a2: (1 - al) / a0, z1: 0, z2: 0 });
    }
    return out;
  }
  function runChain(ch, x) {
    for (let i = 0; i < ch.length; i++) {
      const f = ch[i];
      const y = f.b0 * x + f.z1;
      f.z1 = f.b1 * x - f.a1 * y + f.z2;
      f.z2 = f.b2 * x - f.a2 * y;
      x = y;
    }
    return x;
  }

  // Mark = higher RF frequency. On LSB that is the LOWER audio tone.
  function markSign(sideband, reverse) {
    const s = sideband === 'USB' ? 1 : -1;
    return reverse ? -s : s;
  }

  /* ------------------------------------------------------------------------------------------
     RttyDecoder
     - complex front end: mix to baseband at the tuning centre, 4th-order low-pass, decimate
     - mark/space matched filters (one-bit integration, built from two half-bit sums)
     - adaptive ATC: blends per-tone signal/noise tracking (selective & multipath fading) with a
       fast-common-level x slow-balance tracker (flutter), weighted by the measured fading speed;
       under flutter the half-bit sums are also combined non-coherently
     - start-bit synchronisation with sub-sample interpolation, AFC, squelch with carrier detect
     onChar(ch, conf, q): conf = weakest bit's margin relative to the typical margin (≈1 normal,
     < ~0.3 doubtful), q = mean absolute margin (0..1).
     ------------------------------------------------------------------------------------------ */
  class RttyDecoder {
    constructor(opts) {
      this.fs = opts.sampleRate;
      this.onChar = opts.onChar || (() => {});
      this.cfg = Object.assign({ center: 1500, shift: 170, baud: 45.45, sideband: 'LSB', reverse: false,
        atc: true, afc: true, squelch: 0, usos: true, afcRange: 100, notches: [] }, opts);
      delete this.cfg.onChar; delete this.cfg.sampleRate;
      this.ncoPh = 0;
      this.scope = new Float32Array(512); this.scopeIdx = 0; this.scopeRot = 0;
      this.metrics = { mark: 0, space: 0, snr: 0, quality: 0, afcOffset: 0, carrier: false, selective: 1 };
      this.rebuild();
    }
    set(p) {
      const needs = ['shift', 'baud'].some(k => k in p && p[k] !== this.cfg[k]);
      Object.assign(this.cfg, p);
      if ('center' in p) this.userCenter = p.center, this.cfg.center = p.center;
      if (needs) this.rebuild();
    }
    // Forget the signal (levels, sync, shift state) but keep the tuning. Used after our own TX.
    reset() { const c = this.cfg.center, u = this.userCenter; this.rebuild(); this.cfg.center = c; this.userCenter = u; }
    rebuild() {
      const c = this.cfg;
      this.userCenter = c.center;
      const target = Math.max(1500, 4 * (c.shift / 2 + 2 * c.baud));
      this.D = Math.max(1, Math.floor(this.fs / target));
      this.fsd = this.fs / this.D;
      const fc = c.shift / 2 + 1.2 * c.baud;
      this.lpI = butterLP(fc, this.fs, 4); this.lpQ = butterLP(fc, this.fs, 4);
      this.decCnt = 0;
      this.bitLen = this.fsd / c.baud;
      this.L = Math.max(2, Math.round(this.bitLen / 2));   // half-bit integration length
      this.N = this.L;
      this.bufMr = new Float32Array(this.N); this.bufMi = new Float32Array(this.N);
      this.bufSr = new Float32Array(this.N); this.bufSi = new Float32Array(this.N);
      this.HL = this.L * 2; this.hc = new Float32Array(this.HL * 4); this.hi = 0;
      this.bi = 0; this.sMr = 0; this.sMi = 0; this.sSr = 0; this.sSi = 0;
      this.phM = 0; this.phS = 0;
      this.mSig = 1e-6; this.sSig = 1e-6; this.mNoise = 0; this.sNoise = 0;
      this.P = 0; this.bm = 1; this.bs = 1; this.imb = 0; this.fade = null;
      this.prevD = 0; this.state = 0; this.counter = 0; this.bitIdx = 0; this.code = 0; this.qAcc = 0;
      this.qMin = 0; this.avgAbs = 0; this.figs = false;
      this.pzm = [0, 0]; this.pzs = [0, 0]; this.afcAcc = 0; this.afcW = 0; this.afcCnt = 0;
      this.recount = 0; this.t = 0;
      this.Pc = 0; this.Plong = 0; this.carrierOnT = -1e9; this.carrierOff = true; this.absent = 0; this.seenM = 0; this.seenS = 0;
      this.metrics.selective = 1;
      this.acqN = Math.round(0.6 * this.fsd); this.acqR = new Float32Array(this.acqN * 2); this.acqI = 0; this.acqCnt = 0;
    }
    process(buf) {
      const c = this.cfg, fs = this.fs;
      let inc = TWO_PI * c.center / fs, ph = this.ncoPh;
      for (let n = 0; n < buf.length; n++) {
        const x = buf[n];
        const i = runChain(this.lpI, x * Math.cos(ph));
        const q = runChain(this.lpQ, -x * Math.sin(ph));
        ph += inc; if (ph > TWO_PI) ph -= TWO_PI;
        if (++this.decCnt >= this.D) {
          this.decCnt = 0;
          this._dec(i, q);
          inc = TWO_PI * c.center / fs; // centre may move with AFC
        }
      }
      this.ncoPh = ph;
    }
    _dec(bi, bq) {
      this.t++;
      // notch filters (absolute audio Hz): z -= e^{jwn} * LP(z * e^{-jwn}), about ±6 Hz wide
      const nl = this.cfg.notches;
      if (nl && nl.length) {
        if (!this.nst || this.nst.length !== nl.length) this.nst = nl.map(() => ({ ph: 0, r: 0, i: 0 }));
        const a = 1 - Math.exp(-TWO_PI * 6 / this.fsd);
        for (let k = 0; k < nl.length; k++) {
          const st = this.nst[k];
          st.ph += TWO_PI * (nl[k] - this.cfg.center) / this.fsd; if (st.ph > Math.PI) st.ph -= TWO_PI; if (st.ph < -Math.PI) st.ph += TWO_PI;
          const c = Math.cos(st.ph), s = Math.sin(st.ph);
          st.r += a * ((bi * c + bq * s) - st.r); st.i += a * ((bq * c - bi * s) - st.i);
          bi -= st.r * c - st.i * s; bq -= st.r * s + st.i * c;
        }
      }
      if (this.cfg.afc) this._acq(bi, bq);
      const c = this.cfg, ms = markSign(c.sideband, c.reverse);
      const fm = ms * c.shift / 2, fsp = -fm;
      this.phM -= TWO_PI * fm / this.fsd; this.phS -= TWO_PI * fsp / this.fsd;
      if (this.phM > Math.PI) this.phM -= TWO_PI; if (this.phM < -Math.PI) this.phM += TWO_PI;
      if (this.phS > Math.PI) this.phS -= TWO_PI; if (this.phS < -Math.PI) this.phS += TWO_PI;
      const cm = Math.cos(this.phM), sm = Math.sin(this.phM), cs = Math.cos(this.phS), ss = Math.sin(this.phS);
      const mr = bi * cm - bq * sm, mi = bi * sm + bq * cm;
      const sr = bi * cs - bq * ss, si = bi * ss + bq * cs;
      // half-bit running sums
      const k = this.bi;
      this.sMr += mr - this.bufMr[k]; this.bufMr[k] = mr;
      this.sMi += mi - this.bufMi[k]; this.bufMi[k] = mi;
      this.sSr += sr - this.bufSr[k]; this.bufSr[k] = sr;
      this.sSi += si - this.bufSi[k]; this.bufSi[k] = si;
      this.bi = (k + 1) % this.N;
      if (++this.recount > 20000) { // remove float drift from the running sums
        this.recount = 0;
        let a = 0, b = 0, e = 0, f = 0;
        for (let j = 0; j < this.N; j++) { a += this.bufMr[j]; b += this.bufMi[j]; e += this.bufSr[j]; f += this.bufSi[j]; }
        this.sMr = a; this.sMi = b; this.sSr = e; this.sSi = f;
      }
      const zmr = this.sMr / this.N, zmi = this.sMi / this.N, zsr = this.sSr / this.N, zsi = this.sSi / this.N;
      // full-bit matched filter = coherent sum of two half-bit sums; non-coherent sum under flutter
      const C = this.hc, j = this.hi, jl = (j - this.L + this.HL * 2) % this.HL;
      C[4 * j] = zmr; C[4 * j + 1] = zmi; C[4 * j + 2] = zsr; C[4 * j + 3] = zsi;
      const mh = Math.hypot(zmr, zmi), sh = Math.hypot(zsr, zsi);
      const m1 = Math.hypot(zmr + C[4 * jl], zmi + C[4 * jl + 1]) / 2, s1 = Math.hypot(zsr + C[4 * jl + 2], zsi + C[4 * jl + 3]) / 2;
      const m2 = (mh + Math.hypot(C[4 * jl], C[4 * jl + 1])) / 2, s2 = (sh + Math.hypot(C[4 * jl + 2], C[4 * jl + 3])) / 2;
      this.hi = (j + 1) % this.HL;
      const w0 = this.metrics.selective;
      const m = w0 * m1 + (1 - w0) * m2, s = w0 * s1 + (1 - w0) * s2;

      // per-tone signal / noise levels
      const aS = 1 / this.bitLen, aN = 1 / (this.bitLen * 4);
      if (m > s) { this.mSig += aS * (m - this.mSig); this.sNoise += aN * (s - this.sNoise); }
      else { this.sSig += aS * (s - this.sSig); this.mNoise += aN * (m - this.mNoise); }
      const pk = m > s ? m : s;
      // single-tone mode: a notch sits on one tone, so decode on-off keying of the other tone,
      // with that tone's level tracked against its own threshold
      const mNotched = this._notchNear(markSign(c.sideband, c.reverse) * c.shift / 2), sNotched = this._notchNear(-markSign(c.sideband, c.reverse) * c.shift / 2);
      const single = mNotched !== sNotched ? (mNotched ? 'space' : 'mark') : null;
      let dSingle = 0;
      if (single) {
        const x = single === 'mark' ? m : s, T = this.t2 || (this.t2 = { S: x, N: 0, low: 0 });
        const aD = 1 / (this.bitLen * 8); // a keyed tone can be off for a whole character (e.g. LTRS + stop)
        if (x > 0.5 * (T.S + T.N)) { T.S += aS * (x - T.S); T.low = 0; } else { T.N += aN * (x - T.N); if (++T.low > 15 * this.bitLen) T.S += aD * (x - T.S); }
        const v = Math.min(x, T.S) - 0.5 * (T.S + T.N);
        dSingle = 2 * (single === 'mark' ? v : -v); // same scale as the two-tone decision
      } else this.t2 = null;
      let d;
      if (c.atc) {
        // strategy 2: fast common level x slow per-tone balance (flutter)
        const aF = 1 / (this.bitLen * 0.7), aB = 1 / (this.bitLen * 3);
        if (this.P === 0) this.P = pk;
        this.P += aF * (pk - this.P);
        const P = this.P + 1e-12;
        if (m > s) this.bm += aB * (Math.min(2, m / P) - this.bm); else this.bs += aB * (Math.min(2, s / P) - this.bs);
        const lm = P * this.bm, ls = P * this.bs;
        const d2 = (Math.min(m, lm) - 0.5 * (lm + this.mNoise)) - (Math.min(s, ls) - 0.5 * (ls + this.sNoise));
        // strategy 1: per-tone clipped mid-threshold (selective / multipath fading)
        const d1 = (Math.min(m, this.mSig) - 0.5 * (this.mSig + this.mNoise)) - (Math.min(s, this.sSig) - 0.5 * (this.sSig + this.sNoise));
        // fading speed of the active tone, normalised by that tone's long-term level
        if (!this.fade) this.fade = { f: [pk, pk], s: [pk, pk], l: [pk, pk] };
        const F = this.fade, ti = m > s ? 0 : 1;
        F.f[ti] += (1 / (this.bitLen * 0.25)) * (pk - F.f[ti]);
        F.s[ti] += (1 / (this.bitLen * 4)) * (pk - F.s[ti]);
        if (F.s[ti] > 4 * F.l[ti]) F.l[ti] = F.s[ti]; else F.l[ti] += (1 / (this.bitLen * 60)) * (pk - F.l[ti]);
        const fl = Math.min(0.6, Math.abs(F.f[ti] - F.s[ti]) / (F.l[ti] + 1e-12));
        this.imb += (1 / (this.bitLen * 80)) * (fl - this.imb);
        const w = Math.min(1, Math.max(0, (0.30 - this.imb) * 33));
        this.metrics.selective = w;
        d = w * d1 + (1 - w) * d2;
      } else d = (m - s) * 0.5;
      if (single) d = dSingle;
      const norm = single ? this.t2.S + 1e-12 : 0.5 * (this.mSig + this.sSig) + 1e-12;

      // AFC: phase rotation of the dominant half-bit filter = residual frequency error
      if (c.afc) {
        let zr, zi, pr, pi, wt;
        if (m > s) { zr = zmr; zi = zmi; pr = this.pzm[0]; pi = this.pzm[1]; wt = m * m; }
        else { zr = zsr; zi = zsi; pr = this.pzs[0]; pi = this.pzs[1]; wt = s * s; }
        const dp = Math.atan2(zi * pr - zr * pi, zr * pr + zi * pi);
        if (Math.abs(d) / norm > 0.5) { this.afcAcc += wt * dp; this.afcW += wt; }
        if (++this.afcCnt >= this.N) {
          this.afcCnt = 0;
          if (this.afcW > 0 && this.metrics.snr > 7 && this.metrics.quality > 0.5) {
            const err = (this.afcAcc / this.afcW) * this.fsd / TWO_PI;
            const lo = this.userCenter - c.afcRange, hi = this.userCenter + c.afcRange;
            c.center = Math.min(hi, Math.max(lo, c.center + 0.15 * err));
          }
          this.afcAcc = 0; this.afcW = 0;
        }
      }
      this.pzm[0] = zmr; this.pzm[1] = zmi; this.pzs[0] = zsr; this.pzs[1] = zsi;

      // tuning scope: re-rotated baseband outputs so tones draw as lines (mark ⟷, space ↕)
      this.scopeRot += 0.73;
      const cr = Math.cos(this.scopeRot), sr2 = Math.sin(this.scopeRot);
      this.scope[this.scopeIdx] = (zmr * cr - zmi * sr2) / (norm * 1.4);
      this.scope[this.scopeIdx + 1] = (zsr * cr - zsi * sr2) / (norm * 1.4);
      this.scopeIdx = (this.scopeIdx + 2) % this.scope.length;

      const M = this.metrics;
      M.mark = m; M.space = s;
      const nz = 0.5 * (this.mNoise + this.sNoise) + 1e-12;
      M.snr = single ? 20 * Math.log10(this.t2.S / (this.t2.N + 1e-12)) : 20 * Math.log10(norm / nz);
      M.afcOffset = c.center - this.userCenter;

      // carrier detect (used only by the squelch): fast level vs long-term level, plus SNR
      this.Pc += (1 / (this.bitLen * 0.5)) * (pk - this.Pc);
      this.Plong += (1 / (this.bitLen * (this.Pc > this.Plong ? 3 : 40))) * (this.Pc - this.Plong);
      // hysteresis: "off" only after a full second without signal, so fades do not count
      const present = this.t > 0.5 * this.fsd && this.Pc > 0.3 * this.Plong && M.snr > 6; // 0.5 s warm-up: noise estimate starts at 0
      if (present) { if (this.carrierOff) { this.carrierOnT = this.t; this.seenM = 0; this.seenS = 0; } this.carrierOff = false; this.absent = 0; }
      else if (++this.absent > this.fsd) this.carrierOff = true;
      M.carrier = !this.carrierOff;
      if (m > s) this.seenM++; else this.seenS++; // both tones must be learned before printing

      this._sync(d, norm);
    }
    _notchNear(off) { // is a notch within 25 Hz of the tone at baseband offset `off`?
      const nl = this.cfg.notches; if (!nl || !nl.length) return false;
      const f = this.cfg.center + off; return nl.some(n => Math.abs(n - f) < 25);
    }
    // AFC acquisition: when decoding is poor, search ±afcRange for the best mark/space pair
    // (non-coherent, one-bit segments over the last 0.6 s) and jump there if clearly better.
    _acq(bi, bq) {
      const R = this.acqR, N = this.acqN;
      R[2 * this.acqI] = bi; R[2 * this.acqI + 1] = bq; this.acqI = (this.acqI + 1) % N;
      if (++this.acqCnt < N / 2 || this.t < N) return;
      this.acqCnt = 0;
      if (this.metrics.quality > 0.55) return;
      const c = this.cfg, ms = markSign(c.sideband, c.reverse), fm = ms * c.shift / 2, seg = Math.max(4, Math.round(this.bitLen));
      // per-segment energy of one tone at baseband frequency f over the last 0.6 s
      const segE = f => {
        const w = -TWO_PI * f / this.fsd, cw = Math.cos(w), sw = Math.sin(w), out = [];
        let pr = 1, pi = 0, ar = 0, ai = 0, k = 0;
        for (let n = 0; n < N; n++) {
          const j = (this.acqI + n) % N, xr = R[2 * j], xi = R[2 * j + 1];
          ar += xr * pr - xi * pi; ai += xr * pi + xi * pr;
          const t2 = pr * cw - pi * sw; pi = pr * sw + pi * cw; pr = t2;
          if (++k === seg) { out.push(ar * ar + ai * ai); ar = 0; ai = 0; k = 0; }
        }
        return out;
      };
      const sum = a => a.reduce((x, y) => x + y, 0);
      const E = [], offs = [];
      for (let df = -c.afcRange; df <= c.afcRange; df += 4) {
        const nc = c.center + df; if (nc < this.userCenter - c.afcRange || nc > this.userCenter + c.afcRange) continue;
        E.push(Math.min(sum(segE(fm + df)), sum(segE(-fm + df)))); offs.push(df); // both tones must be there
      }
      if (E.length < 5) return;
      let best = 0; for (let i = 1; i < E.length; i++) if (E[i] > E[best]) best = i;
      const sorted = E.slice().sort((x, y) => x - y), med = sorted[sorted.length >> 1];
      const i0 = offs.indexOf(0), e0 = i0 >= 0 ? E[i0] : med, df = offs[best];
      if (Math.abs(df) < 8 || !(E[best] > 4 * med) || !(E[best] > 2 * e0)) { this.acqPend = null; return; }
      // FSK signature: mark and space take turns (negatively correlated); a carrier does not
      const a1 = segE(fm + df), a2 = segE(-fm + df), n = Math.min(a1.length, a2.length);
      const m1 = sum(a1) / n, m2 = sum(a2) / n; let sxy = 0, sxx = 0, syy = 0;
      for (let i = 0; i < n; i++) { const x = a1[i] - m1, y = a2[i] - m2; sxy += x * y; sxx += x * x; syy += y * y; }
      if (sxy / Math.sqrt(sxx * syy + 1e-30) > -0.2) { this.acqPend = null; return; }
      // the same target must be found by two searches in a row before we jump
      const target = c.center + df;
      if (this.acqPend == null || Math.abs(this.acqPend - target) > 8) { this.acqPend = target; return; }
      this.acqPend = null; c.center = target; this.metrics.acq = (this.metrics.acq || 0) + 1;
    }
    _sync(d, norm) {
      const pd = this.prevD;
      this.prevD = d;
      if (this.state === 0) {
        if (pd > 0 && d <= 0) {
          const frac = pd / (pd - d);
          this.counter = 0.5 * this.bitLen - (1 - frac);
          this.state = 1; this.bitIdx = 0; this.code = 0; this.qAcc = 0;
          this.tStart = this.t - (1 - frac);
        }
        return;
      }
      this.counter -= 1;
      if (this.counter > 0) return;
      const t = -this.counter; // sample at the bit centre, interpolated
      const v = d + (pd - d) * t;
      this.qAcc += Math.min(1, Math.abs(v) / norm);
      const av = Math.abs(v);
      this.avgAbs = this.avgAbs ? this.avgAbs + 0.01 * (av - this.avgAbs) : av;
      const rel = av / (this.avgAbs + 1e-12);
      if (this.bitIdx === 0 || rel < this.qMin) this.qMin = rel;
      if (this.bitIdx === 0) {
        if (v > 0) { this.state = 0; return; } // glitch, not a start bit
      } else if (this.bitIdx <= 5) {
        if (v > 0) this.code |= 1 << (this.bitIdx - 1);
      } else {
        const q = this.qAcc / 7;
        this.metrics.quality = 0.8 * this.metrics.quality + 0.2 * q;
        this.state = 0;
        if (v <= 0) return; // framing error: stop bit missing
        const sq = this.cfg.squelch;
        if (sq > 0) {
          if (q < sq || this.metrics.snr < sq * 15) return;
          if (this.carrierOff) return;                                // no signal for a while
          if (this.tStart - this.carrierOnT < 1.5 * this.bitLen) return; // first character after onset is unreliable
          if (this.seenS < 4 * this.bitLen || this.seenM < 4 * this.bitLen) return;  // ATC has not heard both tones yet
        }
        this._emit(this.code, this.qMin, q);
        return;
      }
      this.bitIdx++;
      this.counter += this.bitLen;
    }
    _emit(code, conf, q) {
      if (code === C_FIGS) { this.figs = true; return; }
      if (code === C_LTRS) { this.figs = false; return; }
      const ch = (this.figs ? FIGS_CH : LTRS_CH)[code];
      if (code === C_SPACE && this.cfg.usos) this.figs = false;
      if (ch === '\0' || ch == null || ch === '\x07' || ch === '\r') return;
      this.onChar(ch, conf, q);
    }
  }

  /* Text -> Baudot. After every space the shift state is treated as unknown, so the next
     character always carries its own LTRS/FIGS: correct for receivers with USOS on or off. */
  function textToCodeList(text) {
    const L = {}, F = {};
    LTRS_CH.forEach((c, i) => { if (c && c !== '\0') L[c] = i; });
    FIGS_CH.forEach((c, i) => { if (c && c !== '\0' && !(c in L)) F[c] = i; });
    const out = [];
    let figs = null; // null = unknown
    for (const ch of String(text).toUpperCase()) {
      if (ch === '\r') continue;
      if (ch === '\n') { out.push({ codes: [8, 2], ch: '\n' }); continue; }
      if (ch === ' ') { out.push({ codes: [C_SPACE], ch: ' ' }); figs = null; continue; }
      if (ch in L) { out.push({ codes: figs === false ? [L[ch]] : [C_LTRS, L[ch]], ch }); figs = false; }
      else if (ch in F) { out.push({ codes: figs === true ? [F[ch]] : [C_FIGS, F[ch]], ch }); figs = true; }
    }
    return out;
  }
  function textToCodes(text) {
    const codes = [C_LTRS, C_LTRS];
    for (const e of textToCodeList(text)) codes.push(...e.codes);
    return codes;
  }

  // Phase-continuous AFSK with smoothed frequency transitions (clean, narrow signal)
  function renderAfsk(codes, o) {
    const fs = o.sampleRate, baud = o.baud || 45.45, shift = o.shift || 170, center = o.center || 1500;
    const ms = markSign(o.sideband || 'LSB', !!o.reverse);
    const fMark = center + ms * shift / 2, fSpace = center - ms * shift / 2;
    const T = fs / baud;
    const leadIn = Math.round((o.leadMs == null ? 150 : o.leadMs) * fs / 1000);
    const bits = [];
    for (const c of codes) {
      bits.push([0, 1]);
      for (let b = 0; b < 5; b++) bits.push([(c >> b) & 1, 1]);
      bits.push([1, o.stopBits || 1.5]);
    }
    let total = leadIn * 2;
    for (const b of bits) total += b[1] * T;
    total = Math.ceil(total) + leadIn;
    const keyed = new Float32Array(total);
    let n = 0; for (; n < leadIn; n++) keyed[n] = 1;
    let acc = leadIn;
    for (const [v, dur] of bits) { const end = acc + dur * T; for (; n < end && n < total; n++) keyed[n] = v; acc = end; }
    for (; n < total; n++) keyed[n] = 1;
    const W = Math.max(1, Math.round(T / 5));
    const sm = new Float32Array(total); let run = W;
    for (let i = 0; i < total; i++) { run += keyed[i] - (i >= W ? keyed[i - W] : 1); sm[i] = run / W; }
    const out = new Float32Array(total);
    const amp = o.amplitude == null ? 0.5 : o.amplitude;
    const ramp = Math.round(0.005 * fs);
    let ph = 0;
    for (let i = 0; i < total; i++) {
      const f = fSpace + (fMark - fSpace) * sm[i];
      ph += TWO_PI * f / fs; if (ph > TWO_PI) ph -= TWO_PI;
      let g = amp;
      if (i < ramp) g *= i / ramp; else if (i > total - ramp) g *= (total - i) / ramp;
      out[i] = g * Math.sin(ph);
    }
    out.fMark = fMark; out.fSpace = fSpace; out.keyed = sm; out.leadIn = leadIn; out.charSamples = (6 + (o.stopBits || 1.5)) * T;
    return out;
  }

  /* RttyHost: a set of decoders on one audio stream, driven by messages. The same code runs in
     an AudioWorklet (off the main thread) or, as a fallback, on the main thread.
       in : {type:'add'|'set', id, cfg} {type:'remove', id} {type:'reset', id?} {type:'mute', on}
       out: {type:'chars', items:[[id, ch, conf], ...]}
            {type:'metrics', list:[{id, center, userCenter, m, s, sig, snr, q, afc, sel, car}], scope, scopeIdx} */
  class RttyHost {
    constructor(sampleRate, post) {
      this.fs = sampleRate; this.post = post; this.dec = new Map(); this.muted = false;
      this.items = []; this.acc = 0; this.every = Math.round(sampleRate * 0.05);
    }
    handle(m) {
      if (m.type === 'add') {
        const d = new RttyDecoder(Object.assign({}, m.cfg, { sampleRate: this.fs, onChar: (ch, conf) => this.items.push([m.id, ch, conf]) }));
        this.dec.set(m.id, d);
      } else if (m.type === 'set') { const d = this.dec.get(m.id); if (d) d.set(m.cfg); }
      else if (m.type === 'remove') this.dec.delete(m.id);
      else if (m.type === 'reset') { for (const [id, d] of this.dec) if (m.id == null || m.id === id) d.reset(); }
      else if (m.type === 'mute') this.muted = !!m.on;
    }
    process(buf) {
      if (!this.muted) for (const d of this.dec.values()) d.process(buf);
      this.acc += buf.length;
      if (this.acc < this.every) return;
      this.acc = 0;
      if (this.items.length) { this.post({ type: 'chars', items: this.items }); this.items = []; }
      const list = []; let scope = null, scopeIdx = 0;
      for (const [id, d] of this.dec) {
        const M = d.metrics;
        list.push({ id, center: d.cfg.center, userCenter: d.userCenter, m: M.mark, s: M.space, sig: Math.max(d.mSig, d.sSig),
          snr: M.snr, q: M.quality, afc: M.afcOffset, sel: M.selective, car: M.carrier });
        if (id === 'main') { scope = d.scope.slice(); scopeIdx = d.scopeIdx; }
      }
      this.post({ type: 'metrics', list, scope, scopeIdx });
    }
  }

  const api = { RttyDecoder, RttyHost, textToCodeList, textToCodes, renderAfsk, markSign, LTRS_CH, FIGS_CH };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.RTTY = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
