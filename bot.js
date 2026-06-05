// Fake Virtual Economy Gambling Bot
// Single-file Discord.js bot with SQLite persistence, slash commands only,
// rich interactions, animated message updates, animated images, and admin economy controls.
//
// No manual install needed – the bot auto-installs and auto-rebuilds everything.
// Just create discord.env next to this file:
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
const { execSync } = require('child_process');

// ------------------------------------
// Auto-install & auto-rebuild system
// ------------------------------------
const REQUIRED_PACKAGES = ['discord.js', 'better-sqlite3', 'canvas'];

function ensurePackageJson() {
  const pkgPath = path.join(__dirname, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    console.log('⚙ Creating package.json...');
    fs.writeFileSync(pkgPath, JSON.stringify({
      name: 'economy-bot',
      version: '1.0.0',
      private: true,
      description: 'Discord economy casino bot',
    }, null, 2));
  }
}

function installMissing() {
  const missing = REQUIRED_PACKAGES.filter(pkg => {
    try { require.resolve(pkg); return false; } catch { return true; }
  });
  if (missing.length > 0) {
    ensurePackageJson();
    console.log(`⚙ Installing missing packages: ${missing.join(', ')}...`);
    try {
      execSync(`npm install ${missing.join(' ')} --save 2>&1`, {
        stdio: 'inherit',
        timeout: 300000,
        cwd: __dirname,
      });
      console.log('✓ Packages installed successfully');
    } catch (err) {
      console.error('✗ Package installation failed:', err.message);
      process.exit(1);
    }
  }
}

function loadWithAutoRebuild(moduleName) {
  try {
    return require(moduleName);
  } catch (loadErr) {
    if (loadErr.message.includes('NODE_MODULE_VERSION') || loadErr.message.includes('not self-register')) {
      console.log(`⚙ Rebuilding ${moduleName} for current Node.js version...`);
      try {
        execSync(`npm rebuild ${moduleName} --update-binary 2>&1`, {
          stdio: 'inherit',
          timeout: 120000,
          cwd: __dirname,
        });
        console.log(`✓ ${moduleName} rebuilt successfully`);
        return require(moduleName);
      } catch (rebuildErr) {
        console.error(`✗ Rebuild of ${moduleName} failed:`, rebuildErr.message);
        process.exit(1);
      }
    }
    throw loadErr;
  }
}

// Run auto-install then load modules
installMissing();
const Database = loadWithAutoRebuild('better-sqlite3');
const { createCanvas } = loadWithAutoRebuild('canvas');
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
// Canvas helpers
// ------------------------------
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawGradientBg(ctx, w, h, colorTop, colorBot) {
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, colorTop);
  grad.addColorStop(1, colorBot);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
}

function drawCard(ctx, x, y, value, suit, faceDown = false) {
  const cw = 65, ch = 90, r = 8;
  roundRect(ctx, x, y, cw, ch, r);
  if (faceDown) {
    ctx.fillStyle = '#1a5276';
    ctx.fill();
    ctx.strokeStyle = '#2980b9';
    ctx.lineWidth = 2;
    ctx.stroke();
    // Pattern
    ctx.fillStyle = '#2471a3';
    for (let py = y + 8; py < y + ch - 8; py += 6) {
      for (let px = x + 8; px < x + cw - 8; px += 6) {
        ctx.fillRect(px, py, 3, 3);
      }
    }
    return;
  }
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.strokeStyle = '#bdc3c7';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  const isRed = suit === '♥' || suit === '♦';
  ctx.fillStyle = isRed ? '#e74c3c' : '#2c3e50';
  ctx.font = 'bold 16px Arial';
  ctx.textAlign = 'left';
  ctx.fillText(value, x + 5, y + 18);
  ctx.fillText(suit, x + 5, y + 34);
  ctx.font = 'bold 28px Arial';
  ctx.textAlign = 'center';
  ctx.fillText(suit, x + cw / 2, y + ch / 2 + 10);
}

const CARD_VALUES = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const CARD_SUITS = ['♠', '♥', '♦', '♣'];

function randomCard() {
  return { value: CARD_VALUES[rand(0, 12)], suit: CARD_SUITS[rand(0, 3)] };
}

function cardNumericValue(card) {
  if (card.value === 'A') return 11;
  if (['K', 'Q', 'J'].includes(card.value)) return 10;
  return parseInt(card.value);
}

function handValue(cards) {
  let total = cards.reduce((s, c) => s + cardNumericValue(c), 0);
  let aces = cards.filter(c => c.value === 'A').length;
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total;
}

// ------------------------------
// Canvas Animation Generators
// ------------------------------
function createCoinFlipAnimation(outcome, guess, win) {
  const frames = [];
  const width = 400, height = 280;

  for (let i = 0; i < 5; i++) {
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    drawGradientBg(ctx, width, height, '#1a1a2e', '#16213e');

    // Coin
    const cx = width / 2, cy = 110;
    const coinRadius = 50;
    const scaleX = i < 3 ? Math.abs(Math.cos((i / 3) * Math.PI)) : 1;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(scaleX || 0.1, 1);
    ctx.beginPath();
    ctx.arc(0, 0, coinRadius, 0, Math.PI * 2);
    const coinGrad = ctx.createRadialGradient(-15, -15, 10, 0, 0, coinRadius);
    coinGrad.addColorStop(0, '#f9e547');
    coinGrad.addColorStop(1, '#d4a017');
    ctx.fillStyle = coinGrad;
    ctx.fill();
    ctx.strokeStyle = '#b8860b';
    ctx.lineWidth = 3;
    ctx.stroke();
    if (i >= 3) {
      ctx.fillStyle = '#b8860b';
      ctx.font = 'bold 28px Arial';
      ctx.textAlign = 'center';
      ctx.fillText(outcome === 'heads' ? 'H' : 'T', 0, 10);
    }
    ctx.restore();

    // Result text
    ctx.font = 'bold 22px Arial';
    ctx.fillStyle = '#ecf0f1';
    ctx.textAlign = 'center';
    if (i >= 3) {
      ctx.fillText(`${outcome.toUpperCase()}!`, width / 2, 195);
      ctx.font = '16px Arial';
      ctx.fillStyle = '#95a5a6';
      ctx.fillText(`You guessed: ${guess.toUpperCase()}`, width / 2, 220);
      ctx.font = 'bold 24px Arial';
      ctx.fillStyle = win ? '#2ecc71' : '#e74c3c';
      ctx.fillText(win ? '✨ YOU WIN!' : '💔 YOU LOSE', width / 2, 260);
    } else {
      ctx.fillStyle = '#f39c12';
      ctx.fillText('Flipping...', width / 2, 200);
    }

    frames.push(canvas.toBuffer('image/png'));
  }
  return frames;
}

function createDiceAnimation(roll, target, win) {
  const frames = [];
  const width = 400, height = 280;

  for (let frame = 0; frame < 5; frame++) {
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    drawGradientBg(ctx, width, height, '#0f3460', '#16213e');

    const diceSize = 80;
    const dx = width / 2 - diceSize / 2, dy = 50;
    roundRect(ctx, dx, dy, diceSize, diceSize, 10);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = '#bdc3c7';
    ctx.lineWidth = 2;
    ctx.stroke();

    const displayNum = frame < 3 ? rand(1, 6) : roll;
    ctx.fillStyle = '#2c3e50';
    ctx.font = 'bold 42px Arial';
    ctx.textAlign = 'center';
    ctx.fillText(String(displayNum), width / 2, dy + 55);

    if (frame >= 3) {
      ctx.font = '18px Arial';
      ctx.fillStyle = '#95a5a6';
      ctx.fillText(`You picked: ${target}  |  Rolled: ${roll}`, width / 2, 175);
      ctx.font = 'bold 26px Arial';
      ctx.fillStyle = win ? '#2ecc71' : '#e74c3c';
      ctx.fillText(win ? '🎯 EXACT MATCH!' : '❌ No match', width / 2, 215);
      ctx.font = '14px Arial';
      ctx.fillStyle = '#7f8c8d';
      ctx.fillText(win ? 'Big payout! 5.5x multiplier' : 'Better luck next time', width / 2, 250);
    } else {
      ctx.font = '20px Arial';
      ctx.fillStyle = '#f39c12';
      ctx.fillText('🎲 Rolling...', width / 2, 180);
    }
    frames.push(canvas.toBuffer('image/png'));
  }
  return frames;
}

function createSlotAnimation(reels, win) {
  const frames = [];
  const width = 500, height = 280;
  const symbols = ['🍒', '🍋', '🍇', '🍉', '7️⃣', '💎', '⭐'];

  for (let frame = 0; frame < 6; frame++) {
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    drawGradientBg(ctx, width, height, '#1a1a2e', '#0f0f23');

    // Machine border
    roundRect(ctx, 60, 30, 380, 160, 15);
    ctx.fillStyle = '#2c3e50';
    ctx.fill();
    ctx.strokeStyle = '#f1c40f';
    ctx.lineWidth = 3;
    ctx.stroke();

    // Inner reel areas
    for (let r = 0; r < 3; r++) {
      const rx = 90 + r * 120;
      roundRect(ctx, rx, 50, 100, 120, 8);
      ctx.fillStyle = '#1a1a1a';
      ctx.fill();
      ctx.strokeStyle = '#555';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    ctx.font = 'bold 55px Arial';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'white';

    const stopped = frame >= 4;
    const displayReels = stopped
      ? reels
      : reels.map((_, idx) => frame >= idx + 1 ? reels[idx] : symbols[Math.floor(Math.random() * symbols.length)]);

    for (let r = 0; r < 3; r++) {
      ctx.fillText(displayReels[r], 140 + r * 120, 128);
    }

    // Win line
    if (stopped && win) {
      ctx.strokeStyle = '#2ecc71';
      ctx.lineWidth = 3;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(90, 110);
      ctx.lineTo(450, 110);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.font = 'bold 22px Arial';
    ctx.fillStyle = win ? '#2ecc71' : (stopped ? '#e74c3c' : '#f39c12');
    ctx.fillText(stopped ? (win ? '🎉 JACKPOT!' : 'No match') : '⏳ Spinning...', width / 2, 230);
    if (stopped) {
      ctx.font = '14px Arial';
      ctx.fillStyle = '#7f8c8d';
      ctx.fillText(win ? 'Triple match bonus!' : 'Try again for a triple match', width / 2, 260);
    }
    frames.push(canvas.toBuffer('image/png'));
  }
  return frames;
}

function createCrashAnimation(crashPoint, cashout, didSurvive) {
  const frames = [];
  const width = 500, height = 300;

  for (let frame = 0; frame < 7; frame++) {
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    drawGradientBg(ctx, width, height, '#0f0f23', '#1a1a2e');

    // Grid
    ctx.strokeStyle = '#1e2d3d';
    ctx.lineWidth = 0.5;
    for (let gx = 50; gx <= 450; gx += 50) { ctx.beginPath(); ctx.moveTo(gx, 20); ctx.lineTo(gx, 250); ctx.stroke(); }
    for (let gy = 20; gy <= 250; gy += 40) { ctx.beginPath(); ctx.moveTo(50, gy); ctx.lineTo(450, gy); ctx.stroke(); }

    // Axes
    ctx.strokeStyle = '#34495e';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(50, 250); ctx.lineTo(450, 250); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(50, 250); ctx.lineTo(50, 20); ctx.stroke();

    // Curve
    const progress = Math.min(1, frame / 5);
    const maxMult = Number(crashPoint);
    ctx.beginPath();
    ctx.moveTo(50, 250);
    ctx.strokeStyle = didSurvive ? '#2ecc71' : '#e74c3c';
    ctx.lineWidth = 3;
    for (let t = 0; t <= progress; t += 0.01) {
      const mult = 1 + t * (maxMult - 1);
      const x = 50 + t * 400;
      const y = 250 - ((mult - 1) / Math.max(maxMult - 1, 1)) * 200;
      ctx.lineTo(x, Math.max(20, y));
    }
    ctx.stroke();

    // Crash point marker
    if (frame >= 5) {
      const crashX = 450, crashY = 20;
      ctx.beginPath();
      ctx.arc(crashX, crashY, 8, 0, Math.PI * 2);
      ctx.fillStyle = '#e74c3c';
      ctx.fill();
    }

    const currentMult = 1 + progress * (maxMult - 1);
    ctx.font = 'bold 36px Arial';
    ctx.fillStyle = frame >= 5 ? (didSurvive ? '#2ecc71' : '#e74c3c') : '#f1c40f';
    ctx.textAlign = 'center';
    ctx.fillText(`×${currentMult.toFixed(2)}`, width / 2, 285);

    if (frame >= 5) {
      ctx.font = 'bold 20px Arial';
      ctx.fillStyle = didSurvive ? '#2ecc71' : '#e74c3c';
      ctx.fillText(didSurvive ? `✅ Cashed out at ×${cashout}` : `💥 CRASHED at ×${crashPoint}`, width / 2, 16);
    }
    frames.push(canvas.toBuffer('image/png'));
  }
  return frames;
}

function createWheelAnimation(result, frameCount = 8) {
  const frames = [];
  const width = 400, height = 400;
  const sections = [
    { label: 'x0', color: '#e74c3c' },
    { label: 'x1', color: '#e67e22' },
    { label: 'x2', color: '#f1c40f' },
    { label: 'x5', color: '#2ecc71' },
    { label: 'x10', color: '#3498db' },
    { label: 'JACKPOT', color: '#9b59b6' },
  ];

  for (let frame = 0; frame < frameCount; frame++) {
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    drawGradientBg(ctx, width, height, '#0f0f23', '#1a1a2e');

    const cx = width / 2, cy = height / 2 + 10;
    const radius = 150;
    // Decelerate rotation
    const speed = Math.max(0.2, 1 - frame / frameCount);
    const rotation = frame * speed * 1.3;

    for (let i = 0; i < sections.length; i++) {
      const angle = (i / sections.length) * Math.PI * 2 + rotation;
      const nextAngle = angle + Math.PI * 2 / sections.length;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, radius, angle, nextAngle);
      ctx.fillStyle = sections[i].color;
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.stroke();

      const textAngle = angle + Math.PI / sections.length;
      const tx = cx + Math.cos(textAngle) * 95;
      const ty = cy + Math.sin(textAngle) * 95;
      ctx.save();
      ctx.translate(tx, ty);
      ctx.rotate(textAngle + Math.PI / 2);
      ctx.fillStyle = 'white';
      ctx.font = 'bold 15px Arial';
      ctx.textAlign = 'center';
      ctx.fillText(sections[i].label, 0, 0);
      ctx.restore();
    }

    // Center hub
    ctx.beginPath();
    ctx.arc(cx, cy, 20, 0, Math.PI * 2);
    const hubGrad = ctx.createRadialGradient(cx - 5, cy - 5, 3, cx, cy, 20);
    hubGrad.addColorStop(0, '#f9e547');
    hubGrad.addColorStop(1, '#d4a017');
    ctx.fillStyle = hubGrad;
    ctx.fill();

    // Pointer
    ctx.fillStyle = '#f1c40f';
    ctx.beginPath();
    ctx.moveTo(cx - 12, 25);
    ctx.lineTo(cx + 12, 25);
    ctx.lineTo(cx, 50);
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Title
    ctx.font = 'bold 20px Arial';
    ctx.fillStyle = '#ecf0f1';
    ctx.textAlign = 'center';
    ctx.fillText('🎡 WHEEL OF FORTUNE', cx, 18);

    if (frame === frameCount - 1) {
      ctx.font = 'bold 18px Arial';
      ctx.fillStyle = '#f1c40f';
      ctx.fillText(`Result: ${result}`, cx, height - 15);
    }
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
    drawGradientBg(ctx, width, height, '#1a0a2e', '#2d1b4e');

    ctx.font = 'bold 24px Arial';
    ctx.fillStyle = '#f1c40f';
    ctx.textAlign = 'center';
    ctx.fillText('💎 Treasure Hunt', width / 2, 35);

    const cellSize = 80;
    const gap = 12;
    const startX = (width - cellSize * 3 - gap * 2) / 2;
    const startY = 55;

    for (let i = 0; i < 9; i++) {
      const row = Math.floor(i / 3);
      const col = i % 3;
      const x = startX + col * (cellSize + gap);
      const y = startY + row * (cellSize + gap);

      roundRect(ctx, x, y, cellSize, cellSize, 10);
      if (i < reveal) {
        const isTreasure = spots[i] === '💎';
        ctx.fillStyle = isTreasure ? '#2ecc71' : '#34495e';
        ctx.fill();
        ctx.strokeStyle = isTreasure ? '#27ae60' : '#555';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.font = '40px Arial';
        ctx.fillStyle = 'white';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(spots[i], x + cellSize / 2, y + cellSize / 2);
        ctx.textBaseline = 'alphabetic';
      } else {
        ctx.fillStyle = '#4a3072';
        ctx.fill();
        ctx.strokeStyle = '#7d3cff';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.font = '30px Arial';
        ctx.fillStyle = '#9b59b6';
        ctx.textAlign = 'center';
        ctx.fillText('?', x + cellSize / 2, y + cellSize / 2 + 10);
      }
    }

    ctx.font = '18px Arial';
    ctx.fillStyle = '#ecf0f1';
    ctx.textAlign = 'center';
    if (reveal >= 9) {
      ctx.font = 'bold 20px Arial';
      ctx.fillStyle = win ? '#2ecc71' : '#e74c3c';
      ctx.fillText(`${treasureCount} treasure${treasureCount !== 1 ? 's' : ''} found! ${win ? '💰' : ''}`, width / 2, 355);
    } else {
      ctx.fillStyle = '#95a5a6';
      ctx.fillText('Revealing tiles...', width / 2, 355);
    }
    ctx.font = '13px Arial';
    ctx.fillStyle = '#7f8c8d';
    ctx.fillText('Each 💎 multiplies your bet!', width / 2, 385);

    frames.push(canvas.toBuffer('image/png'));
  }
  return frames;
}

function createHighLowAnimation(first, second, guess, win) {
  const frames = [];
  const width = 500, height = 280;
  const suits = CARD_SUITS;

  const firstSuit = suits[rand(0, 3)];
  const secondSuit = suits[rand(0, 3)];
  const firstLabel = CARD_VALUES[first - 1] || String(first);
  const secondLabel = CARD_VALUES[second - 1] || String(second);

  for (let frame = 0; frame < 5; frame++) {
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    drawGradientBg(ctx, width, height, '#0d2137', '#132743');

    ctx.font = 'bold 20px Arial';
    ctx.fillStyle = '#f1c40f';
    ctx.textAlign = 'center';
    ctx.fillText('Higher or Lower?', width / 2, 28);

    // First card (always visible)
    drawCard(ctx, 130, 50, firstLabel, firstSuit, false);

    // VS text
    ctx.font = 'bold 22px Arial';
    ctx.fillStyle = '#e74c3c';
    ctx.fillText('VS', width / 2, 100);

    // Second card (face down then revealed)
    if (frame < 3) {
      drawCard(ctx, 305, 50, secondLabel, secondSuit, true);
    } else {
      drawCard(ctx, 305, 50, secondLabel, secondSuit, false);
    }

    if (frame >= 3) {
      ctx.font = '16px Arial';
      ctx.fillStyle = '#95a5a6';
      ctx.textAlign = 'center';
      ctx.fillText(`You guessed: ${guess.toUpperCase()}`, width / 2, 175);
      ctx.font = 'bold 24px Arial';
      ctx.fillStyle = win ? '#2ecc71' : '#e74c3c';
      ctx.fillText(win ? '✅ CORRECT!' : '❌ WRONG!', width / 2, 210);
      ctx.font = '14px Arial';
      ctx.fillStyle = '#7f8c8d';
      ctx.fillText(`${firstLabel} → ${secondLabel}  (${second > first ? 'Higher' : second < first ? 'Lower' : 'Equal'})`, width / 2, 245);
    } else {
      ctx.font = '18px Arial';
      ctx.fillStyle = '#f39c12';
      ctx.fillText('Revealing...', width / 2, 200);
    }
    frames.push(canvas.toBuffer('image/png'));
  }
  return frames;
}

function createBlackjackImage(playerCards, dealerCards, hideDealer, playerTotal, dealerTotal, status) {
  const width = 550, height = 340;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  drawGradientBg(ctx, width, height, '#0b6623', '#0a4f1c');

  // Table felt texture
  ctx.fillStyle = 'rgba(0,0,0,0.1)';
  roundRect(ctx, 10, 10, width - 20, height - 20, 20);
  ctx.fill();
  ctx.strokeStyle = '#d4af37';
  ctx.lineWidth = 3;
  ctx.stroke();

  // Dealer label
  ctx.font = 'bold 16px Arial';
  ctx.fillStyle = '#f1c40f';
  ctx.textAlign = 'left';
  ctx.fillText(`DEALER${hideDealer ? '' : ` (${dealerTotal})`}`, 20, 35);

  // Dealer cards
  const dealerStartX = 20;
  for (let i = 0; i < dealerCards.length; i++) {
    const card = dealerCards[i];
    drawCard(ctx, dealerStartX + i * 75, 45, card.value, card.suit, hideDealer && i === 1);
  }

  // Divider
  ctx.strokeStyle = '#d4af37';
  ctx.lineWidth = 1;
  ctx.setLineDash([8, 4]);
  ctx.beginPath();
  ctx.moveTo(20, 160);
  ctx.lineTo(width - 20, 160);
  ctx.stroke();
  ctx.setLineDash([]);

  // Player label
  ctx.font = 'bold 16px Arial';
  ctx.fillStyle = '#3498db';
  ctx.textAlign = 'left';
  ctx.fillText(`YOU (${playerTotal})`, 20, 185);

  // Player cards
  const playerStartX = 20;
  for (let i = 0; i < playerCards.length; i++) {
    const card = playerCards[i];
    drawCard(ctx, playerStartX + i * 75, 195, card.value, card.suit, false);
  }

  // Status banner
  if (status) {
    roundRect(ctx, width / 2 - 120, height - 45, 240, 32, 8);
    const statusColor = status.includes('WIN') || status.includes('BLACKJACK') ? '#2ecc71'
      : status.includes('BUST') || status.includes('LOSE') ? '#e74c3c'
      : '#f39c12';
    ctx.fillStyle = statusColor;
    ctx.fill();
    ctx.font = 'bold 16px Arial';
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.fillText(status, width / 2, height - 24);
  }

  return canvas.toBuffer('image/png');
}

function createRPSAnimation(playerChoice, botChoice, result) {
  const frames = [];
  const width = 450, height = 250;
  const rpsEmojis = { rock: '✊', paper: '✋', scissors: '✌️' };

  for (let frame = 0; frame < 4; frame++) {
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    drawGradientBg(ctx, width, height, '#1a1a2e', '#16213e');

    ctx.font = 'bold 20px Arial';
    ctx.fillStyle = '#f1c40f';
    ctx.textAlign = 'center';
    ctx.fillText('Rock Paper Scissors', width / 2, 30);

    // Player side
    ctx.font = '60px Arial';
    ctx.fillText(rpsEmojis[playerChoice], 110, 120);
    ctx.font = '14px Arial';
    ctx.fillStyle = '#3498db';
    ctx.fillText('YOU', 110, 150);

    // VS
    ctx.font = 'bold 28px Arial';
    ctx.fillStyle = '#e74c3c';
    ctx.fillText('VS', width / 2, 110);

    // Bot side
    ctx.font = '60px Arial';
    ctx.fillStyle = '#ecf0f1';
    if (frame < 2) {
      const options = ['✊', '✋', '✌️'];
      ctx.fillText(options[frame % 3], 340, 120);
    } else {
      ctx.fillText(rpsEmojis[botChoice], 340, 120);
    }
    ctx.font = '14px Arial';
    ctx.fillStyle = '#e74c3c';
    ctx.fillText('BOT', 340, 150);

    if (frame >= 2) {
      ctx.font = 'bold 24px Arial';
      ctx.fillStyle = result === 'win' ? '#2ecc71' : result === 'push' ? '#f39c12' : '#e74c3c';
      ctx.fillText(result === 'win' ? '🎉 YOU WIN!' : result === 'push' ? '🤝 TIE!' : '💔 YOU LOSE', width / 2, 210);
    }
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
    return interaction.reply({ flags: MessageFlags.Ephemeral, content: `# Invalid bet\nBet must be at least ${moneyStr(minBet, currency)}.` });
  }
  if (bet > maxBet) {
    return interaction.reply({ flags: MessageFlags.Ephemeral, content: `# Bet too high\nMaximum bet is ${moneyStr(maxBet, currency)}.` });
  }
  if (wallet.balance < bet) {
    return interaction.reply({ flags: MessageFlags.Ephemeral, content: `# No funds\nYou only have ${moneyStr(wallet.balance, currency)}.` });
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
    return interaction.reply({ flags: MessageFlags.Ephemeral, content: `# No funds\nYou need ${moneyStr(bet, currency)}.` });
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
    return interaction.reply({ flags: MessageFlags.Ephemeral, content: `# No funds\nYou need ${moneyStr(bet, currency)}.` });
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
    return interaction.reply({ flags: MessageFlags.Ephemeral, content: `# No funds\nYou need ${moneyStr(bet, currency)}.` });
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
    return interaction.reply({ flags: MessageFlags.Ephemeral, content: `# No funds\nYou need ${moneyStr(bet, currency)}.` });
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
    return interaction.reply({ flags: MessageFlags.Ephemeral, content: `# No funds\nYou need ${moneyStr(bet, currency)}.` });
  }

  const net = payout - bet;
  addBalance(interaction.guildId, interaction.user.id, net, currency.currency_id, 'game', `rps:${result}`);
  registerStatTrigger(interaction.guildId, interaction.user.id, result === 'win' ? 'wins' : 'losses');

  const color = result === 'win' ? Colors.Green : result === 'push' ? Colors.Yellow : Colors.Red;
  const embed = baseEmbed('✊ Rock Paper Scissors',
    `You: **${guess.toUpperCase()}** | Bot: **${bot.toUpperCase()}**\nResult: **${result.toUpperCase()}**\nPayout: ${moneyStr(payout, currency)}\nBalance: ${moneyStr(getWallet(interaction.guildId, interaction.user.id, currency.currency_id).balance, currency)}`,
    color);

  const imageFrames = createRPSAnimation(guess, bot, result);
  await animateWithImages(interaction, imageFrames, embed, 500);
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
    return interaction.reply({ flags: MessageFlags.Ephemeral, content: `# No funds\nYou need ${moneyStr(bet, currency)}.` });
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
    return interaction.reply({ flags: MessageFlags.Ephemeral, content: `# No funds\nYou need ${moneyStr(bet, currency)}.` });
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
// Interactive Blackjack
// ------------------------------
async function showBlackjack(interaction, bet) {
  const guildId = interaction.guildId;
  const userId = interaction.user.id;
  const currency = getCurrency(guildId, getGuildSettings(guildId).currency_id);
  const wallet = getWallet(guildId, userId, currency.currency_id);

  if (wallet.balance < bet) {
    return interaction.reply({ flags: MessageFlags.Ephemeral, content: `# No funds\nYou need ${moneyStr(bet, currency)}.` });
  }

  addBalance(guildId, userId, -bet, currency.currency_id, 'game', 'blackjack:bet');
  incrementStat(guildId, userId, 'games_played');
  incrementStat(guildId, userId, 'bet_total', bet);

  const playerCards = [randomCard(), randomCard()];
  const dealerCards = [randomCard(), randomCard()];
  const gameKey = `bj:${guildId}:${userId}`;

  const buildMessage = (status, hideDealer) => {
    const pVal = handValue(playerCards);
    const dVal = hideDealer ? cardNumericValue(dealerCards[0]) : handValue(dealerCards);
    const img = createBlackjackImage(playerCards, dealerCards, hideDealer, pVal, dVal, status);
    const attachment = new AttachmentBuilder(img, { name: 'blackjack.png' });

    const embed = baseEmbed('🃏 Blackjack',
      `Bet: ${moneyStr(bet, currency)}` + (status ? `\n**${status}**` : ''),
      status?.includes('WIN') || status?.includes('BLACKJACK') ? Colors.Green
        : status?.includes('BUST') || status?.includes('LOSE') ? Colors.Red
        : status?.includes('PUSH') ? Colors.Yellow : Colors.Blurple);
    embed.setImage('attachment://blackjack.png');

    const row = new ActionRowBuilder();
    if (!status) {
      row.addComponents(
        new ButtonBuilder().setCustomId(`bj_hit_${userId}`).setLabel('🃏 Hit').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`bj_stand_${userId}`).setLabel('✋ Stand').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`bj_double_${userId}`).setLabel('⬆️ Double').setStyle(ButtonStyle.Danger)
          .setDisabled(wallet.balance < bet * 2 || playerCards.length > 2),
      );
    }
    return { embeds: [embed], files: [attachment], components: status ? [] : [row] };
  };

  // Check instant blackjack
  if (handValue(playerCards) === 21) {
    const payout = Math.floor(bet * 2.5 * economyMultiplier(guildId));
    addBalance(guildId, userId, payout, currency.currency_id, 'game', 'blackjack:blackjack');
    registerStatTrigger(guildId, userId, 'wins');
    unlockAchievement(guildId, userId, 'first_win');
    return replySafe(interaction, buildMessage(`🎰 BLACKJACK! +${moneyStr(payout, currency)}`, false));
  }

  await replySafe(interaction, buildMessage(null, true));
  const message = await interaction.fetchReply();

  const collector = message.createMessageComponentCollector({ time: 60000 });
  collector.on('collect', async (btn) => {
    if (btn.user.id !== userId) return btn.reply({ content: 'This is not your game!', flags: MessageFlags.Ephemeral });
    await btn.deferUpdate();

    if (btn.customId === `bj_hit_${userId}`) {
      playerCards.push(randomCard());
      if (handValue(playerCards) > 21) {
        registerStatTrigger(guildId, userId, 'losses');
        await message.edit(buildMessage(`💥 BUST! You lose ${moneyStr(bet, currency)}`, false));
        collector.stop();
        return;
      }
      if (handValue(playerCards) === 21) {
        // Auto-stand on 21
        btn.customId = `bj_stand_${userId}`;
      } else {
        await message.edit(buildMessage(null, true));
        return;
      }
    }

    if (btn.customId === `bj_double_${userId}`) {
      addBalance(guildId, userId, -bet, currency.currency_id, 'game', 'blackjack:double');
      bet *= 2;
      playerCards.push(randomCard());
      if (handValue(playerCards) > 21) {
        registerStatTrigger(guildId, userId, 'losses');
        await message.edit(buildMessage(`💥 BUST on double! -${moneyStr(bet, currency)}`, false));
        collector.stop();
        return;
      }
      // Fall through to stand logic
    }

    if (btn.customId === `bj_stand_${userId}` || btn.customId === `bj_double_${userId}`) {
      // Dealer draws
      while (handValue(dealerCards) < 17) dealerCards.push(randomCard());
      const pVal = handValue(playerCards);
      const dVal = handValue(dealerCards);

      let status, win = false;
      if (dVal > 21) {
        const payout = Math.floor(bet * 2 * economyMultiplier(guildId));
        addBalance(guildId, userId, payout, currency.currency_id, 'game', 'blackjack:dealer_bust');
        status = `🎉 Dealer busts! WIN +${moneyStr(payout, currency)}`;
        win = true;
      } else if (pVal > dVal) {
        const payout = Math.floor(bet * 2 * economyMultiplier(guildId));
        addBalance(guildId, userId, payout, currency.currency_id, 'game', 'blackjack:win');
        status = `🎉 YOU WIN! +${moneyStr(payout, currency)}`;
        win = true;
      } else if (pVal === dVal) {
        addBalance(guildId, userId, bet, currency.currency_id, 'game', 'blackjack:push');
        status = `🤝 PUSH — bet returned`;
      } else {
        status = `😞 DEALER WINS — you lose ${moneyStr(bet, currency)}`;
      }

      registerStatTrigger(guildId, userId, win ? 'wins' : 'losses');
      if (win) unlockAchievement(guildId, userId, 'first_win');
      addXp(guildId, userId, win ? rand(25, 60) : rand(5, 15));
      await message.edit(buildMessage(status, false));
      collector.stop();
    }
  });

  collector.on('end', async (_, reason) => {
    if (reason === 'time') {
      registerStatTrigger(guildId, userId, 'losses');
      await message.edit(buildMessage('⏰ Timed out — bet forfeited', false)).catch(() => null);
    }
  });
}

// ------------------------------
// Event handling
// ------------------------------
client.once(Events.ClientReady, () => {
  console.log(`✓ Bot ready as ${client.user?.tag}`);
});

// Defer slash commands
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isCommand()) return;

  const commands = buildCommands();
  const cmd = commands.find(c => c.name === interaction.commandName);
  if (!cmd) return;

  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply();
    }
    await cmd.execute(interaction);
  } catch (err) {
    console.error(`✗ Command error:`, err);
    const payload = { content: '❌ An error occurred. Please try again.' };
    if (interaction.replied || interaction.deferred) {
      await interaction.editReply(payload).catch(() => null);
    } else {
      await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => null);
    }
  }
});

// Register commands once client is ready
client.on(Events.ClientReady, async () => {
  if (!TOKEN || !CLIENT_ID) return;
  const commands = buildCommands();
  const rest = new (require('discord.js').REST)({ version: '10' }).setToken(TOKEN);

  try {
    const body = commands.map(c => c.data.toJSON());
    if (GUILD_ID) {
      await rest.put(`/applications/${CLIENT_ID}/guilds/${GUILD_ID}/commands`, { body });
      console.log(`✓ Registered ${commands.length} commands to guild ${GUILD_ID}`);
    } else {
      await rest.put(`/applications/${CLIENT_ID}/commands`, { body });
      console.log(`✓ Registered ${commands.length} global commands`);
    }
  } catch (err) {
    console.error('✗ Command registration error:', err.message);
  }
});

// Helper: get an integer option value whether Discord sends it as INTEGER or NUMBER type
function getIntOption(options, name) {
  const opt = options.get(name);
  if (!opt) return null;
  return Math.floor(Number(opt.value));
}

function buildCommands() {
  return [
    // ── Casino Games ──
    {
      name: 'flip',
      data: new SlashCommandBuilder()
        .setName('flip')
        .setDescription('🪙 Flip a coin — heads or tails?')
        .addIntegerOption(opt => opt.setName('bet').setDescription('Bet amount').setRequired(true).setMinValue(1))
        .addStringOption(opt => opt.setName('guess').setDescription('Your call').setRequired(true)
          .addChoices({ name: '🟡 Heads', value: 'heads' }, { name: '⚪ Tails', value: 'tails' })),
      execute: async (i) => showCoinFlip(i, getIntOption(i.options, 'bet'), i.options.getString('guess')),
    },
    {
      name: 'dice',
      data: new SlashCommandBuilder()
        .setName('dice')
        .setDescription('🎲 Roll the dice — pick a number')
        .addIntegerOption(opt => opt.setName('bet').setDescription('Bet amount').setRequired(true).setMinValue(1))
        .addIntegerOption(opt => opt.setName('target').setDescription('Pick 1-6').setRequired(true).setMinValue(1).setMaxValue(6)),
      execute: async (i) => showDice(i, getIntOption(i.options, 'bet'), getIntOption(i.options, 'target')),
    },
    {
      name: 'slots',
      data: new SlashCommandBuilder()
        .setName('slots')
        .setDescription('🎰 Spin the slot machine')
        .addIntegerOption(opt => opt.setName('bet').setDescription('Bet amount').setRequired(true).setMinValue(1)),
      execute: async (i) => showSlots(i, getIntOption(i.options, 'bet')),
    },
    {
      name: 'blackjack',
      data: new SlashCommandBuilder()
        .setName('blackjack')
        .setDescription('🃏 Play blackjack with interactive Hit/Stand/Double')
        .addIntegerOption(opt => opt.setName('bet').setDescription('Bet amount').setRequired(true).setMinValue(1)),
      execute: async (i) => showBlackjack(i, getIntOption(i.options, 'bet')),
    },
    {
      name: 'crash',
      data: new SlashCommandBuilder()
        .setName('crash')
        .setDescription('📈 Ride the crash curve')
        .addIntegerOption(opt => opt.setName('bet').setDescription('Bet amount').setRequired(true).setMinValue(1)),
      execute: async (i) => showCrash(i, getIntOption(i.options, 'bet')),
    },
    {
      name: 'wheel',
      data: new SlashCommandBuilder()
        .setName('wheel')
        .setDescription('🎡 Spin the wheel of fortune')
        .addIntegerOption(opt => opt.setName('bet').setDescription('Bet amount').setRequired(true).setMinValue(1)),
      execute: async (i) => showWheel(i, getIntOption(i.options, 'bet')),
    },
    {
      name: 'treasure',
      data: new SlashCommandBuilder()
        .setName('treasure')
        .setDescription('💎 Hunt for buried treasure')
        .addIntegerOption(opt => opt.setName('bet').setDescription('Bet amount').setRequired(true).setMinValue(1)),
      execute: async (i) => showTreasure(i, getIntOption(i.options, 'bet')),
    },
    {
      name: 'higher',
      data: new SlashCommandBuilder()
        .setName('higher')
        .setDescription('🂠 Higher or Lower card game')
        .addIntegerOption(opt => opt.setName('bet').setDescription('Bet amount').setRequired(true).setMinValue(1))
        .addStringOption(opt => opt.setName('guess').setDescription('Your prediction').setRequired(true)
          .addChoices({ name: '⬆️ Higher', value: 'higher' }, { name: '⬇️ Lower', value: 'lower' }, { name: '↔️ Equal', value: 'equal' })),
      execute: async (i) => showHigherLower(i, getIntOption(i.options, 'bet'), i.options.getString('guess')),
    },
    {
      name: 'rps',
      data: new SlashCommandBuilder()
        .setName('rps')
        .setDescription('✊ Rock Paper Scissors')
        .addIntegerOption(opt => opt.setName('bet').setDescription('Bet amount').setRequired(true).setMinValue(1))
        .addStringOption(opt => opt.setName('choice').setDescription('Your move').setRequired(true)
          .addChoices({ name: '✊ Rock', value: 'rock' }, { name: '✋ Paper', value: 'paper' }, { name: '✌️ Scissors', value: 'scissors' })),
      execute: async (i) => showRPS(i, getIntOption(i.options, 'bet'), i.options.getString('choice')),
    },
    {
      name: 'limbo',
      data: new SlashCommandBuilder()
        .setName('limbo')
        .setDescription('🧍 Limbo — set your target multiplier')
        .addIntegerOption(opt => opt.setName('bet').setDescription('Bet amount').setRequired(true).setMinValue(1))
        .addNumberOption(opt => opt.setName('target').setDescription('Target (0.01-10)').setRequired(true).setMinValue(0.01).setMaxValue(10)),
      execute: async (i) => showLimbo(i, getIntOption(i.options, 'bet'), i.options.getNumber('target')),
    },
    {
      name: 'lucky',
      data: new SlashCommandBuilder()
        .setName('lucky')
        .setDescription('🔢 Pick a lucky number 1-100')
        .addIntegerOption(opt => opt.setName('bet').setDescription('Bet amount').setRequired(true).setMinValue(1))
        .addIntegerOption(opt => opt.setName('number').setDescription('Your number (1-100)').setRequired(true).setMinValue(1).setMaxValue(100)),
      execute: async (i) => showLuckNumber(i, getIntOption(i.options, 'bet'), getIntOption(i.options, 'number')),
    },
    {
      name: 'scratch',
      data: new SlashCommandBuilder()
        .setName('scratch')
        .setDescription('🎫 Scratch a lottery card')
        .addIntegerOption(opt => opt.setName('bet').setDescription('Bet amount').setRequired(true).setMinValue(1)),
      execute: async (i) => showScratch(i, getIntOption(i.options, 'bet')),
    },
    {
      name: 'lottery',
      data: new SlashCommandBuilder()
        .setName('lottery')
        .setDescription('🎟️ Buy a lottery ticket')
        .addIntegerOption(opt => opt.setName('bet').setDescription('Bet amount').setRequired(true).setMinValue(1)),
      execute: async (i) => showLottery(i, getIntOption(i.options, 'bet')),
    },

    // ── Economy Commands ──
    {
      name: 'balance',
      data: new SlashCommandBuilder()
        .setName('balance')
        .setDescription('💰 Check your balance')
        .addUserOption(opt => opt.setName('user').setDescription('User to check')),
      execute: async (i) => {
        const target = i.options.getUser('user') || i.user;
        const guildId = i.guildId;
        const user = getUser(guildId, target.id);
        const w = user.wallet;
        const c = getCurrency(guildId, getGuildSettings(guildId).currency_id);
        const winRate = (user.stats.wins || 0) + (user.stats.losses || 0) > 0
          ? ((user.stats.wins || 0) / ((user.stats.wins || 0) + (user.stats.losses || 0)) * 100).toFixed(1)
          : '0.0';
        const e = baseEmbed('💰 Balance', '', Colors.Gold)
          .addFields(
            { name: '💵 Wallet', value: moneyStr(w.balance, c), inline: true },
            { name: '🏦 Bank', value: moneyStr(w.bank, c), inline: true },
            { name: '💎 Net Worth', value: moneyStr(w.balance + w.bank, c), inline: true },
            { name: '📊 Level', value: `${user.level}`, inline: true },
            { name: '✨ XP', value: `${user.xp}/${user.level * user.level * 100}`, inline: true },
            { name: '🏆 Win Rate', value: `${winRate}%`, inline: true },
          )
          .setDescription(`${userTag(target)}'s account`);
        await i.editReply({ embeds: [e] });
      },
    },
    {
      name: 'daily',
      data: new SlashCommandBuilder()
        .setName('daily')
        .setDescription('📅 Claim your daily reward'),
      execute: async (i) => {
        const guildId = i.guildId;
        const userId = i.user.id;
        const user = ensureUser(guildId, userId);
        const currency = getCurrency(guildId, getGuildSettings(guildId).currency_id);
        const lastDaily = user.last_daily || 0;
        const elapsed = now() - lastDaily;

        if (elapsed < 86400) {
          const remaining = 86400 - elapsed;
          const hours = Math.floor(remaining / 3600);
          const mins = Math.floor((remaining % 3600) / 60);
          return i.editReply({ embeds: [baseEmbed('⏰ Daily Cooldown', `Come back in **${hours}h ${mins}m**`, Colors.Yellow)] });
        }

        // Streak logic
        let streak = user.daily_streak || 0;
        if (elapsed < 172800) { streak += 1; } else { streak = 1; }
        const base = 500 + streak * 100;
        const bonus = Math.floor(base * (streak >= 7 ? 2 : streak >= 3 ? 1.5 : 1));
        const total = Math.floor(bonus * economyMultiplier(guildId));

        addBalance(guildId, userId, total, currency.currency_id, 'daily', `streak:${streak}`);
        db.prepare('UPDATE users SET daily_streak = ?, last_daily = ? WHERE guild_id = ? AND user_id = ?')
          .run(streak, now(), guildId, userId);
        addXp(guildId, userId, rand(30, 80));

        const streakBar = makeBar(Math.min(streak / 7, 1));
        const e = baseEmbed('📅 Daily Reward', '', Colors.Green)
          .addFields(
            { name: '💰 Claimed', value: moneyStr(total, currency), inline: true },
            { name: '🔥 Streak', value: `${streak} day${streak !== 1 ? 's' : ''}`, inline: true },
            { name: 'Streak Progress', value: `${streakBar} ${streak}/7`, inline: false },
          );
        if (streak >= 7) e.setDescription('🌟 **WEEKLY BONUS ACTIVE — 2x rewards!**');
        else if (streak >= 3) e.setDescription('🔥 **3-day streak — 1.5x bonus!**');
        await i.editReply({ embeds: [e] });
      },
    },
    {
      name: 'deposit',
      data: new SlashCommandBuilder()
        .setName('deposit')
        .setDescription('🏦 Deposit coins into your bank')
        .addIntegerOption(opt => opt.setName('amount').setDescription('Amount (0 = all)').setRequired(true).setMinValue(0)),
      execute: async (i) => {
        const guildId = i.guildId;
        const userId = i.user.id;
        ensureUser(guildId, userId);
        const currency = getCurrency(guildId, getGuildSettings(guildId).currency_id);
        const wallet = getWallet(guildId, userId, currency.currency_id);
        let amount = getIntOption(i.options, 'amount');
        if (amount === 0) amount = wallet.balance;
        if (amount <= 0 || amount > wallet.balance) {
          return i.editReply({ embeds: [baseEmbed('❌ Invalid', `You only have ${moneyStr(wallet.balance, currency)} in your wallet.`, Colors.Red)] });
        }
        addBalance(guildId, userId, -amount, currency.currency_id, 'deposit', '');
        addBank(guildId, userId, amount, currency.currency_id, 'deposit', '');
        const w = getWallet(guildId, userId, currency.currency_id);
        await i.editReply({ embeds: [baseEmbed('🏦 Deposited',
          `Deposited ${moneyStr(amount, currency)}\n\n💵 Wallet: ${moneyStr(w.balance, currency)}\n🏦 Bank: ${moneyStr(w.bank, currency)}`,
          Colors.Green)] });
      },
    },
    {
      name: 'withdraw',
      data: new SlashCommandBuilder()
        .setName('withdraw')
        .setDescription('💵 Withdraw coins from your bank')
        .addIntegerOption(opt => opt.setName('amount').setDescription('Amount (0 = all)').setRequired(true).setMinValue(0)),
      execute: async (i) => {
        const guildId = i.guildId;
        const userId = i.user.id;
        ensureUser(guildId, userId);
        const currency = getCurrency(guildId, getGuildSettings(guildId).currency_id);
        const wallet = getWallet(guildId, userId, currency.currency_id);
        let amount = getIntOption(i.options, 'amount');
        if (amount === 0) amount = wallet.bank;
        if (amount <= 0 || amount > wallet.bank) {
          return i.editReply({ embeds: [baseEmbed('❌ Invalid', `You only have ${moneyStr(wallet.bank, currency)} in your bank.`, Colors.Red)] });
        }
        addBank(guildId, userId, -amount, currency.currency_id, 'withdraw', '');
        addBalance(guildId, userId, amount, currency.currency_id, 'withdraw', '');
        const w = getWallet(guildId, userId, currency.currency_id);
        await i.editReply({ embeds: [baseEmbed('💵 Withdrawn',
          `Withdrew ${moneyStr(amount, currency)}\n\n💵 Wallet: ${moneyStr(w.balance, currency)}\n🏦 Bank: ${moneyStr(w.bank, currency)}`,
          Colors.Green)] });
      },
    },
    {
      name: 'stats',
      data: new SlashCommandBuilder()
        .setName('stats')
        .setDescription('📊 View your gambling stats')
        .addUserOption(opt => opt.setName('user').setDescription('User to check')),
      execute: async (i) => {
        const target = i.options.getUser('user') || i.user;
        const guildId = i.guildId;
        const user = getUser(guildId, target.id);
        const s = user.stats;
        const c = getCurrency(guildId, getGuildSettings(guildId).currency_id);
        const e = baseEmbed('📊 Stats', `${userTag(target)}'s statistics`)
          .addFields(
            { name: '🎮 Games', value: formatNumber(s.games_played || 0), inline: true },
            { name: '✅ Wins', value: formatNumber(s.wins || 0), inline: true },
            { name: '❌ Losses', value: formatNumber(s.losses || 0), inline: true },
            { name: '💰 Total Bet', value: moneyStr(s.bet_total || 0, c), inline: true },
            { name: '🏆 Best Win', value: moneyStr(s.biggest_win || 0, c), inline: true },
            { name: '💔 Worst Loss', value: moneyStr(s.biggest_loss || 0, c), inline: true },
          );
        await i.editReply({ embeds: [e] });
      },
    },
    {
      name: 'leaderboard',
      data: new SlashCommandBuilder()
        .setName('leaderboard')
        .setDescription('🏆 View the top players'),
      execute: async (i) => {
        const guildId = i.guildId;
        const c = getCurrency(guildId, getGuildSettings(guildId).currency_id);
        const rows = db.prepare(
          `SELECT w.user_id, w.balance, w.bank, u.level FROM wallets w
           JOIN users u ON u.guild_id = w.guild_id AND u.user_id = w.user_id
           WHERE w.guild_id = ? AND w.currency_id = ?
           ORDER BY (w.balance + w.bank) DESC LIMIT 10`
        ).all(guildId, c.currency_id);

        const medals = ['🥇', '🥈', '🥉'];
        const lines = rows.map((row, idx) => {
          const medal = medals[idx] || `\`${idx + 1}.\``;
          return `${medal} <@${row.user_id}> — ${moneyStr(row.balance + row.bank, c)} (Lv.${row.level})`;
        });

        const e = baseEmbed('🏆 Leaderboard', lines.join('\n') || 'No players yet!');
        await i.editReply({ embeds: [e] });
      },
    },
    {
      name: 'help',
      data: new SlashCommandBuilder()
        .setName('help')
        .setDescription('📖 List all commands'),
      execute: async (i) => {
        const e = baseEmbed('📖 Casino Bot — Commands', '', Colors.Gold)
          .addFields(
            { name: '🎰 Casino Games', value: '`/flip` `/dice` `/slots` `/blackjack` `/crash` `/wheel` `/treasure` `/higher` `/rps` `/limbo` `/lucky` `/scratch` `/lottery`' },
            { name: '💰 Economy', value: '`/balance` `/daily` `/deposit` `/withdraw` `/stats` `/leaderboard`' },
            { name: '🛠️ Admin', value: '`/admin_give` `/admin_remove` `/admin_set` `/admin_settings`' },
          )
          .setFooter({ text: '🪙 Fake economy only — no real money' });
        await i.editReply({ embeds: [e] });
      },
    },

    // ── Admin Commands ──
    {
      name: 'admin_give',
      data: new SlashCommandBuilder()
        .setName('admin_give')
        .setDescription('💸 Give currency to a user')
        .addUserOption(opt => opt.setName('user').setDescription('User').setRequired(true))
        .addIntegerOption(opt => opt.setName('amount').setDescription('Amount').setRequired(true)),
      execute: async (i) => {
        if (!isAdmin(i)) return i.editReply({ content: '❌ Not an admin' });
        const target = i.options.getUser('user');
        const amount = getIntOption(i.options, 'amount');
        const guildId = i.guildId;
        const c = getCurrency(guildId, getGuildSettings(guildId).currency_id);
        ensureUser(guildId, target.id);
        addBalance(guildId, target.id, amount, c.currency_id, 'admin_give', `By ${i.user.tag}`);
        logAudit(guildId, i.user.id, 'admin_give', target.id, `${amount}`);
        await i.editReply({ embeds: [baseEmbed('✅ Sent', `Gave ${moneyStr(amount, c)} to ${userTag(target)}`, Colors.Green)] });
      },
    },
    {
      name: 'admin_remove',
      data: new SlashCommandBuilder()
        .setName('admin_remove')
        .setDescription('🗑️ Remove currency from a user')
        .addUserOption(opt => opt.setName('user').setDescription('User').setRequired(true))
        .addIntegerOption(opt => opt.setName('amount').setDescription('Amount').setRequired(true)),
      execute: async (i) => {
        if (!isAdmin(i)) return i.editReply({ content: '❌ Not an admin' });
        const target = i.options.getUser('user');
        const amount = getIntOption(i.options, 'amount');
        const guildId = i.guildId;
        const c = getCurrency(guildId, getGuildSettings(guildId).currency_id);
        addBalance(guildId, target.id, -amount, c.currency_id, 'admin_remove', `By ${i.user.tag}`);
        logAudit(guildId, i.user.id, 'admin_remove', target.id, `${amount}`);
        await i.editReply({ embeds: [baseEmbed('✅ Removed', `Removed ${moneyStr(amount, c)} from ${userTag(target)}`, Colors.Green)] });
      },
    },
    {
      name: 'admin_set',
      data: new SlashCommandBuilder()
        .setName('admin_set')
        .setDescription('⚙️ Set a user\'s balance')
        .addUserOption(opt => opt.setName('user').setDescription('User').setRequired(true))
        .addIntegerOption(opt => opt.setName('amount').setDescription('New balance').setRequired(true)),
      execute: async (i) => {
        if (!isAdmin(i)) return i.editReply({ content: '❌ Not an admin' });
        const target = i.options.getUser('user');
        const amount = getIntOption(i.options, 'amount');
        const guildId = i.guildId;
        const c = getCurrency(guildId, getGuildSettings(guildId).currency_id);
        ensureUser(guildId, target.id);
        setBalance(guildId, target.id, amount, c.currency_id);
        logAudit(guildId, i.user.id, 'admin_set', target.id, `${amount}`);
        await i.editReply({ embeds: [baseEmbed('✅ Set', `Balance set to ${moneyStr(amount, c)} for ${userTag(target)}`, Colors.Green)] });
      },
    },
    {
      name: 'admin_settings',
      data: new SlashCommandBuilder()
        .setName('admin_settings')
        .setDescription('⚙️ Server economy settings')
        .addSubcommand(sub => sub.setName('view').setDescription('View current settings'))
        .addSubcommand(sub => sub.setName('houseedge').setDescription('Set house edge').addNumberOption(opt => opt.setName('value').setRequired(true).setMinValue(0).setMaxValue(1)))
        .addSubcommand(sub => sub.setName('multiplier').setDescription('Set payout multiplier').addNumberOption(opt => opt.setName('value').setRequired(true).setMinValue(0.1).setMaxValue(10))),
      execute: async (i) => {
        if (!isAdmin(i)) return i.editReply({ content: '❌ Not an admin' });
        const guildId = i.guildId;
        const sub = i.options.getSubcommand();

        if (sub === 'view') {
          const s = getGuildSettings(guildId);
          return i.editReply({ embeds: [baseEmbed('⚙️ Settings',
            `**Economy:** ${s.economy_name}\n**House Edge:** ${(s.house_edge * 100).toFixed(1)}%\n**Multiplier:** ${s.payout_multiplier}x`)] });
        }
        if (sub === 'houseedge') {
          const value = i.options.getNumber('value');
          const s = getGuildSettings(guildId);
          stmt.setGuild.run({ guild_id: guildId, economy_name: s.economy_name, currency_id: s.currency_id, house_edge: value, payout_multiplier: s.payout_multiplier, locale: 'en' });
          logAudit(guildId, i.user.id, 'set_house_edge', null, `${value}`);
          return i.editReply({ content: `✅ House edge → ${(value * 100).toFixed(1)}%` });
        }
        if (sub === 'multiplier') {
          const value = i.options.getNumber('value');
          const s = getGuildSettings(guildId);
          stmt.setGuild.run({ guild_id: guildId, economy_name: s.economy_name, currency_id: s.currency_id, house_edge: s.house_edge, payout_multiplier: value, locale: 'en' });
          logAudit(guildId, i.user.id, 'set_multiplier', null, `${value}`);
          return i.editReply({ content: `✅ Payout multiplier → ${value}x` });
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

