// Fake Virtual Economy Gambling Bot
// Single-file Discord.js bot with SQLite persistence, slash commands only,
// rich interactions, animated message updates, animated images, and admin economy controls.
//
// Install:
//   npm i discord.js better-sqlite3 canvas
// Node.js 22+ recommended by discord.js.
//
// Create a local file next to this script named discord.env:
//   DISCORD_TOKEN=your_bot_token_here
//   CLIENT_ID=your_application_client_id
//   GUILD_ID=optional_test_guild_id
//   LOG_CHANNEL_ID=optional_log_channel_id
//   ADMIN_ROLE_IDS=roleid1,roleid2
//
// Run:
//   node bot.js

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { createCanvas } = require('canvas');
const {
  Client,
  GatewayIntentBits,
  Partials,
  Collection,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionsBitField,
  AttachmentBuilder,
  Events,
  Colors,
  MessageFlags,
} = require('discord.js');

// ------------------------------
// Environment loader
// ------------------------------
function loadDotEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadDotEnvFile(path.join(__dirname, 'discord.env'));

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID || null;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID || null;
const ADMIN_ROLE_IDS = new Set((process.env.ADMIN_ROLE_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean));

if (!TOKEN) {
  console.error('Missing DISCORD_TOKEN in discord.env');
  process.exit(1);
}

const PREFIX = '%';

// ------------------------------
// Database with auto-repair
// ------------------------------
let db;
try {
  const dbPath = path.join(__dirname, 'economy.sqlite');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  console.log('✓ Database connected successfully');
} catch (error) {
  console.error('✗ Database connection failed:', error.message);
  console.log('Attempting to repair database...');
  try {
    const dbPath = path.join(__dirname, 'economy.sqlite');
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
      console.log('Old database removed.');
    }
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    console.log('✓ Database repaired and recreated');
  } catch (repairError) {
    console.error('✗ Failed to repair database:', repairError.message);
    process.exit(1);
  }
}

db.exec(`
CREATE TABLE IF NOT EXISTS guild_settings (
  guild_id TEXT PRIMARY KEY,
  economy_name TEXT DEFAULT 'Coins',
  currency_id TEXT DEFAULT 'coin',
  house_edge REAL DEFAULT 0.02,
  payout_multiplier REAL DEFAULT 1.0,
  locale TEXT DEFAULT 'en',
  created_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS currencies (
  guild_id TEXT NOT NULL,
  currency_id TEXT NOT NULL,
  name TEXT NOT NULL,
  symbol TEXT NOT NULL,
  rate REAL DEFAULT 1.0,
  enabled INTEGER DEFAULT 1,
  PRIMARY KEY (guild_id, currency_id)
);

CREATE TABLE IF NOT EXISTS users (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  prestige INTEGER DEFAULT 0,
  xp INTEGER DEFAULT 0,
  level INTEGER DEFAULT 1,
  daily_streak INTEGER DEFAULT 0,
  weekly_streak INTEGER DEFAULT 0,
  last_daily INTEGER DEFAULT 0,
  last_weekly INTEGER DEFAULT 0,
  last_work INTEGER DEFAULT 0,
  last_beg INTEGER DEFAULT 0,
  last_crime INTEGER DEFAULT 0,
  last_rob INTEGER DEFAULT 0,
  quest_state_json TEXT DEFAULT '{}',
  stats_json TEXT DEFAULT '{}',
  achievements_json TEXT DEFAULT '[]',
  battlepass_xp INTEGER DEFAULT 0,
  battlepass_tier INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch()),
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS wallets (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  currency_id TEXT NOT NULL,
  balance INTEGER DEFAULT 0,
  bank INTEGER DEFAULT 0,
  PRIMARY KEY (guild_id, user_id, currency_id)
);

CREATE TABLE IF NOT EXISTS items (
  guild_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  name TEXT NOT NULL,
  price INTEGER DEFAULT 0,
  rarity TEXT DEFAULT 'common',
  emoji TEXT DEFAULT '🧩',
  description TEXT DEFAULT '',
  data_json TEXT DEFAULT '{}',
  PRIMARY KEY (guild_id, item_id)
);

CREATE TABLE IF NOT EXISTS inventory (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  quantity INTEGER DEFAULT 0,
  PRIMARY KEY (guild_id, user_id, item_id)
);

CREATE TABLE IF NOT EXISTS loot_tables (
  guild_id TEXT NOT NULL,
  loot_id TEXT NOT NULL,
  name TEXT NOT NULL,
  data_json TEXT NOT NULL,
  PRIMARY KEY (guild_id, loot_id)
);

CREATE TABLE IF NOT EXISTS custom_rewards (
  guild_id TEXT NOT NULL,
  reward_id TEXT NOT NULL,
  name TEXT NOT NULL,
  data_json TEXT NOT NULL,
  PRIMARY KEY (guild_id, reward_id)
);

CREATE TABLE IF NOT EXISTS custom_events (
  guild_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  name TEXT NOT NULL,
  active INTEGER DEFAULT 0,
  starts_at INTEGER DEFAULT 0,
  ends_at INTEGER DEFAULT 0,
  data_json TEXT NOT NULL,
  PRIMARY KEY (guild_id, event_id)
);

CREATE TABLE IF NOT EXISTS custom_games (
  guild_id TEXT NOT NULL,
  game_id TEXT NOT NULL,
  name TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  data_json TEXT NOT NULL,
  PRIMARY KEY (guild_id, game_id)
);

CREATE TABLE IF NOT EXISTS forced_results (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  game_id TEXT NOT NULL,
  result_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id, game_id)
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  currency_id TEXT NOT NULL,
  type TEXT NOT NULL,
  delta INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  details TEXT DEFAULT '',
  created_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  target_id TEXT,
  details TEXT,
  created_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS backups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  created_at INTEGER DEFAULT (unixepoch())
);
`);

const stmt = {
  getGuild: db.prepare('SELECT * FROM guild_settings WHERE guild_id = ?'),
  setGuild: db.prepare(`INSERT INTO guild_settings (guild_id, economy_name, currency_id, house_edge, payout_multiplier, locale)
    VALUES (@guild_id, @economy_name, @currency_id, @house_edge, @payout_multiplier, @locale)
    ON CONFLICT(guild_id) DO UPDATE SET
      economy_name=excluded.economy_name,
      currency_id=excluded.currency_id,
      house_edge=excluded.house_edge,
      payout_multiplier=excluded.payout_multiplier,
      locale=excluded.locale`),
  getCurrency: db.prepare('SELECT * FROM currencies WHERE guild_id = ? AND currency_id = ?'),
  upsertCurrency: db.prepare(`INSERT INTO currencies (guild_id, currency_id, name, symbol, rate, enabled)
    VALUES (@guild_id, @currency_id, @name, @symbol, @rate, @enabled)
    ON CONFLICT(guild_id, currency_id) DO UPDATE SET
      name=excluded.name, symbol=excluded.symbol, rate=excluded.rate, enabled=excluded.enabled`),
  getUser: db.prepare('SELECT * FROM users WHERE guild_id = ? AND user_id = ?'),
  upsertUser: db.prepare(`INSERT INTO users (guild_id, user_id) VALUES (?, ?)
    ON CONFLICT(guild_id, user_id) DO NOTHING`),
  getWallet: db.prepare('SELECT * FROM wallets WHERE guild_id = ? AND user_id = ? AND currency_id = ?'),
  upsertWallet: db.prepare(`INSERT INTO wallets (guild_id, user_id, currency_id, balance, bank)
    VALUES (?, ?, ?, 0, 0)
    ON CONFLICT(guild_id, user_id, currency_id) DO NOTHING`),
  updateWalletBalance: db.prepare('UPDATE wallets SET balance = ? WHERE guild_id = ? AND user_id = ? AND currency_id = ?'),
  updateWalletBank: db.prepare('UPDATE wallets SET bank = ? WHERE guild_id = ? AND user_id = ? AND currency_id = ?'),
  addInventory: db.prepare(`INSERT INTO inventory (guild_id, user_id, item_id, quantity)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(guild_id, user_id, item_id) DO UPDATE SET quantity = quantity + excluded.quantity`),
  getInventory: db.prepare('SELECT * FROM inventory WHERE guild_id = ? AND user_id = ? ORDER BY item_id'),
  setUser: db.prepare(`UPDATE users SET
    prestige=@prestige, xp=@xp, level=@level, daily_streak=@daily_streak, weekly_streak=@weekly_streak,
    last_daily=@last_daily, last_weekly=@last_weekly, last_work=@last_work, last_beg=@last_beg,
    last_crime=@last_crime, last_rob=@last_rob, quest_state_json=@quest_state_json, stats_json=@stats_json,
    achievements_json=@achievements_json, battlepass_xp=@battlepass_xp, battlepass_tier=@battlepass_tier
    WHERE guild_id=@guild_id AND user_id=@user_id`),
};

// ------------------------------
// Discord client
// ------------------------------
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.Channel],
});

client.commands = new Collection();
client.cooldowns = new Collection();
client.activeGames = new Collection();

// ------------------------------
// Canvas Animation Generators
// ------------------------------
function createCoinFlipAnimation(outcome, guess, win) {
  const frames = [];
  const width = 400, height = 300;
  const states = ['🪙', '🪙↩️', '🪙🎯', '💥'];
  
  for (let i = 0; i < states.length; i++) {
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    
    ctx.fillStyle = win ? '#2ecc71' : '#e74c3c';
    ctx.fillRect(0, 0, width, height);
    
    ctx.font = 'bold 120px Arial';
    ctx.fillStyle = 'white';
    ctx.textAlign = 'center';
    ctx.fillText(states[i], width / 2, 120);
    
    ctx.font = '28px Arial';
    ctx.fillText(`Outcome: ${outcome.toUpperCase()}`, width / 2, 200);
    ctx.fillText(`You guessed: ${guess.toUpperCase()}`, width / 2, 240);
    
    frames.push(canvas.toBuffer('image/png'));
  }
  return frames;
}

function createDiceAnimation(roll, target, win) {
  const frames = [];
  const width = 400, height = 300;
  
  for (let frame = 0; frame < 5; frame++) {
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    
    ctx.fillStyle = win ? '#2ecc71' : '#e74c3c';
    ctx.fillRect(0, 0, width, height);
    
    ctx.fillStyle = 'white';
    ctx.font = 'bold 100px Arial';
    ctx.textAlign = 'center';
    
    if (frame < 3) {
      const dice = [1, 2, 3, 4, 5, 6][Math.floor(Math.random() * 6)];
      ctx.fillText(`🎲 ${dice}`, width / 2, 130);
    } else {
      ctx.fillText(`🎲 ${roll}`, width / 2, 130);
    }
    
    ctx.font = '24px Arial';
    ctx.fillText(`Target: ${target} | Result: ${roll}`, width / 2, 220);
    ctx.fillText(win ? 'WINNER!' : 'BETTER LUCK NEXT TIME', width / 2, 260);
    
    frames.push(canvas.toBuffer('image/png'));
  }
  return frames;
}

function createSlotAnimation(reels, win) {
  const frames = [];
  const width = 500, height = 300;
  const symbols = ['🍒', '🍋', '🍇', '🍉', '7️⃣', '💎', '⭐'];
  
  for (let frame = 0; frame < 6; frame++) {
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    
    ctx.fillStyle = win ? '#2ecc71' : '#e74c3c';
    ctx.fillRect(0, 0, width, height);
    
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(100, 50, 300, 200);
    
    ctx.strokeStyle = 'gold';
    ctx.lineWidth = 3;
    ctx.strokeRect(100, 50, 300, 200);
    
    ctx.font = 'bold 80px Arial';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'white';
    
    const displayReels = frame < 4 
      ? [symbols[Math.floor(Math.random() * symbols.length)], symbols[Math.floor(Math.random() * symbols.length)], symbols[Math.floor(Math.random() * symbols.length)]]
      : reels;
    
    ctx.fillText(displayReels[0], 150, 160);
    ctx.fillText(displayReels[1], 250, 160);
    ctx.fillText(displayReels[2], 350, 160);
    
    ctx.font = '24px Arial';
    ctx.fillText(win ? '🎉 JACKPOT!' : 'NO MATCH', width / 2, 280);
    
    frames.push(canvas.toBuffer('image/png'));
  }
  return frames;
}

function createCrashAnimation(crashPoint, cashout, didSurvive) {
  const frames = [];
  const width = 500, height = 300;
  
  for (let frame = 0; frame < 6; frame++) {
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    
    ctx.fillStyle = didSurvive ? '#2ecc71' : '#e74c3c';
    ctx.fillRect(0, 0, width, height);
    
    ctx.strokeStyle = 'white';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(50, 250);
    
    const progress = frame / 5;
    for (let i = 0; i <= progress; i += 0.05) {
      const x = 50 + i * 400;
      const y = 250 - Math.pow(i, 1.5) * 150;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
    
    const currentMultiplier = 1 + progress * (crashPoint - 1);
    ctx.font = 'bold 48px Arial';
    ctx.fillStyle = 'white';
    ctx.textAlign = 'center';
    ctx.fillText(`x${currentMultiplier.toFixed(2)}`, width / 2, 100);
    
    ctx.font = '20px Arial';
    ctx.fillText(`Cashout target: x${cashout}`, width / 2, 150);
    ctx.fillText(`Crash at: x${crashPoint}`, width / 2, 180);
    
    frames.push(canvas.toBuffer('image/png'));
  }
  return frames;
}

function createWheelAnimation(result, frames_count = 6) {
  const frames = [];
  const width = 400, height = 400;
  const sections = ['x0', 'x1', 'x2', 'x5', 'x10', 'Jackpot!'];
  
  for (let frame = 0; frame < frames_count; frame++) {
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, width, height);
    
    const centerX = width / 2;
    const centerY = height / 2;
    const radius = 150;
    const rotation = (frame / frames_count) * Math.PI * 2;
    
    for (let i = 0; i < sections.length; i++) {
      const angle = (i / sections.length) * Math.PI * 2 + rotation;
      ctx.beginPath();
      ctx.moveTo(centerX, centerY);
      ctx.arc(centerX, centerY, radius, angle, angle + (Math.PI * 2 / sections.length));
      ctx.fillStyle = ['#e74c3c', '#f39c12', '#2ecc71', '#3498db', '#9b59b6', '#1abc9c'][i];
      ctx.fill();
      
      ctx.strokeStyle = 'white';
      ctx.lineWidth = 2;
      ctx.stroke();
      
      const textAngle = angle + (Math.PI / sections.length);
      const textX = centerX + Math.cos(textAngle) * 100;
      const textY = centerY + Math.sin(textAngle) * 100;
      ctx.fillStyle = 'white';
      ctx.font = 'bold 16px Arial';
      ctx.textAlign = 'center';
      ctx.fillText(sections[i], textX, textY);
    }
    
    ctx.fillStyle = 'gold';
    ctx.beginPath();
    ctx.moveTo(centerX - 10, 20);
    ctx.lineTo(centerX + 10, 20);
    ctx.lineTo(centerX, 40);
    ctx.fill();
    
    frames.push(canvas.toBuffer('image/png'));
  }
  return frames;
}

function createTreasureAnimation(spots, treasureCount, win) {
  const frames = [];
  const width = 400, height = 400;
  
  for (let reveal = 0; reveal <= 9; reveal++) {
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    
    ctx.fillStyle = win ? '#2ecc71' : '#8b7355';
    ctx.fillRect(0, 0, width, height);
    
    ctx.font = 'bold 32px Arial';
    ctx.fillStyle = 'white';
    ctx.textAlign = 'center';
    ctx.fillText('Treasure Hunt', width / 2, 50);
    
    ctx.font = '60px Arial';
    const cellSize = 80;
    const startX = (width - cellSize * 3 - 20) / 2;
    const startY = 120;
    
    for (let i = 0; i < 9; i++) {
      const row = Math.floor(i / 3);
      const col = i % 3;
      const x = startX + col * (cellSize + 10);
      const y = startY + row * (cellSize + 10);
      
      ctx.fillStyle = '#34495e';
      ctx.fillRect(x, y, cellSize, cellSize);
      ctx.strokeStyle = 'gold';
      ctx.lineWidth = 3;
      ctx.strokeRect(x, y, cellSize, cellSize);
      
      if (i < reveal) {
        ctx.fillStyle = 'white';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(spots[i], x + cellSize / 2, y + cellSize / 2);
      }
    }
    
    ctx.font = '20px Arial';
    ctx.fillStyle = 'white';
    ctx.fillText(`Treasures: ${treasureCount}`, width / 2, 380);
    
    frames.push(canvas.toBuffer('image/png'));
  }
  return frames;
}

function createHighLowAnimation(first, second, guess, win) {
  const frames = [];
  const width = 500, height = 300;
  
  for (let frame = 0; frame < 5; frame++) {
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    
    ctx.fillStyle = win ? '#2ecc71' : '#e74c3c';
    ctx.fillRect(0, 0, width, height);
    
    ctx.font = 'bold 48px Arial';
    ctx.fillStyle = 'white';
    ctx.textAlign = 'center';
    
    ctx.fillText('🂠 ' + first, 150, 120);
    ctx.fillText(frame < 3 ? '❓' : '🂠 ' + second, 350, 120);
    
    ctx.font = '24px Arial';
    ctx.fillText(`You guessed: ${guess}`, width / 2, 200);
    ctx.fillText(win ? 'CORRECT!' : 'WRONG!', width / 2, 240);
    
    frames.push(canvas.toBuffer('image/png'));
  }
  return frames;
}

// ------------------------------
// Utilities
// ------------------------------
const now = () => Math.floor(Date.now() / 1000);
const nowMs = () => Date.now();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const chance = (p) => Math.random() < p;
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const bold = (s) => `**${s}**`;

function formatNumber(n) {
  return new Intl.NumberFormat('en-US').format(Number(n || 0));
}

function coinEmoji(currency) {
  if (!currency) return '🪙';
  return currency.symbol || '🪙';
}

function makeBar(progress, total = 10, filled = '🟩', empty = '⬛') {
  const pct = clamp(progress, 0, 1);
  const filledCount = Math.round(pct * total);
  return filled.repeat(filledCount) + empty.repeat(total - filledCount);
}

function pickWeighted(list) {
  const total = list.reduce((a, b) => a + b.weight, 0);
  let roll = Math.random() * total;
  for (const item of list) {
    roll -= item.weight;
    if (roll <= 0) return item;
  }
  return list[list.length - 1];
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function safeJsonParse(input, fallback) {
  try { return JSON.parse(input); } catch { return fallback; }
}

function getGuildSettings(guildId) {
  let row = stmt.getGuild.get(guildId);
  if (!row) {
    row = {
      guild_id: guildId,
      economy_name: 'Coins',
      currency_id: 'coin',
      house_edge: 0.02,
      payout_multiplier: 1.0,
      locale: 'en',
    };
    stmt.setGuild.run(row);
  }
  const currency = getCurrency(guildId, row.currency_id);
  return { ...row, currency };
}

function ensureDefaults(guildId) {
  const settings = getGuildSettings(guildId);
  if (!stmt.getCurrency.get(guildId, settings.currency_id)) {
    stmt.upsertCurrency.run({
      guild_id: guildId,
      currency_id: 'coin',
      name: 'Coins',
      symbol: '🪙',
      rate: 1,
      enabled: 1,
    });
  }
  if (!stmt.getCurrency.get(guildId, settings.currency_id)) {
    stmt.upsertCurrency.run({
      guild_id: guildId,
      currency_id: settings.currency_id,
      name: settings.economy_name,
      symbol: '🪙',
      rate: 1,
      enabled: 1,
    });
  }
}

function getCurrency(guildId, currencyId) {
  return stmt.getCurrency.get(guildId, currencyId) || {
    guild_id: guildId,
    currency_id: currencyId,
    name: currencyId,
    symbol: '🪙',
    rate: 1,
    enabled: 1,
  };
}

function ensureUser(guildId, userId) {
  ensureDefaults(guildId);
  stmt.upsertUser.run(guildId, userId);
  const settings = getGuildSettings(guildId);
  stmt.upsertWallet.run(guildId, userId, settings.currency_id);
  return getUser(guildId, userId);
}

function getUser(guildId, userId) {
  ensureDefaults(guildId);
  stmt.upsertUser.run(guildId, userId);
  const row = stmt.getUser.get(guildId, userId);
  const wallet = getWallet(guildId, userId, getGuildSettings(guildId).currency_id);
  const stats = safeJsonParse(row.stats_json || '{}', {});
  const achievements = safeJsonParse(row.achievements_json || '[]', []);
  const quest = safeJsonParse(row.quest_state_json || '{}', {});
  return { ...row, wallet, stats, achievements, quest };
}

function getWallet(guildId, userId, currencyId) {
  stmt.upsertWallet.run(guildId, userId, currencyId);
  return stmt.getWallet.get(guildId, userId, currencyId) || { balance: 0, bank: 0 };
}

function setBalance(guildId, userId, amount, currencyId) {
  stmt.upsertWallet.run(guildId, userId, currencyId);
  stmt.updateWalletBalance.run(Math.max(0, Math.floor(amount)), guildId, userId, currencyId);
}

function addBalance(guildId, userId, amount, currencyId, type = 'adjust', details = '') {
  const wallet = getWallet(guildId, userId, currencyId);
  const next = Math.max(0, wallet.balance + Math.floor(amount));
  stmt.updateWalletBalance.run(next, guildId, userId, currencyId);
  db.prepare('INSERT INTO transactions (guild_id, user_id, currency_id, type, delta, balance_after, details) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(guildId, userId, currencyId, type, Math.floor(amount), next, details);
  return next;
}

function addBank(guildId, userId, amount, currencyId, type = 'bank_adjust', details = '') {
  const wallet = getWallet(guildId, userId, currencyId);
  const next = Math.max(0, wallet.bank + Math.floor(amount));
  stmt.updateWalletBank.run(next, guildId, userId, currencyId);
  db.prepare('INSERT INTO transactions (guild_id, user_id, currency_id, type, delta, balance_after, details) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(guildId, userId, currencyId, type, Math.floor(amount), next, details);
  return next;
}

function logAudit(guildId, actorId, action, targetId, details) {
  db.prepare('INSERT INTO audit_logs (guild_id, actor_id, action, target_id, details) VALUES (?, ?, ?, ?, ?)')
    .run(guildId, actorId || null, action, targetId || null, details || '');
}

function isAdmin(interaction) {
  if (!interaction.guild) return false;
  if (interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) return true;
  const memberRoles = interaction.member?.roles?.cache;
  if (!memberRoles) return false;
  for (const roleId of ADMIN_ROLE_IDS) {
    if (memberRoles.has(roleId)) return true;
  }
  return false;
}

function getStatObject(user) {
  return user.stats || {};
}

function incrementStat(guildId, userId, key, amount = 1) {
  const user = getUser(guildId, userId);
  const stats = { ...getStatObject(user) };
  stats[key] = (stats[key] || 0) + amount;
  db.prepare('UPDATE users SET stats_json = ? WHERE guild_id = ? AND user_id = ?')
    .run(JSON.stringify(stats), guildId, userId);
}

function unlockAchievement(guildId, userId, id) {
  const user = getUser(guildId, userId);
  if (user.achievements.includes(id)) return false;
  const achievements = [...user.achievements, id];
  db.prepare('UPDATE users SET achievements_json = ? WHERE guild_id = ? AND user_id = ?')
    .run(JSON.stringify(achievements), guildId, userId);
  return true;
}

function addXp(guildId, userId, xp) {
  const user = getUser(guildId, userId);
  const nextXp = user.xp + xp;
  let level = user.level;
  let threshold = level * level * 100;
  let localXp = nextXp;
  while (localXp >= threshold) {
    localXp -= threshold;
    level += 1;
    threshold = level * level * 100;
  }
  db.prepare('UPDATE users SET xp = ?, level = ? WHERE guild_id = ? AND user_id = ?')
    .run(localXp, level, guildId, userId);
  return { xp: localXp, level };
}

function allCurrencies(guildId) {
  return db.prepare('SELECT * FROM currencies WHERE guild_id = ? AND enabled = 1 ORDER BY currency_id').all(guildId);
}

function setCooldown(interaction, key, ms) {
  const userId = interaction.user.id;
  const guildId = interaction.guildId || 'dm';
  const mapKey = `${guildId}:${userId}:${key}`;
  client.cooldowns.set(mapKey, Date.now() + ms);
}

function getCooldownRemaining(interaction, key) {
  const userId = interaction.user.id;
  const guildId = interaction.guildId || 'dm';
  const mapKey = `${guildId}:${userId}:${key}`;
  const until = client.cooldowns.get(mapKey) || 0;
  return Math.max(0, until - Date.now());
}

function formatRemaining(ms) {
  const s = Math.ceil(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m <= 0) return `${r}s`;
  return `${m}m ${r}s`;
}

function baseEmbed(title, description, color = Colors.Blurple) {
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(color)
    .setTimestamp();
}

function moneyStr(amount, currency) {
  const sym = currency?.symbol || '🪙';
  return `${sym}${formatNumber(amount)}`;
}

function userTag(user) {
  return `<@${user.id}>`;
}

async function replySafe(interaction, payload) {
  if (interaction.deferred || interaction.replied) return interaction.editReply(payload);
  return interaction.reply(payload);
}

function truncate(text, max = 1800) {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '…';
}

async function animateWithImages(interaction, imageFrames, embed, delay = 900) {
  const first = new AttachmentBuilder(imageFrames[0], { name: 'frame0.png' });
  const payload = { embeds: [embed], files: [first], fetchReply: true };
  
  await replySafe(interaction, payload);
  const message = await interaction.fetchReply();
  
  for (let i = 1; i < imageFrames.length; i++) {
    await sleep(delay);
    const buffer = imageFrames[i];
    const attachment = new AttachmentBuilder(buffer, { name: `frame${i}.png` });
    await message.edit({ files: [attachment] });
  }
  return message;
}

async function animate(interaction, frames, build, delay = 900, options = {}) {
  const first = build(frames[0], 0, frames.length);
  await replySafe(interaction, { ...first, fetchReply: true, ...options });
  const message = await interaction.fetchReply();
  for (let i = 1; i < frames.length; i++) {
    await sleep(delay);
    const next = build(frames[i], i, frames.length);
    await message.edit(next);
  }
  return message;
}

async function pushLog(guild, payload) {
  if (!LOG_CHANNEL_ID) return;
  const ch = guild.channels.cache.get(LOG_CHANNEL_ID) || await guild.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
  if (!ch || !ch.isTextBased()) return;
  ch.send(payload).catch(() => null);
}

function registerStatTrigger(guildId, userId, kind, amount = 1) {
  incrementStat(guildId, userId, kind, amount);
  const user = getUser(guildId, userId);
  if (kind === 'wins' && user.stats.wins >= 10) unlockAchievement(guildId, userId, 'first_10_wins');
  if (kind === 'bet_total' && (user.stats.bet_total || 0) >= 100000) unlockAchievement(guildId, userId, 'high_roller');
}

function getForcedResult(guildId, userId, gameId) {
  const row = db.prepare('SELECT * FROM forced_results WHERE guild_id = ? AND user_id = ? AND game_id = ?').get(guildId, userId, gameId);
  if (!row) return null;
  if (row.expires_at <= now()) {
    db.prepare('DELETE FROM forced_results WHERE guild_id = ? AND user_id = ? AND game_id = ?').run(guildId, userId, gameId);
    return null;
  }
  return safeJsonParse(row.result_json, null);
}

function setForcedResult(guildId, userId, gameId, result, ttlSeconds = 300) {
  db.prepare(`INSERT INTO forced_results (guild_id, user_id, game_id, result_json, expires_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, user_id, game_id) DO UPDATE SET result_json=excluded.result_json, expires_at=excluded.expires_at`)
    .run(guildId, userId, gameId, JSON.stringify(result), now() + ttlSeconds);
}

function clearForcedResult(guildId, userId, gameId) {
  db.prepare('DELETE FROM forced_results WHERE guild_id = ? AND user_id = ? AND game_id = ?').run(guildId, userId, gameId);
}

function economyMultiplier(guildId) {
  return getGuildSettings(guildId).payout_multiplier || 1;
}

function houseEdge(guildId) {
  return getGuildSettings(guildId).house_edge || 0;
}

// ------------------------------
// Enhanced Game definitions
// ------------------------------
async function runWagerGame(interaction, opts) {
  const { gameId, title, bet, minBet = 1, maxBet = 1000000, winChance = 0.5, multiplier = 2, description = '', winLabel = 'You won', loseLabel = 'You lost', cashEmoji = '🪙', extra = {}, animationMs = 650, imageGenerator = null } = opts;
  const guildId = interaction.guildId;
  const userId = interaction.user.id;
  const user = ensureUser(guildId, userId);
  const currency = getCurrency(guildId, getGuildSettings(guildId).currency_id);
  const wallet = getWallet(guildId, userId, currency.currency_id);
  
  if (!Number.isFinite(bet) || bet < minBet) {
    return interaction.reply({ ephemeral: true, content: `# Invalid bet\nBet must be at least ${moneyStr(minBet, currency)}.` });
  }
  if (bet > maxBet) {
    return interaction.reply({ ephemeral: true, content: `# Bet too high\nMaximum bet is ${moneyStr(maxBet, currency)}.` });
  }
  if (wallet.balance < bet) {
    return interaction.reply({ ephemeral: true, content: `# No funds\nYou only have ${moneyStr(wallet.balance, currency)}.` });
  }

  incrementStat(guildId, userId, 'games_played');
  incrementStat(guildId, userId, 'bet_total', bet);
  setCooldown(interaction, `game:${gameId}`, 1500);

  const settings = getGuildSettings(guildId);
  const forced = getForcedResult(guildId, userId, gameId);
  const win = forced ? Boolean(forced.win) : Math.random() < clamp(winChance * (1 - settings.house_edge), 0.01, 0.99);
  const payout = forced ? Math.max(0, Number(forced.payout ?? (win ? Math.floor(bet * multiplier * settings.payout_multiplier) : 0))) : (win ? Math.floor(bet * multiplier * settings.payout_multiplier) : 0);
  const net = payout - bet;
  const resultBalance = addBalance(guildId, userId, net, currency.currency_id, 'game', `${gameId}:${win ? 'win' : 'loss'}`);
  addXp(guildId, userId, win ? rand(20, 55) : rand(5, 20));
  registerStatTrigger(guildId, userId, win ? 'wins' : 'losses');
  if (win) incrementStat(guildId, userId, 'biggest_win', Math.max(payout, user.stats.biggest_win || 0));
  else incrementStat(guildId, userId, 'biggest_loss', Math.max(bet, user.stats.biggest_loss || 0));

  if (win) unlockAchievement(guildId, userId, 'first_win');

  const color = win ? Colors.Green : Colors.Red;
  const desc = [
    description,
    `Bet: ${moneyStr(bet, currency)}`,
    `Outcome: ${win ? bold('WIN') : bold('LOSS')}`,
    `Payout: ${moneyStr(payout, currency)}`,
    `Balance: ${moneyStr(resultBalance, currency)}`,
    extra.footer ? extra.footer : '',
  ].filter(Boolean).join('\n');

  const embed = baseEmbed(title, desc, color);
  if (extra.fields) embed.addFields(extra.fields);
  embed.setFooter({ text: `${cashEmoji} Fake economy only` });

  if (imageGenerator) {
    const imageFrames = imageGenerator();
    await animateWithImages(interaction, imageFrames, embed, animationMs);
  } else {
    await replySafe(interaction, { embeds: [embed], fetchReply: true });
  }
}

async function showCoinFlip(interaction, bet, guess) {
  const outcome = chance(0.5) ? 'heads' : 'tails';
  const forced = getForcedResult(interaction.guildId, interaction.user.id, 'coinflip');
  const finalOutcome = forced?.outcome || outcome;
  const win = finalOutcome === guess;
  
  await runWagerGame(interaction, {
    gameId: 'coinflip',
    title: 'Coin Flip',
    bet,
    winChance: 0.5,
    multiplier: 2,
    description: `You guessed **${guess}**. Final result: **${finalOutcome}**.`,
    animationMs: 500,
    extra: { footer: 'Heads or tails. A stunningly advanced financial instrument.' },
    imageGenerator: () => createCoinFlipAnimation(finalOutcome, guess, win),
  });
}

async function showDice(interaction, bet, target) {
  const roll = rand(1, 6);
  const win = roll === target;
  const mult = 5.5;
  
  await runWagerGame(interaction, {
    gameId: 'dice',
    title: 'Dice Roll',
    bet,
    winChance: 1 / 6,
    multiplier: mult,
    description: `You picked **${target}**. Rolled **${roll}**.`,
    animationMs: 600,
    imageGenerator: () => createDiceAnimation(roll, target, win),
  });
}

async function showHigherLower(interaction, bet, guess) {
  const first = rand(1, 13);
  const second = rand(1, 13);
  const outcome = second === first ? 'equal' : second > first ? 'higher' : 'lower';
  const win = guess === outcome;
  
  await runWagerGame(interaction, {
    gameId: 'higherlower',
    title: 'Higher or Lower',
    bet,
    winChance: 0.5,
    multiplier: 1.9,
    description: `First card: **${first}**. Second card: **${second}**. You guessed **${guess}**.`,
    animationMs: 450,
    imageGenerator: () => createHighLowAnimation(first, second, guess, win),
  });
}

async function showSlots(interaction, bet) {
  const symbols = ['🍒', '🍋', '🍇', '🍉', '7️⃣', '💎', '⭐'];
  const reels = [
    symbols[rand(0, symbols.length - 1)],
    symbols[rand(0, symbols.length - 1)],
    symbols[rand(0, symbols.length - 1)],
  ];
  const win = reels[0] === reels[1] && reels[1] === reels[2];
  const payout = win ? (reels[0] === '💎' ? bet * 20 : reels[0] === '7️⃣' ? bet * 15 : bet * 8) : 0;
  const currency = getCurrency(interaction.guildId, getGuildSettings(interaction.guildId).currency_id);
  
  if (getWallet(interaction.guildId, interaction.user.id, currency.currency_id).balance < bet) {
    return interaction.reply({ ephemeral: true, content: `# No funds\nYou need ${moneyStr(bet, currency)}.` });
  }
  
  const net = Math.floor(payout * economyMultiplier(interaction.guildId)) - bet;
  addBalance(interaction.guildId, interaction.user.id, net, currency.currency_id, 'game', `slots:${reels.join('')}`);
  registerStatTrigger(interaction.guildId, interaction.user.id, win ? 'wins' : 'losses');
  if (win) unlockAchievement(interaction.guildId, interaction.user.id, 'first_win');
  
  const color = win ? Colors.Green : Colors.Red;
  const embed = baseEmbed('🎰 Slots', 
    `Reels: **${reels.join(' | ')}**\n\nBet: ${moneyStr(bet, currency)}\nPayout: ${moneyStr(payout, currency)}\n${win ? '🎉 Triple match!' : 'No match. Try again.'}\nBalance: ${moneyStr(getWallet(interaction.guildId, interaction.user.id, currency.currency_id).balance, currency)}`,
    color);
  
  const imageFrames = createSlotAnimation(reels, win);
  await animateWithImages(interaction, imageFrames, embed, 350);
}

async function showCrash(interaction, bet) {
  const currency = getCurrency(interaction.guildId, getGuildSettings(interaction.guildId).currency_id);
  if (getWallet(interaction.guildId, interaction.user.id, currency.currency_id).balance < bet) {
    return interaction.reply({ ephemeral: true, content: `# No funds\nYou need ${moneyStr(bet, currency)}.` });
  }
  
  let balance = getWallet(interaction.guildId, interaction.user.id, currency.currency_id).balance;
  balance -= bet;
  setBalance(interaction.guildId, interaction.user.id, balance, currency.currency_id);
  
  const crashPoint = (Math.random() < 0.08 ? rand(11, 20) : Math.max(1.2, Math.random() * 8 + 1)).toFixed(2);
  const cashout = clamp(1 + Math.random() * 5, 1.1, 6).toFixed(2);
  const didSurvive = Number(cashout) < Number(crashPoint);
  const payout = didSurvive ? Math.floor(bet * Number(cashout) * economyMultiplier(interaction.guildId)) : 0;
  
  if (payout > 0) addBalance(interaction.guildId, interaction.user.id, payout, currency.currency_id, 'game', `crash:${cashout}`);
  registerStatTrigger(interaction.guildId, interaction.user.id, didSurvive ? 'wins' : 'losses');
  
  const color = didSurvive ? Colors.Green : Colors.Red;
  const embed = baseEmbed('📈 Crash', 
    `Cashout target: x${cashout}\nCrash at: x${crashPoint}\n\n${didSurvive ? '✅ Survived!' : '💥 Crashed!'}\nPayout: ${moneyStr(payout, currency)}\nBalance: ${moneyStr(getWallet(interaction.guildId, interaction.user.id, currency.currency_id).balance, currency)}`,
    color);
  
  const imageFrames = createCrashAnimation(Number(crashPoint), Number(cashout), didSurvive);
  await animateWithImages(interaction, imageFrames, embed, 550);
}

async function showWheel(interaction, bet) {
  const currency = getCurrency(interaction.guildId, getGuildSettings(interaction.guildId).currency_id);
  if (getWallet(interaction.guildId, interaction.user.id, currency.currency_id).balance < bet) {
    return interaction.reply({ ephemeral: true, content: `# No funds\nYou need ${moneyStr(bet, currency)}.` });
  }
  
  const slot = pickWeighted([
    { weight: 40, label: 'x0', payout: 0 },
    { weight: 25, label: 'x1', payout: bet },
    { weight: 20, label: 'x2', payout: bet * 2 },
    { weight: 10, label: 'x5', payout: bet * 5 },
    { weight: 4, label: 'x10', payout: bet * 10 },
    { weight: 1, label: 'jackpot', payout: bet * 30 },
  ]);
  
  const payout = Math.floor(slot.payout * economyMultiplier(interaction.guildId));
  const net = payout - bet;
  addBalance(interaction.guildId, interaction.user.id, net, currency.currency_id, 'game', `wheel:${slot.label}`);
  registerStatTrigger(interaction.guildId, interaction.user.id, payout > bet ? 'wins' : 'losses');
  
  const color = payout > bet ? Colors.Green : payout === bet ? Colors.Yellow : Colors.Red;
  const embed = baseEmbed('🎡 Wheel Spin', 
    `Result: **${slot.label}**\nBet: ${moneyStr(bet, currency)}\nPayout: ${moneyStr(payout, currency)}\nBalance: ${moneyStr(getWallet(interaction.guildId, interaction.user.id, currency.currency_id).balance, currency)}`,
    color);
  
  const imageFrames = createWheelAnimation(slot.label, 6);
  await animateWithImages(interaction, imageFrames, embed, 420);
}

async function showTreasure(interaction, bet) {
  const currency = getCurrency(interaction.guildId, getGuildSettings(interaction.guildId).currency_id);
  if (getWallet(interaction.guildId, interaction.user.id, currency.currency_id).balance < bet) {
    return interaction.reply({ ephemeral: true, content: `# No funds\nYou need ${moneyStr(bet, currency)}.` });
  }
  
  const spots = Array.from({ length: 9 }, () => Math.random() < 0.15 ? '💎' : '⬛');
  const treasureCount = spots.filter(x => x === '💎').length;
  const payout = Math.floor((treasureCount === 0 ? 0 : bet * (1 + treasureCount * 1.5)) * economyMultiplier(interaction.guildId));
  addBalance(interaction.guildId, interaction.user.id, payout - bet, currency.currency_id, 'game', 'treasure');
  registerStatTrigger(interaction.guildId, interaction.user.id, treasureCount > 0 ? 'wins' : 'losses');
  
  const color = payout > bet ? Colors.Green : Colors.Red;
  const embed = baseEmbed('🎯 Treasure Hunt', 
    `Treasures found: **${treasureCount}**\nPayout: ${moneyStr(payout, currency)}\nBalance: ${moneyStr(getWallet(interaction.guildId, interaction.user.id, currency.currency_id).balance, currency)}`,
    color);
  
  const imageFrames = createTreasureAnimation(spots, treasureCount, payout > bet);
  await animateWithImages(interaction, imageFrames, embed, 500);
}

async function showRPS(interaction, bet, guess) {
  const map = ['rock', 'paper', 'scissors'];
  const bot = map[rand(0, 2)];
  const result = guess === bot ? 'push' : (guess === 'rock' && bot === 'scissors') || (guess === 'paper' && bot === 'rock') || (guess === 'scissors' && bot === 'paper') ? 'win' : 'lose';
  const payout = result === 'win' ? Math.floor(bet * 2 * economyMultiplier(interaction.guildId)) : result === 'push' ? bet : 0;
  const currency = getCurrency(interaction.guildId, getGuildSettings(interaction.guildId).currency_id);
  
  if (getWallet(interaction.guildId, interaction.user.id, currency.currency_id).balance < bet) {
    return interaction.reply({ ephemeral: true, content: `# No funds\nYou need ${moneyStr(bet, currency)}.` });
  }
  
  const net = payout - bet;
  addBalance(interaction.guildId, interaction.user.id, net, currency.currency_id, 'game', `rps:${result}`);
  registerStatTrigger(interaction.guildId, interaction.user.id, result === 'win' ? 'wins' : 'losses');
  
  const rpsEmojis = { rock: '✊', paper: '✋', scissors: '✌️' };
  const color = result === 'win' ? Colors.Green : result === 'push' ? Colors.Yellow : Colors.Red;
  const embed = baseEmbed('✊ Rock Paper Scissors', 
    `You: **${guess.toUpperCase()}** ${rpsEmojis[guess]}\nBot: **${bot.toUpperCase()}** ${rpsEmojis[bot]}\nResult: **${result.toUpperCase()}**\nBalance: ${moneyStr(getWallet(interaction.guildId, interaction.user.id, currency.currency_id).balance, currency)}`,
    color);
  
  await replySafe(interaction, { embeds: [embed] });
}

async function showLimbo(interaction, bet, target) {
  const roll = Math.random() * 10;
  const win = roll > target;
  const mult = Math.max(1.2, 10 / Math.max(1.01, target));
  
  await runWagerGame(interaction, {
    gameId: 'limbo',
    title: '🧍 Limbo',
    bet,
    winChance: clamp(1 - (target / 10), 0.05, 0.95),
    multiplier: mult,
    description: `Target is **${target.toFixed(2)}**. Rolled **${roll.toFixed(2)}**.`,
    animationMs: 350,
  });
}

async function showLuckNumber(interaction, bet, number) {
  const roll = rand(1, 100);
  const win = roll === number;
  
  await runWagerGame(interaction, {
    gameId: 'luckynumber',
    title: '🔢 Lucky Number',
    bet,
    winChance: 1 / 100,
    multiplier: 95,
    description: `You chose **${number}**. Rolled **${roll}**.`,
    animationMs: 400,
  });
}

async function showScratch(interaction, bet) {
  const currency = getCurrency(interaction.guildId, getGuildSettings(interaction.guildId).currency_id);
  if (getWallet(interaction.guildId, interaction.user.id, currency.currency_id).balance < bet) {
    return interaction.reply({ ephemeral: true, content: `# No funds\nYou need ${moneyStr(bet, currency)}.` });
  }
  
  const prize = pickWeighted([
    { weight: 50, value: 0 },
    { weight: 25, value: bet },
    { weight: 15, value: bet * 2 },
    { weight: 7, value: bet * 5 },
    { weight: 2, value: bet * 15 },
    { weight: 1, value: bet * 50 },
  ]);
  
  const payout = Math.floor(prize.value * economyMultiplier(interaction.guildId));
  addBalance(interaction.guildId, interaction.user.id, payout - bet, currency.currency_id, 'game', 'scratch');
  registerStatTrigger(interaction.guildId, interaction.user.id, payout > bet ? 'wins' : 'losses');
  
  const color = payout > bet ? Colors.Green : payout === bet ? Colors.Yellow : Colors.Red;
  const embed = baseEmbed('🎫 Scratch Cards', 
    `Prize: ${moneyStr(payout, currency)}\nBalance: ${moneyStr(getWallet(interaction.guildId, interaction.user.id, currency.currency_id).balance, currency)}`,
    color);
  
  await replySafe(interaction, { embeds: [embed] });
}

async function showLottery(interaction, bet) {
  const currency = getCurrency(interaction.guildId, getGuildSettings(interaction.guildId).currency_id);
  if (getWallet(interaction.guildId, interaction.user.id, currency.currency_id).balance < bet) {
    return interaction.reply({ ephemeral: true, content: `# No funds\nYou need ${moneyStr(bet, currency)}.` });
  }
  
  const tickets = Array.from({ length: 6 }, () => rand(1, 49));
  const draw = Array.from({ length: 6 }, () => rand(1, 49));
  const matches = tickets.filter(n => draw.includes(n)).length;
  const payout = Math.floor((matches === 0 ? 0 : bet * [0, 0.5, 1, 3, 10, 50, 200][matches]) * economyMultiplier(interaction.guildId));
  addBalance(interaction.guildId, interaction.user.id, payout - bet, currency.currency_id, 'game', 'lottery');
  registerStatTrigger(interaction.guildId, interaction.user.id, matches >= 3 ? 'wins' : 'losses');
  
  const color = payout > bet ? Colors.Green : Colors.Red;
  const embed = baseEmbed('🎟️ Lottery Draw', 
    `Your ticket: **${tickets.join(' - ')}**\nDraw: **${draw.join(' - ')}**\nMatches: **${matches}**\nPayout: ${moneyStr(payout, currency)}\nBalance: ${moneyStr(getWallet(interaction.guildId, interaction.user.id, currency.currency_id).balance, currency)}`,
    color);
  
  await replySafe(interaction, { embeds: [embed] });
}

// ------------------------------
// Event handling
// ------------------------------
client.once(Events.ClientReady, () => {
  console.log(`✓ Bot ready as ${client.user?.tag}`);
  console.log(`✓ Commands will be registered on first interaction`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isCommand()) return;
  
  // Register commands on demand
  const commands = await buildCommands();
  const cmd = commands.find(c => c.name === interaction.commandName);
  
  if (!cmd) return;
  
  try {
    await cmd.execute(interaction);
  } catch (err) {
    console.error(`✗ Command error:`, err);
    const payload = { content: '❌ An error occurred', ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      await interaction.editReply(payload).catch(() => null);
    } else {
      await interaction.reply(payload).catch(() => null);
    }
  }
});

// Defer all interactions immediately
client.on(Events.InteractionCreate, async (interaction) => {
  if ((interaction.isCommand() || interaction.isModalSubmit()) && !interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ ephemeral: false }).catch(() => null);
  }
});

// Register commands once client is ready
client.on(Events.ClientReady, async () => {
  if (!TOKEN || !CLIENT_ID) return;
  const commands = await buildCommands();
  const rest = new (require('discord.js').REST)({ version: '10' }).setToken(TOKEN);
  
  try {
    if (GUILD_ID) {
      await rest.put(`/applications/${CLIENT_ID}/guilds/${GUILD_ID}/commands`, { body: commands.map(c => c.data.toJSON()) });
      console.log(`✓ Registered ${commands.length} commands to guild`);
    } else {
      await rest.put(`/applications/${CLIENT_ID}/commands`, { body: commands.map(c => c.data.toJSON()) });
      console.log(`✓ Registered ${commands.length} global commands`);
    }
  } catch (err) {
    console.error('✗ Command registration error:', err.message);
  }
});

async function buildCommands() {
  return [
    // Betting games
    {
      data: new SlashCommandBuilder()
        .setName('flip')
        .setDescription('Play coin flip')
        .addIntegerOption(opt => opt.setName('bet').setDescription('Bet amount').setRequired(true).setMinValue(1))
        .addStringOption(opt => opt.setName('guess').setDescription('heads or tails').setRequired(true).addChoices({ name: 'heads', value: 'heads' }, { name: 'tails', value: 'tails' })),
      execute: async (i) => {
        const bet = i.options.getInteger('bet');
        const guess = i.options.getString('guess');
        await showCoinFlip(i, bet, guess);
      },
    },
    {
      data: new SlashCommandBuilder()
        .setName('dice')
        .setDescription('Roll the dice')
        .addIntegerOption(opt => opt.setName('bet').setDescription('Bet amount').setRequired(true).setMinValue(1))
        .addIntegerOption(opt => opt.setName('target').setDescription('1-6').setRequired(true).setMinValue(1).setMaxValue(6)),
      execute: async (i) => {
        const bet = i.options.getInteger('bet');
        const target = i.options.getInteger('target');
        await showDice(i, bet, target);
      },
    },
    {
      data: new SlashCommandBuilder()
        .setName('slots')
        .setDescription('Spin the slots')
        .addIntegerOption(opt => opt.setName('bet').setDescription('Bet amount').setRequired(true).setMinValue(1)),
      execute: async (i) => {
        const bet = i.options.getInteger('bet');
        await showSlots(i, bet);
      },
    },
    {
      data: new SlashCommandBuilder()
        .setName('crash')
        .setDescription('Play crash')
        .addIntegerOption(opt => opt.setName('bet').setDescription('Bet amount').setRequired(true).setMinValue(1)),
      execute: async (i) => {
        const bet = i.options.getInteger('bet');
        await showCrash(i, bet);
      },
    },
    {
      data: new SlashCommandBuilder()
        .setName('wheel')
        .setDescription('Spin the wheel')
        .addIntegerOption(opt => opt.setName('bet').setDescription('Bet amount').setRequired(true).setMinValue(1)),
      execute: async (i) => {
        const bet = i.options.getInteger('bet');
        await showWheel(i, bet);
      },
    },
    {
      data: new SlashCommandBuilder()
        .setName('treasure')
        .setDescription('Hunt for treasure')
        .addIntegerOption(opt => opt.setName('bet').setDescription('Bet amount').setRequired(true).setMinValue(1)),
      execute: async (i) => {
        const bet = i.options.getInteger('bet');
        await showTreasure(i, bet);
      },
    },
    {
      data: new SlashCommandBuilder()
        .setName('higher')
        .setDescription('Higher or Lower card game')
        .addIntegerOption(opt => opt.setName('bet').setDescription('Bet amount').setRequired(true).setMinValue(1))
        .addStringOption(opt => opt.setName('guess').setDescription('higher, lower, or equal').setRequired(true).addChoices({ name: 'higher', value: 'higher' }, { name: 'lower', value: 'lower' }, { name: 'equal', value: 'equal' })),
      execute: async (i) => {
        const bet = i.options.getInteger('bet');
        const guess = i.options.getString('guess');
        await showHigherLower(i, bet, guess);
      },
    },
    {
      data: new SlashCommandBuilder()
        .setName('rps')
        .setDescription('Rock Paper Scissors')
        .addIntegerOption(opt => opt.setName('bet').setDescription('Bet amount').setRequired(true).setMinValue(1))
        .addStringOption(opt => opt.setName('choice').setDescription('rock, paper, or scissors').setRequired(true).addChoices({ name: 'rock', value: 'rock' }, { name: 'paper', value: 'paper' }, { name: 'scissors', value: 'scissors' })),
      execute: async (i) => {
        const bet = i.options.getInteger('bet');
        const choice = i.options.getString('choice');
        await showRPS(i, bet, choice);
      },
    },
    {
      data: new SlashCommandBuilder()
        .setName('limbo')
        .setDescription('Limbo game')
        .addIntegerOption(opt => opt.setName('bet').setDescription('Bet amount').setRequired(true).setMinValue(1))
        .addNumberOption(opt => opt.setName('target').setDescription('Target multiplier (0-10)').setRequired(true).setMinValue(0.01).setMaxValue(10)),
      execute: async (i) => {
        const bet = i.options.getInteger('bet');
        const target = i.options.getNumber('target');
        await showLimbo(i, bet, target);
      },
    },
    {
      data: new SlashCommandBuilder()
        .setName('lucky')
        .setDescription('Lucky Number game')
        .addIntegerOption(opt => opt.setName('bet').setDescription('Bet amount').setRequired(true).setMinValue(1))
        .addIntegerOption(opt => opt.setName('number').setDescription('1-100').setRequired(true).setMinValue(1).setMaxValue(100)),
      execute: async (i) => {
        const bet = i.options.getInteger('bet');
        const number = i.options.getInteger('number');
        await showLuckNumber(i, bet, number);
      },
    },
    {
      data: new SlashCommandBuilder()
        .setName('scratch')
        .setDescription('Scratch cards')
        .addIntegerOption(opt => opt.setName('bet').setDescription('Bet amount').setRequired(true).setMinValue(1)),
      execute: async (i) => {
        const bet = i.options.getInteger('bet');
        await showScratch(i, bet);
      },
    },
    {
      data: new SlashCommandBuilder()
        .setName('lottery')
        .setDescription('Lottery draw')
        .addIntegerOption(opt => opt.setName('bet').setDescription('Bet amount').setRequired(true).setMinValue(1)),
      execute: async (i) => {
        const bet = i.options.getInteger('bet');
        await showLottery(i, bet);
      },
    },
    // User commands
    {
      data: new SlashCommandBuilder()
        .setName('balance')
        .setDescription('Check your balance')
        .addUserOption(opt => opt.setName('user').setDescription('User to check')),
      execute: async (i) => {
        const target = i.options.getUser('user') || i.user;
        const guildId = i.guildId;
        const user = getUser(guildId, target.id);
        const wallet = user.wallet;
        const e = baseEmbed('💰 Balance', 
          `${userTag(target)}\n**Balance:** ${moneyStr(wallet.balance, user.wallet.currency || getCurrency(guildId, getGuildSettings(guildId).currency_id))}\n**Bank:** ${moneyStr(wallet.bank, user.wallet.currency || getCurrency(guildId, getGuildSettings(guildId).currency_id))}\n**Level:** ${user.level}\n**XP:** ${user.xp}`,
          Colors.Gold);
        await i.editReply({ embeds: [e] });
      },
    },
    {
      data: new SlashCommandBuilder()
        .setName('stats')
        .setDescription('View your stats')
        .addUserOption(opt => opt.setName('user').setDescription('User to check')),
      execute: async (i) => {
        const target = i.options.getUser('user') || i.user;
        const guildId = i.guildId;
        const user = getUser(guildId, target.id);
        const stats = user.stats;
        const fields = [
          { name: 'Games Played', value: String(stats.games_played || 0), inline: true },
          { name: 'Wins', value: String(stats.wins || 0), inline: true },
          { name: 'Losses', value: String(stats.losses || 0), inline: true },
          { name: 'Total Bet', value: moneyStr(stats.bet_total || 0, user.wallet.currency || getCurrency(guildId, getGuildSettings(guildId).currency_id)), inline: true },
          { name: 'Biggest Win', value: moneyStr(stats.biggest_win || 0, user.wallet.currency || getCurrency(guildId, getGuildSettings(guildId).currency_id)), inline: true },
          { name: 'Biggest Loss', value: moneyStr(stats.biggest_loss || 0, user.wallet.currency || getCurrency(guildId, getGuildSettings(guildId).currency_id)), inline: true },
        ];
        const e = baseEmbed('📊 Stats', `${userTag(target)}`).addFields(fields);
        await i.editReply({ embeds: [e] });
      },
    },
    {
      data: new SlashCommandBuilder()
        .setName('leaderboard')
        .setDescription('View the leaderboard'),
      execute: async (i) => {
        const guildId = i.guildId;
        const rows = db.prepare(`
          SELECT user_id, stats_json, xp, level FROM users WHERE guild_id = ? ORDER BY json_extract(stats_json, '$.bet_total') DESC LIMIT 10
        `).all(guildId);
        
        const lines = rows.map((row, idx) => {
          const stats = safeJsonParse(row.stats_json || '{}', {});
          return `${idx + 1}. <@${row.user_id}> - ${formatNumber(stats.bet_total || 0)} total bet`;
        });
        
        const e = baseEmbed('🏆 Leaderboard', lines.join('\n') || 'No data');
        await i.editReply({ embeds: [e] });
      },
    },
    // Admin commands
    {
      data: new SlashCommandBuilder()
        .setName('admin_give')
        .setDescription('Give currency to a user')
        .addUserOption(opt => opt.setName('user').setDescription('User to give to').setRequired(true))
        .addIntegerOption(opt => opt.setName('amount').setDescription('Amount').setRequired(true)),
      execute: async (i) => {
        if (!isAdmin(i)) return i.editReply({ content: '❌ Not an admin', ephemeral: true });
        const target = i.options.getUser('user');
        const amount = i.options.getInteger('amount');
        const guildId = i.guildId;
        const currency = getCurrency(guildId, getGuildSettings(guildId).currency_id);
        addBalance(guildId, target.id, amount, currency.currency_id, 'admin_give', `Given by ${i.user.tag}`);
        logAudit(guildId, i.user.id, 'admin_give', target.id, `Gave ${amount}`);
        const e = baseEmbed('✅ Sent', `Gave ${moneyStr(amount, currency)} to ${userTag(target)}`);
        await i.editReply({ embeds: [e] });
      },
    },
    {
      data: new SlashCommandBuilder()
        .setName('admin_remove')
        .setDescription('Remove currency from a user')
        .addUserOption(opt => opt.setName('user').setDescription('User to remove from').setRequired(true))
        .addIntegerOption(opt => opt.setName('amount').setDescription('Amount').setRequired(true)),
      execute: async (i) => {
        if (!isAdmin(i)) return i.editReply({ content: '❌ Not an admin', ephemeral: true });
        const target = i.options.getUser('user');
        const amount = i.options.getInteger('amount');
        const guildId = i.guildId;
        const currency = getCurrency(guildId, getGuildSettings(guildId).currency_id);
        addBalance(guildId, target.id, -amount, currency.currency_id, 'admin_remove', `Removed by ${i.user.tag}`);
        logAudit(guildId, i.user.id, 'admin_remove', target.id, `Removed ${amount}`);
        const e = baseEmbed('✅ Removed', `Removed ${moneyStr(amount, currency)} from ${userTag(target)}`);
        await i.editReply({ embeds: [e] });
      },
    },
    {
      data: new SlashCommandBuilder()
        .setName('admin_set')
        .setDescription('Set a user\'s balance')
        .addUserOption(opt => opt.setName('user').setDescription('User').setRequired(true))
        .addIntegerOption(opt => opt.setName('amount').setDescription('New balance').setRequired(true)),
      execute: async (i) => {
        if (!isAdmin(i)) return i.editReply({ content: '❌ Not an admin', ephemeral: true });
        const target = i.options.getUser('user');
        const amount = i.options.getInteger('amount');
        const guildId = i.guildId;
        const currency = getCurrency(guildId, getGuildSettings(guildId).currency_id);
        setBalance(guildId, target.id, amount, currency.currency_id);
        logAudit(guildId, i.user.id, 'admin_set', target.id, `Set balance to ${amount}`);
        const e = baseEmbed('✅ Set', `Set balance to ${moneyStr(amount, currency)} for ${userTag(target)}`);
        await i.editReply({ embeds: [e] });
      },
    },
    {
      data: new SlashCommandBuilder()
        .setName('admin_settings')
        .setDescription('View or modify server settings')
        .addSubcommand(sub => sub.setName('view').setDescription('View current settings'))
        .addSubcommand(sub => sub.setName('houseedge').setDescription('Set house edge').addNumberOption(opt => opt.setName('value').setRequired(true).setMinValue(0).setMaxValue(1)))
        .addSubcommand(sub => sub.setName('multiplier').setDescription('Set payout multiplier').addNumberOption(opt => opt.setName('value').setRequired(true).setMinValue(0.1).setMaxValue(10))),
      execute: async (i) => {
        if (!isAdmin(i)) return i.editReply({ content: '❌ Not an admin', ephemeral: true });
        const guildId = i.guildId;
        const sub = i.options.getSubcommand();
        
        if (sub === 'view') {
          const settings = getGuildSettings(guildId);
          const e = baseEmbed('⚙️ Server Settings',
            `**Economy Name:** ${settings.economy_name}\n**House Edge:** ${(settings.house_edge * 100).toFixed(1)}%\n**Payout Multiplier:** ${settings.payout_multiplier}x`);
          return i.editReply({ embeds: [e] });
        }
        
        if (sub === 'houseedge') {
          const value = i.options.getNumber('value');
          stmt.setGuild.run({ guild_id: guildId, economy_name: getGuildSettings(guildId).economy_name, currency_id: getGuildSettings(guildId).currency_id, house_edge: value, payout_multiplier: getGuildSettings(guildId).payout_multiplier, locale: 'en' });
          logAudit(guildId, i.user.id, 'set_house_edge', null, `${value}`);
          return i.editReply({ content: `✅ House edge set to ${(value * 100).toFixed(1)}%` });
        }
        
        if (sub === 'multiplier') {
          const value = i.options.getNumber('value');
          stmt.setGuild.run({ guild_id: guildId, economy_name: getGuildSettings(guildId).economy_name, currency_id: getGuildSettings(guildId).currency_id, house_edge: getGuildSettings(guildId).house_edge, payout_multiplier: value, locale: 'en' });
          logAudit(guildId, i.user.id, 'set_multiplier', null, `${value}`);
          return i.editReply({ content: `✅ Payout multiplier set to ${value}x` });
        }
      },
    },
  ];
}

// Login
client.login(TOKEN).catch(err => {
  console.error('✗ Login failed:', err.message);
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  console.error('✗ Unhandled rejection:', err);
});

process.on('uncaughtException', (err) => {
  console.error('✗ Uncaught exception:', err);
  process.exit(1);
});

// [Pterodactyl Daemon]: Checking server disk space usage, this could take a few seconds...
// [Pterodactyl Daemon]: Updating process configuration files...
// [Pterodactyl Daemon]: Ensuring file permissions are set correctly, this could take a few seconds...
// container@pterodactyl~ Server marked as starting...
// [Pterodactyl Daemon]: Pulling Docker container image, this could take a few minutes to complete...
// Pulling from ptero-eggs/yolks 
// Digest: sha256:c0bea1e94ab769f23d78958a47f8666d76430835f281db23c0b360a7a28ff27a 
// Status: Image is up to date for ghcr.io/ptero-eggs/yolks:nodejs_22 
// [Pterodactyl Daemon]: Finished pulling Docker container image
// Node.js Version: v22.22.3
// :/home/container$ if [[ -d .git ]] && [[ ${AUTO_UPDATE} == "1" ]]; then git pull; fi; if [[ ! -z ${NODE_PACKAGES} ]]; then /usr/local/bin/npm install ${NODE_PACKAGES}; fi; if [[ ! -z ${UNNODE_PACKAGES} ]]; then /usr/local/bin/npm uninstall ${UNNODE_PACKAGES}; fi; if [ -f /home/container/package.json ]; then /usr/local/bin/npm install; fi; if [[ "${MAIN_FILE}" == bot.js ]]; then /usr/local/bin/node "/home/container/${MAIN_FILE}" ${NODE_ARGS}; else /usr/local/bin/npx ts-node --esm "/home/container/${MAIN_FILE}" ${NODE_ARGS}; fi
// 
// up to date, audited 89 packages in 755ms
// 
// 19 packages are looking for funding
//   run `npm fund` for details
// 
// found 0 vulnerabilities
// npm warn allow-scripts 3 packages have install scripts not yet covered by allowScripts:
// npm warn allow-scripts   better-sqlite3@12.10.0 (install: node-gyp rebuild)
// npm warn allow-scripts   canvas@3.2.3 (install: node-gyp rebuild)
// npm warn allow-scripts   sqlite3@6.0.1 (install: node-gyp rebuild)
// npm warn allow-scripts
// npm warn allow-scripts Run `npm approve-scripts --allow-scripts-pending` to review, or `npm approve-scripts <pkg>` to allow.
// ✗ Database connection failed: The module '/home/container/node_modules/better-sqlite3/build/Release/better_sqlite3.node'
// was compiled against a different Node.js version using
// NODE_MODULE_VERSION 115. This version of Node.js requires
// NODE_MODULE_VERSION 127. Please try re-compiling or re-installing
// the module (for instance, using `npm rebuild` or `npm install`).
// Attempting to repair database...
// ✗ Failed to repair database: Module did not self-register: '/home/container/node_modules/better-sqlite3/build/Release/better_sqlite3.node'.
// container@pterodactyl~ Server marked as offline...
// [Pterodactyl Daemon]: ---------- Detected server process in a crashed state! ----------
// [Pterodactyl Daemon]: Exit code: 1
// [Pterodactyl Daemon]: Out of memory: false
// [Pterodactyl Daemon]: Aborting automatic restart, last crash occurred less than 60 seconds ago.
// 
// FIX THIS BROOOOOOO, make it actually good bro, and make the games more interactive and satesfying to play.
// 
