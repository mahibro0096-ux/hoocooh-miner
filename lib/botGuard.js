/**
 * lib/botGuard.js — Anti-script & Termux detection for mechanical action cycles
 * Modeled from NEWTUBE-TON botGuard.js
 */

const AD_BOT_SAMPLE_SIZE = 5;
const AD_BOT_MAX_WATCH_SECONDS = 7;
const AD_BOT_MAX_IDLE_SECONDS = 1;
const AD_BOT_METRONOME_SAMPLES = 8;
const AD_BOT_CYCLE_SPREAD_SECONDS = 1;
const AD_BOT_CYCLE_MAX_SECONDS = 40;
const AD_BOT_WATCH_SPREAD_SECONDS = 0.3;
const AD_BOT_GAP_SPREAD_SECONDS = 0.3;
const AD_BOT_GAP_MAX_SECONDS = 20;

function detectBotPattern(samples) {
  if (!Array.isArray(samples)) return null;
  const n = samples.length;

  if (n >= AD_BOT_SAMPLE_SIZE) {
    const last = samples.slice(-AD_BOT_SAMPLE_SIZE);
    const fastNoGap = last.every((x, i) =>
      x.w <= AD_BOT_MAX_WATCH_SECONDS &&
      (i === 0 || (x.s - last[i - 1].c) / 1000 <= AD_BOT_MAX_IDLE_SECONDS)
    );
    if (fastNoGap) {
      return {
        rule: "A",
        detail: `${AD_BOT_SAMPLE_SIZE} actions in a row watched ≤${AD_BOT_MAX_WATCH_SECONDS}s with ≤${AD_BOT_MAX_IDLE_SECONDS}s gap`
      };
    }

    const ws = last.map(x => x.w || 0);
    if (Math.max(...ws) - Math.min(...ws) <= AD_BOT_WATCH_SPREAD_SECONDS) {
      return {
        rule: "C",
        detail: `${AD_BOT_SAMPLE_SIZE} actions with near-identical duration (${Math.min(...ws).toFixed(1)}–${Math.max(...ws).toFixed(1)}s)`
      };
    }

    const gaps = last.slice(1).map((x, i) => Math.max(0, (x.s - last[i].c) / 1000));
    if (gaps.length > 0 && Math.max(...gaps) <= AD_BOT_GAP_MAX_SECONDS && (Math.max(...gaps) - Math.min(...gaps)) <= AD_BOT_GAP_SPREAD_SECONDS) {
      return {
        rule: "E",
        detail: `${AD_BOT_SAMPLE_SIZE} actions with metronome pauses (${Math.min(...gaps).toFixed(1)}–${Math.max(...gaps).toFixed(1)}s)`
      };
    }
  }

  if (n >= AD_BOT_METRONOME_SAMPLES) {
    const last = samples.slice(-AD_BOT_METRONOME_SAMPLES);
    const cycles = last.slice(1).map((x, i) => (x.c - last[i].c) / 1000);
    if (cycles.length > 0 && Math.max(...cycles) <= AD_BOT_CYCLE_MAX_SECONDS && (Math.max(...cycles) - Math.min(...cycles)) <= AD_BOT_CYCLE_SPREAD_SECONDS) {
      return {
        rule: "B",
        detail: `${AD_BOT_METRONOME_SAMPLES} actions with metronome cycle (${Math.min(...cycles).toFixed(1)}–${Math.max(...cycles).toFixed(1)}s)`
      };
    }
  }

  return null;
}

module.exports = {
  detectBotPattern,
  AD_BOT_SAMPLE_SIZE
};
