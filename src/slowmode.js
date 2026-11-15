// Automatic slow mode: count messages per channel as they arrive, and once a
// minute set each managed channel's slow mode from how busy it is (the rules
// are nextSlowmode in policy.js). Mixed into AutoKickBot.

import { BudgetExceeded } from './discord.js';
import { nextSlowmode, slowmodeSettings } from './policy.js';

const RATE_WINDOW_MS = 60_000;
const MANUAL_PAUSE_MS = 30 * 60_000; // a moderator changed it by hand: leave the channel alone this long
const FAILURE_PAUSE_MS = 60 * 60_000;
export const MAX_SLOWMODE_CHANNELS = 25;

export const slowmodeMethods = {
  initSlowmode() {
    this.messageTimes = new Map(); // channelId -> times of messages in the last minute (memory only)
    this.knownSlowmode = new Map(); // channelId -> the channel's slow mode, as last seen
    this.slowmodeState = new Map(); // channelId -> { setTo, changedAt, lowStreak, manualUntil, failedAt }
  },

  countMessage(channelId, now = Date.now()) {
    let times = this.messageTimes.get(channelId);
    if (!times) this.messageTimes.set(channelId, (times = []));
    times.push(now);
    if (times.length > 1000) times.splice(0, times.length - 1000);
  },

  /** Messages in the channel during the last minute. */
  messageRate(channelId, now = Date.now()) {
    const times = this.messageTimes.get(channelId);
    if (!times) return 0;
    const cutoff = now - RATE_WINDOW_MS;
    let drop = 0;
    while (drop < times.length && times[drop] <= cutoff) drop += 1;
    if (drop) times.splice(0, drop);
    if (!times.length) this.messageTimes.delete(channelId);
    return times.length;
  },

  /** Remember a channel's slow mode; notice when someone changes one the bot manages by hand. */
  noteChannelSlowmode(channel) {
    if (!channel?.id || channel.rate_limit_per_user === undefined) return;
    const seconds = channel.rate_limit_per_user ?? 0;
    const state = this.slowmodeState.get(channel.id);
    if (state?.setTo !== undefined && seconds !== state.setTo && seconds !== this.knownSlowmode.get(channel.id)) {
      state.manualUntil = Date.now() + MANUAL_PAUSE_MS;
    }
    this.knownSlowmode.set(channel.id, seconds);
  },

  /** The channel's slow mode right now (fetched if not known yet). */
  async channelSlowmode(channelId, budget) {
    if (this.knownSlowmode.has(channelId)) return this.knownSlowmode.get(channelId);
    const channel = await this.rest('GET', `/channels/${channelId}`, { budget });
    this.noteChannelSlowmode(channel);
    return channel.rate_limit_per_user ?? 0;
  },

  /** Runs every minute: adjust every managed channel. */
  async runSlowmode(budget) {
    const now = Date.now();
    for (const [id, times] of this.messageTimes) {
      if (!times.length || times[times.length - 1] <= now - RATE_WINDOW_MS) this.messageTimes.delete(id);
    }

    for (const { id: guildId, config } of this.sql.exec('SELECT id, config FROM guilds').toArray()) {
      for (const [channelId, limits] of Object.entries(slowmodeSettings(JSON.parse(config)).channels)) {
        let state = this.slowmodeState.get(channelId);
        if (!state) this.slowmodeState.set(channelId, (state = { lowStreak: 0, changedAt: 0 }));
        if ((state.manualUntil ?? 0) > now || now - (state.failedAt ?? 0) < FAILURE_PAUSE_MS) continue;

        const rate = this.messageRate(channelId, now);
        const current = this.knownSlowmode.has(channelId) ? this.knownSlowmode.get(channelId) : null;
        const next = nextSlowmode({
          rate,
          current,
          min: limits.min ?? 0,
          max: limits.max ?? 30,
          sensitivity: limits.sensitivity ?? 'normal',
          calmMinutes: limits.calm ?? 3,
          lowStreak: state.lowStreak,
          sinceChangeMs: now - state.changedAt,
        });
        state.lowStreak = next.lowStreak;
        if (next.seconds === current) continue;
        if (budget.remaining < 3) return;
        await this.setSlowmode(guildId, channelId, next.seconds, `AutoKick: auto slow mode (${rate} messages in the last minute)`, budget);
      }
    }
  },

  /** Change a channel's slow mode. Returns true if it worked. */
  async setSlowmode(guildId, channelId, seconds, reason, budget) {
    let state = this.slowmodeState.get(channelId);
    if (!state) this.slowmodeState.set(channelId, (state = { lowStreak: 0, changedAt: 0 }));
    state.setTo = seconds; // set first, so the CHANNEL_UPDATE echo isn't mistaken for a manual change
    try {
      await this.rest('PATCH', `/channels/${channelId}`, { body: { rate_limit_per_user: seconds }, reason, budget });
      this.knownSlowmode.set(channelId, seconds);
      state.changedAt = Date.now();
      return true;
    } catch (err) {
      if (err instanceof BudgetExceeded) throw err;
      state.failedAt = Date.now();
      if (err.status === 404) {
        this.forgetSlowmodeChannel(guildId, channelId); // channel deleted
        return false;
      }
      console.warn(`Could not set slow mode in ${channelId}: ${err.message}`);
      const why = err.status === 403 ? 'I need the **Manage Channels** permission there.' : err.message;
      await this.logSafely(guildId, `⚠️ Couldn't change slow mode in <#${channelId}>: ${why} I'll try again in an hour.`, budget);
      return false;
    }
  },

  /** Stop managing a channel (deleted, or taken off the whitelist). */
  forgetSlowmodeChannel(guildId, channelId) {
    const cfg = this.getConfig(guildId);
    if (cfg?.slowmode?.channels?.[channelId]) {
      delete cfg.slowmode.channels[channelId];
      this.saveConfig(guildId, cfg);
    }
    this.slowmodeState.delete(channelId);
    this.messageTimes.delete(channelId);
  },
};
