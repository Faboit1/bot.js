// Premium Casino Bot (bot2.js) — Canvas-rendered card games, plinko, roulette, mines & more
// No manual install needed — auto-installs and auto-rebuilds everything.
// Create discord.env with DISCORD_TOKEN, CLIENT_ID, GUILD_ID and run: node bot2.js

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
  AttachmentBuilder,
  Events,
  Colors,
  PermissionsBitField,
  REST,
  Routes,
  ComponentType,
} = require('discord.js');

function loadEnv(filePath) {
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

loadEnv(path.join(__dirname, 'discord.env'));

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID || null;
const ADMIN_ROLE_IDS = new Set((process.env.ADMIN_ROLE_IDS || '').split(',').map((v) => v.trim()).filter(Boolean));

if (!TOKEN || !CLIENT_ID) {
  console.error('Missing DISCORD_TOKEN or CLIENT_ID in discord.env');
  process.exit(1);
}

const db = new Database(path.join(__dirname, 'economy2.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.exec(`
CREATE TABLE IF NOT EXISTS guild_settings (
  guild_id TEXT PRIMARY KEY,
  economy_name TEXT DEFAULT 'Chips',
  currency_symbol TEXT DEFAULT '💠',
  daily_base INTEGER DEFAULT 1200,
  created_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS users (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  balance INTEGER DEFAULT 5000,
  bank INTEGER DEFAULT 0,
  xp INTEGER DEFAULT 0,
  total_xp INTEGER DEFAULT 0,
  level INTEGER DEFAULT 1,
  daily_streak INTEGER DEFAULT 0,
  last_daily INTEGER DEFAULT 0,
  games_played INTEGER DEFAULT 0,
  wins INTEGER DEFAULT 0,
  losses INTEGER DEFAULT 0,
  pushes INTEGER DEFAULT 0,
  total_wagered INTEGER DEFAULT 0,
  total_won INTEGER DEFAULT 0,
  total_lost INTEGER DEFAULT 0,
  biggest_win INTEGER DEFAULT 0,
  biggest_loss INTEGER DEFAULT 0,
  achievements_json TEXT DEFAULT '[]',
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch()),
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  amount INTEGER NOT NULL,
  details TEXT DEFAULT '',
  created_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS admin_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  actor_id TEXT,
  target_id TEXT,
  action TEXT NOT NULL,
  details TEXT DEFAULT '',
  created_at INTEGER DEFAULT (unixepoch())
);
`);

const stmt = {
  ensureGuild: db.prepare(`INSERT INTO guild_settings (guild_id) VALUES (?) ON CONFLICT(guild_id) DO NOTHING`),
  getGuild: db.prepare(`SELECT * FROM guild_settings WHERE guild_id = ?`),
  ensureUser: db.prepare(`INSERT INTO users (guild_id, user_id) VALUES (?, ?) ON CONFLICT(guild_id, user_id) DO NOTHING`),
  getUser: db.prepare(`SELECT * FROM users WHERE guild_id = ? AND user_id = ?`),
  updateUser: db.prepare(`
    UPDATE users SET
      balance=@balance,
      bank=@bank,
      xp=@xp,
      total_xp=@total_xp,
      level=@level,
      daily_streak=@daily_streak,
      last_daily=@last_daily,
      games_played=@games_played,
      wins=@wins,
      losses=@losses,
      pushes=@pushes,
      total_wagered=@total_wagered,
      total_won=@total_won,
      total_lost=@total_lost,
      biggest_win=@biggest_win,
      biggest_loss=@biggest_loss,
      achievements_json=@achievements_json,
      updated_at=unixepoch()
    WHERE guild_id=@guild_id AND user_id=@user_id
  `),
  addTransaction: db.prepare(`INSERT INTO transactions (guild_id, user_id, type, amount, details) VALUES (?, ?, ?, ?, ?)`),
  addAdminLog: db.prepare(`INSERT INTO admin_logs (guild_id, actor_id, target_id, action, details) VALUES (?, ?, ?, ?, ?)`),
  topUsers: db.prepare(`
    SELECT *,(balance + bank) AS net_worth FROM users
    WHERE guild_id = ?
    ORDER BY net_worth DESC, total_won DESC, total_xp DESC
    LIMIT 10
  `),
};

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  partials: [Partials.Channel],
});

client.commands = new Collection();
client.activeGames = new Collection();

const now = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const choice = (arr) => arr[rand(0, arr.length - 1)];
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const formatNumber = (n) => new Intl.NumberFormat('en-US').format(Math.floor(Number(n || 0)));
const chance = (n) => Math.random() < n;

const SUITS = [
  { symbol: '♠', color: '#111111', name: 'spades' },
  { symbol: '♥', color: '#e63946', name: 'hearts' },
  { symbol: '♦', color: '#e63946', name: 'diamonds' },
  { symbol: '♣', color: '#111111', name: 'clubs' },
];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const ROULETTE_RED = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
const SLOT_SYMBOLS = ['cherry', 'lemon', 'bar', 'seven', 'diamond', 'bell'];
const MINES_GRID = 5;

function getGuildSettings(guildId) {
  stmt.ensureGuild.run(guildId);
  return stmt.getGuild.get(guildId);
}

function parseAchievements(input) {
  try {
    const parsed = JSON.parse(input || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function getUser(guildId, userId) {
  getGuildSettings(guildId);
  stmt.ensureUser.run(guildId, userId);
  const row = stmt.getUser.get(guildId, userId);
  return { ...row, achievements: parseAchievements(row.achievements_json) };
}

function saveUser(user) {
  stmt.updateUser.run({
    ...user,
    achievements_json: JSON.stringify(user.achievements || []),
  });
}

function money(amount, guildId) {
  const settings = getGuildSettings(guildId);
  return `${settings.currency_symbol}${formatNumber(amount)}`;
}

function addTransaction(guildId, userId, type, amount, details = '') {
  stmt.addTransaction.run(guildId, userId, type, Math.floor(amount), details);
}

function adjustBalance(guildId, userId, delta, type = 'adjust', details = '') {
  const user = getUser(guildId, userId);
  user.balance = Math.max(0, user.balance + Math.floor(delta));
  saveUser(user);
  addTransaction(guildId, userId, type, delta, details);
  return user;
}

function adjustBank(guildId, userId, delta, type = 'bank', details = '') {
  const user = getUser(guildId, userId);
  user.bank = Math.max(0, user.bank + Math.floor(delta));
  saveUser(user);
  addTransaction(guildId, userId, type, delta, details);
  return user;
}

function xpForLevel(level) {
  return 125 + ((level - 1) * 75);
}

function awardXp(guildId, userId, amount) {
  const user = getUser(guildId, userId);
  user.xp += amount;
  user.total_xp += amount;
  const unlocked = [];
  while (user.xp >= xpForLevel(user.level)) {
    user.xp -= xpForLevel(user.level);
    user.level += 1;
    unlocked.push(`Level ${user.level}`);
  }
  saveUser(user);
  if (user.level >= 5) grantAchievement(guildId, userId, 'vip grinder');
  if (user.level >= 10) grantAchievement(guildId, userId, 'casino elite');
  return { user, unlocked };
}

function grantAchievement(guildId, userId, achievement) {
  const user = getUser(guildId, userId);
  if (user.achievements.includes(achievement)) return false;
  user.achievements.push(achievement);
  saveUser(user);
  return true;
}

function applyGameStats(guildId, userId, bet, payout, gameId) {
  const user = getUser(guildId, userId);
  const profit = payout - bet;
  user.games_played += 1;
  user.total_wagered += bet;
  if (profit > 0) {
    user.wins += 1;
    user.total_won += profit;
    user.biggest_win = Math.max(user.biggest_win, profit);
  } else if (profit < 0) {
    user.losses += 1;
    user.total_lost += Math.abs(profit);
    user.biggest_loss = Math.max(user.biggest_loss, Math.abs(profit));
  } else {
    user.pushes += 1;
  }
  saveUser(user);
  awardXp(guildId, userId, Math.max(12, Math.min(240, Math.floor(bet / 12) + (profit > 0 ? 35 : 10))));
  if (user.total_wagered + bet >= 50000) grantAchievement(guildId, userId, 'high roller');
  if (gameId === 'blackjack' && payout >= Math.floor(bet * 2.5)) grantAchievement(guildId, userId, 'blackjack natural');
  if (gameId === 'slots' && payout >= bet * 10) grantAchievement(guildId, userId, 'jackpot fever');
  if (gameId === 'roulette' && payout >= bet * 20) grantAchievement(guildId, userId, 'number sniper');
  if (gameId === 'crash' && payout >= bet * 4) grantAchievement(guildId, userId, 'perfect timing');
}

function isAdmin(interaction) {
  if (interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) return true;
  const roles = interaction.member?.roles?.cache;
  if (!roles) return false;
  for (const id of ADMIN_ROLE_IDS) {
    if (roles.has(id)) return true;
  }
  return false;
}

function themedEmbed(title, description, color = Colors.Blurple) {
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(color)
    .setTimestamp();
}

function attachmentPayload(buffer, embed, components = [], fileName = 'casino.png') {
  const cloned = EmbedBuilder.from(embed).setImage(`attachment://${fileName}`);
  return {
    embeds: [cloned],
    files: [new AttachmentBuilder(buffer, { name: fileName })],
    components,
  };
}

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function casinoBackdrop(ctx, width, height, accent = '#17c964') {
  const bg = ctx.createLinearGradient(0, 0, width, height);
  bg.addColorStop(0, '#08131f');
  bg.addColorStop(0.5, '#10233b');
  bg.addColorStop(1, '#05080d');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  for (let i = 0; i < 30; i++) {
    const x = Math.random() * width;
    const y = Math.random() * height;
    const r = Math.random() * 2 + 0.5;
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.strokeStyle = `${accent}44`;
  ctx.lineWidth = 2;
  roundRect(ctx, 12, 12, width - 24, height - 24, 24);
  ctx.stroke();
}

function glowText(ctx, text, x, y, color = '#ffffff', font = 'bold 28px Sans') {
  ctx.save();
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 14;
  ctx.textAlign = 'center';
  ctx.fillText(text, x, y);
  ctx.restore();
}

function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ rank, suit: suit.symbol, suitColor: suit.color, value: rank === 'A' ? 11 : ['K', 'Q', 'J'].includes(rank) ? 10 : Number(rank) });
    }
  }
  for (let i = deck.length - 1; i > 0; i--) {
    const j = rand(0, i);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function cardPoints(card) {
  if (!card) return 0;
  return card.rank === 'A' ? 11 : ['K', 'Q', 'J'].includes(card.rank) ? 10 : Number(card.rank);
}

function handValue(hand) {
  let total = hand.reduce((sum, card) => sum + cardPoints(card), 0);
  let aces = hand.filter((card) => card.rank === 'A').length;
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  return {
    total,
    soft: hand.some((card) => card.rank === 'A') && total <= 21,
    blackjack: hand.length === 2 && total === 21,
  };
}

function canSplit(hand) {
  return hand.cards.length === 2 && cardPoints(hand.cards[0]) === cardPoints(hand.cards[1]);
}

function drawCardFace(ctx, card, x, y, w, h) {
  roundRect(ctx, x, y, w, h, 14);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.strokeStyle = '#d7dde6';
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = card.suitColor;
  ctx.font = 'bold 22px Sans';
  ctx.textAlign = 'left';
  ctx.fillText(card.rank, x + 10, y + 24);
  ctx.font = '22px Sans';
  ctx.fillText(card.suit, x + 10, y + 48);

  ctx.textAlign = 'right';
  ctx.font = 'bold 22px Sans';
  ctx.fillText(card.rank, x + w - 10, y + h - 24);
  ctx.font = '22px Sans';
  ctx.fillText(card.suit, x + w - 10, y + h - 48);

  ctx.textAlign = 'center';
  ctx.font = 'bold 40px Sans';
  ctx.fillText(card.suit, x + w / 2, y + h / 2 + 12);
}

function drawCardBack(ctx, x, y, w, h) {
  const back = ctx.createLinearGradient(x, y, x + w, y + h);
  back.addColorStop(0, '#1d4ed8');
  back.addColorStop(1, '#172554');
  roundRect(ctx, x, y, w, h, 14);
  ctx.fillStyle = back;
  ctx.fill();
  ctx.strokeStyle = '#93c5fd';
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  for (let iy = 10; iy < h; iy += 12) {
    ctx.beginPath();
    ctx.moveTo(x + 10, y + iy);
    ctx.lineTo(x + w - 10, y + iy);
    ctx.stroke();
  }

  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.font = 'bold 28px Sans';
  ctx.textAlign = 'center';
  ctx.fillText('✦', x + w / 2, y + h / 2 + 10);
}

function drawCard(ctx, card, x, y, opts = {}) {
  const w = opts.w || 72;
  const h = opts.h || 104;
  const reveal = clamp(opts.reveal ?? 1, 0, 1);
  const glow = opts.glow || false;
  const scale = reveal < 0.5 ? Math.max(0.05, 1 - (reveal * 2)) : Math.max(0.05, (reveal - 0.5) * 2);
  const showFront = reveal >= 0.5 && !opts.hidden;

  ctx.save();
  ctx.translate(x + w / 2, y + h / 2);
  ctx.scale(scale, 1);
  ctx.translate(-(x + w / 2), -(y + h / 2));

  if (glow) {
    ctx.shadowColor = '#facc15';
    ctx.shadowBlur = 20;
  }

  if (showFront) drawCardFace(ctx, card, x, y, w, h);
  else drawCardBack(ctx, x, y, w, h);
  ctx.restore();
}

function drawBlackjackCanvas(state, options = {}) {
  const width = 1040;
  const height = 660;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  casinoBackdrop(ctx, width, height, '#22c55e');

  const felt = ctx.createLinearGradient(0, 90, 0, height);
  felt.addColorStop(0, '#0d5b34');
  felt.addColorStop(1, '#06351e');
  roundRect(ctx, 40, 80, width - 80, height - 120, 36);
  ctx.fillStyle = felt;
  ctx.fill();
  ctx.strokeStyle = '#d4af37';
  ctx.lineWidth = 4;
  ctx.stroke();

  glowText(ctx, 'PREMIUM BLACKJACK', width / 2, 56, '#f8d04f', 'bold 34px Sans');
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.font = '22px Sans';
  ctx.textAlign = 'center';
  ctx.fillText(`Bet ${money(state.baseBet, state.guildId)} • Dealer stands on 17 • Blackjack pays 3:2`, width / 2, 110);

  const dealerValue = handValue(state.dealer);
  const showDealer = options.revealDealer || state.resolved;
  glowText(ctx, `Dealer ${showDealer ? `• ${dealerValue.total}` : ''}`, width / 2, 150, '#ffffff', 'bold 28px Sans');

  const dealerStartX = Math.max(140, width / 2 - ((state.dealer.length - 1) * 42) - 36);
  state.dealer.forEach((card, index) => {
    const reveal = index === 1 && !showDealer ? 0 : index === 1 && typeof options.dealerRevealProgress === 'number' ? options.dealerRevealProgress : 1;
    drawCard(ctx, card, dealerStartX + index * 46, 185, {
      hidden: index === 1 && !showDealer && typeof options.dealerRevealProgress !== 'number',
      reveal,
      glow: showDealer && index === 1,
    });
  });

  ctx.fillStyle = 'rgba(255,255,255,0.88)';
  ctx.font = '20px Sans';
  ctx.textAlign = 'left';
  ctx.fillText(`Insurance ${state.insuranceTaken ? `ON • ${money(state.insuranceBet, state.guildId)}` : 'available'}`, 70, 182);

  const handCount = state.playerHands.length;
  const handWidth = handCount === 1 ? 520 : 430;
  state.playerHands.forEach((hand, handIndex) => {
    const startX = handCount === 1 ? 260 : handIndex === 0 ? 90 : 520;
    const y = 430;
    roundRect(ctx, startX - 35, 360, handWidth, 220, 28);
    ctx.fillStyle = handIndex === state.activeHand && !state.resolved ? 'rgba(250,204,21,0.16)' : 'rgba(255,255,255,0.06)';
    ctx.fill();
    ctx.strokeStyle = handIndex === state.activeHand && !state.resolved ? '#facc15' : 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 2;
    ctx.stroke();

    const hv = handValue(hand.cards);
    const status = hand.busted ? 'BUST' : hand.stood ? 'STAND' : hand.resultLabel || 'LIVE';
    glowText(ctx, `Player ${handCount > 1 ? handIndex + 1 : ''} • ${hv.total} • ${status}`.trim(), startX + (handWidth / 2) - 35, 392, handIndex === state.activeHand && !state.resolved ? '#facc15' : '#ffffff', 'bold 24px Sans');
    ctx.font = '18px Sans';
    ctx.fillStyle = 'rgba(255,255,255,0.88)';
    ctx.textAlign = 'center';
    ctx.fillText(`Wager ${money(hand.bet, state.guildId)}${hand.doubled ? ' • doubled' : ''}`, startX + (handWidth / 2) - 35, 420);

    hand.cards.forEach((card, index) => {
      drawCard(ctx, card, startX + index * 52, y, { glow: hand.resultLabel === 'WIN' || hand.resultLabel === 'BLACKJACK' });
    });
  });

  if (options.bannerText || state.bannerText) {
    roundRect(ctx, 300, 290, 440, 64, 18);
    ctx.fillStyle = 'rgba(8,15,25,0.88)';
    ctx.fill();
    ctx.strokeStyle = options.bannerColor || state.bannerColor || '#facc15';
    ctx.lineWidth = 3;
    ctx.stroke();
    glowText(ctx, options.bannerText || state.bannerText, width / 2, 332, options.bannerColor || state.bannerColor || '#facc15', 'bold 30px Sans');
  }

  ctx.fillStyle = 'rgba(255,255,255,0.72)';
  ctx.font = '18px Sans';
  ctx.textAlign = 'right';
  ctx.fillText(`Wallet ${money(getUser(state.guildId, state.userId).balance, state.guildId)}`, width - 60, height - 28);
  return canvas.toBuffer('image/png');
}

function buildBlackjackRows(state) {
  const current = state.playerHands[state.activeHand];
  const user = getUser(state.guildId, state.userId);
  const canDouble = !state.resolved && current && current.cards.length === 2 && !current.doubled && user.balance >= current.bet;
  const canSplitNow = !state.resolved && state.playerHands.length === 1 && current && canSplit(current) && user.balance >= current.bet;
  const canInsurance = !state.resolved && state.insuranceAvailable && !state.insuranceTaken && getUser(state.guildId, state.userId).balance >= Math.floor(state.baseBet / 2);

  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`bj_hit:${state.id}`).setLabel('Hit').setStyle(ButtonStyle.Primary).setDisabled(state.resolved),
      new ButtonBuilder().setCustomId(`bj_stand:${state.id}`).setLabel('Stand').setStyle(ButtonStyle.Secondary).setDisabled(state.resolved),
      new ButtonBuilder().setCustomId(`bj_double:${state.id}`).setLabel('Double Down').setStyle(ButtonStyle.Success).setDisabled(!canDouble),
      new ButtonBuilder().setCustomId(`bj_split:${state.id}`).setLabel('Split').setStyle(ButtonStyle.Primary).setDisabled(!canSplitNow),
      new ButtonBuilder().setCustomId(`bj_insure:${state.id}`).setLabel(canInsurance ? `Insurance ${money(Math.floor(state.baseBet / 2), state.guildId)}` : 'Insurance').setStyle(ButtonStyle.Danger).setDisabled(!canInsurance),
    ),
  ];
}

async function animateBlackjackReveal(message, state, embed) {
  const frames = [0, 0.2, 0.4, 0.6, 0.8, 1];
  for (const progress of frames) {
    const buffer = drawBlackjackCanvas(state, { revealDealer: progress >= 1, dealerRevealProgress: progress, bannerText: 'Dealer reveals...' });
    await message.edit(attachmentPayload(buffer, embed, buildBlackjackRows({ ...state, resolved: true })));
    await sleep(120);
  }
}

function drawPlinkoCanvas(game, step = game.path.length - 1, landed = false) {
  const width = 860;
  const height = 700;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  casinoBackdrop(ctx, width, height, '#38bdf8');
  glowText(ctx, `PLINKO • ${game.risk.toUpperCase()} RISK`, width / 2, 56, '#7dd3fc', 'bold 34px Sans');
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.font = '22px Sans';
  ctx.textAlign = 'center';
  ctx.fillText(`Bet ${money(game.bet, game.guildId)} • multipliers loaded • path highlighted`, width / 2, 92);

  const topX = width / 2;
  const topY = 130;
  const gapX = 56;
  const gapY = 54;
  const rows = game.rows;
  const points = [];

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col <= row; col++) {
      const x = topX - (row * gapX / 2) + (col * gapX);
      const y = topY + row * gapY;
      points.push({ row, col, x, y });
      ctx.beginPath();
      ctx.arc(x, y, 8, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.82)';
      ctx.fill();
    }
  }

  ctx.lineWidth = 4;
  ctx.strokeStyle = '#7dd3fc';
  ctx.beginPath();
  game.path.slice(0, step + 1).forEach((pt, index) => {
    if (index === 0) ctx.moveTo(pt.x, pt.y - 28);
    ctx.lineTo(pt.x, pt.y);
  });
  ctx.stroke();

  const multipliers = game.multipliers;
  const slotY = topY + rows * gapY + 36;
  const baseX = topX - ((multipliers.length - 1) * gapX / 2);
  multipliers.forEach((mult, index) => {
    const slotX = baseX + index * gapX - 22;
    const hue = mult >= 5 ? '#22c55e' : mult >= 1 ? '#facc15' : '#ef4444';
    roundRect(ctx, slotX, slotY, 44, 64, 12);
    ctx.fillStyle = hue;
    ctx.globalAlpha = landed && index === game.slotIndex ? 1 : 0.78;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = landed && index === game.slotIndex ? '#ffffff' : 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = '#07111c';
    ctx.font = 'bold 16px Sans';
    ctx.textAlign = 'center';
    ctx.fillText(`${mult}x`, slotX + 22, slotY + 38);
  });

  const ball = game.path[Math.min(step, game.path.length - 1)];
  ctx.save();
  ctx.shadowColor = '#facc15';
  ctx.shadowBlur = 18;
  ctx.fillStyle = '#fde047';
  ctx.beginPath();
  ctx.arc(ball.x, ball.y - (landed ? 0 : 10), 11, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  if (landed) {
    glowText(ctx, `LANDED ${game.payoutMultiplier}x • ${money(game.payout, game.guildId)}`, width / 2, height - 42, game.payout > game.bet ? '#4ade80' : game.payout === game.bet ? '#facc15' : '#f87171', 'bold 30px Sans');
  }

  return canvas.toBuffer('image/png');
}

function getPlinkoProfile(risk) {
  if (risk === 'high') return { multipliers: [0, 0.2, 0.5, 1, 5, 1, 0.5, 0.2, 0], rows: 8 };
  if (risk === 'medium') return { multipliers: [0.2, 0.5, 0.9, 1.4, 2.5, 1.4, 0.9, 0.5, 0.2], rows: 8 };
  return { multipliers: [0.5, 0.8, 1, 1.2, 1.6, 1.2, 1, 0.8, 0.5], rows: 8 };
}

function simulatePlinko(guildId, bet, risk) {
  const profile = getPlinkoProfile(risk);
  const path = [];
  let slotIndex = Math.floor(profile.multipliers.length / 2);
  const topX = 860 / 2;
  const topY = 130;
  const gapX = 56;
  const gapY = 54;

  for (let row = 0; row < profile.rows; row++) {
    const move = Math.random() < 0.5 ? -1 : 1;
    slotIndex += move;
    slotIndex = clamp(slotIndex, 0, profile.multipliers.length - 1);
    const x = topX - (row * gapX / 2) + (slotIndex * gapX) - (((profile.multipliers.length - 1) - row) * gapX / 2);
    path.push({ x, y: topY + row * gapY });
  }

  const payoutMultiplier = profile.multipliers[slotIndex];
  const payout = Math.floor(bet * payoutMultiplier);
  return { guildId, bet, risk, rows: profile.rows, multipliers: profile.multipliers, slotIndex, payoutMultiplier, payout, path };
}

function rouletteColor(number) {
  if (number === 0) return 'green';
  return ROULETTE_RED.has(number) ? 'red' : 'black';
}

function rouletteOutcome(number, betType, selectedNumber) {
  if (betType === 'single') return number === selectedNumber ? 35 : -1;
  if (betType === 'red') return rouletteColor(number) === 'red' ? 1 : -1;
  if (betType === 'black') return rouletteColor(number) === 'black' ? 1 : -1;
  if (betType === 'odd') return number !== 0 && number % 2 === 1 ? 1 : -1;
  if (betType === 'even') return number !== 0 && number % 2 === 0 ? 1 : -1;
  if (betType === 'low') return number >= 1 && number <= 18 ? 1 : -1;
  if (betType === 'high') return number >= 19 && number <= 36 ? 1 : -1;
  if (betType === 'dozen1') return number >= 1 && number <= 12 ? 2 : -1;
  if (betType === 'dozen2') return number >= 13 && number <= 24 ? 2 : -1;
  if (betType === 'dozen3') return number >= 25 && number <= 36 ? 2 : -1;
  if (betType === 'column1') return number !== 0 && number % 3 === 1 ? 2 : -1;
  if (betType === 'column2') return number !== 0 && number % 3 === 2 ? 2 : -1;
  if (betType === 'column3') return number !== 0 && number % 3 === 0 ? 2 : -1;
  return -1;
}

function drawRouletteCanvas(game, phase = 'final') {
  const width = 1080;
  const height = 680;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  casinoBackdrop(ctx, width, height, '#ef4444');
  glowText(ctx, 'EURO ROYALE ROULETTE', width / 2, 52, '#fda4af', 'bold 34px Sans');

  roundRect(ctx, 40, 96, 640, 540, 28);
  ctx.fillStyle = '#0b4d2e';
  ctx.fill();
  ctx.strokeStyle = '#d4af37';
  ctx.lineWidth = 4;
  ctx.stroke();

  const cellW = 72;
  const cellH = 42;
  roundRect(ctx, 64, 142, 70, cellH * 12, 14);
  ctx.fillStyle = '#166534';
  ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 22px Sans';
  ctx.textAlign = 'center';
  ctx.fillText('0', 99, 404);

  for (let row = 0; row < 12; row++) {
    for (let col = 0; col < 3; col++) {
      const number = row * 3 + (3 - col);
      const x = 144 + col * cellW;
      const y = 142 + row * cellH;
      roundRect(ctx, x, y, cellW - 2, cellH - 2, 8);
      ctx.fillStyle = rouletteColor(number) === 'red' ? '#b91c1c' : '#111827';
      if (game.number === number) ctx.fillStyle = '#facc15';
      ctx.fill();
      ctx.strokeStyle = game.selectedType === 'single' && game.selectedNumber === number ? '#38bdf8' : '#e5e7eb';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = game.number === number ? '#111827' : '#ffffff';
      ctx.font = 'bold 18px Sans';
      ctx.fillText(String(number), x + (cellW / 2) - 1, y + 27);
    }
  }

  const outside = [
    ['1-18', 'low'],
    ['EVEN', 'even'],
    ['RED', 'red'],
    ['BLACK', 'black'],
    ['ODD', 'odd'],
    ['19-36', 'high'],
  ];
  outside.forEach(([label, key], index) => {
    const x = 64 + index * 98;
    const y = 660 - 100;
    roundRect(ctx, x, y, 92, 44, 10);
    ctx.fillStyle = key === 'red' ? '#b91c1c' : key === 'black' ? '#111827' : '#14532d';
    if (game.selectedType === key) ctx.fillStyle = '#0ea5e9';
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 14px Sans';
    ctx.fillText(label, x + 46, y + 28);
  });

  const centerX = 840;
  const centerY = 350;
  const radius = 190;
  for (let i = 0; i <= 36; i++) {
    const angleA = (-Math.PI / 2) + ((i / 37) * Math.PI * 2);
    const angleB = (-Math.PI / 2) + (((i + 1) / 37) * Math.PI * 2);
    ctx.beginPath();
    ctx.moveTo(centerX, centerY);
    ctx.arc(centerX, centerY, radius, angleA, angleB);
    const fill = i === 0 ? '#16a34a' : ROULETTE_RED.has(i) ? '#dc2626' : '#111827';
    ctx.fillStyle = game.number === i ? '#facc15' : fill;
    ctx.fill();
    ctx.strokeStyle = '#f8fafc';
    ctx.lineWidth = 1;
    ctx.stroke();

    const textAngle = (angleA + angleB) / 2;
    const tx = centerX + Math.cos(textAngle) * 145;
    const ty = centerY + Math.sin(textAngle) * 145;
    ctx.fillStyle = game.number === i ? '#111827' : '#ffffff';
    ctx.font = 'bold 14px Sans';
    ctx.fillText(String(i), tx, ty);
  }

  ctx.beginPath();
  ctx.arc(centerX, centerY, 72, 0, Math.PI * 2);
  ctx.fillStyle = '#374151';
  ctx.fill();
  glowText(ctx, String(game.number), centerX, centerY + 10, rouletteColor(game.number) === 'red' ? '#f87171' : rouletteColor(game.number) === 'black' ? '#f8fafc' : '#4ade80', 'bold 42px Sans');

  const ballAngle = phase === 'spin' ? (game.frameAngle ?? 0) : (-Math.PI / 2) + (((game.number + 0.5) / 37) * Math.PI * 2);
  const ballX = centerX + Math.cos(ballAngle) * 210;
  const ballY = centerY + Math.sin(ballAngle) * 210;
  ctx.save();
  ctx.shadowColor = '#ffffff';
  ctx.shadowBlur = 18;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(ballX, ballY, 10, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  const bannerColor = game.multiplier >= 1 ? '#4ade80' : '#f87171';
  glowText(ctx, `${game.multiplier >= 0 ? 'WIN' : 'LOSS'} • ${game.multiplier >= 0 ? `${game.multiplier + 1}:1 return` : 'house takes it'}`, centerX, 608, bannerColor, 'bold 26px Sans');
  ctx.fillStyle = '#ffffff';
  ctx.font = '20px Sans';
  ctx.fillText(`Bet ${game.selectedType === 'single' ? `${game.selectedNumber}` : game.selectedType.toUpperCase()} • Payout ${money(game.payout, game.guildId)}`, centerX, 638);
  return canvas.toBuffer('image/png');
}

function drawSlotSymbol(ctx, symbol, x, y, size) {
  ctx.save();
  ctx.translate(x, y);
  if (symbol === 'cherry') {
    ctx.fillStyle = '#dc2626';
    ctx.beginPath(); ctx.arc(-size * 0.14, size * 0.08, size * 0.16, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(size * 0.14, size * 0.08, size * 0.16, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#16a34a'; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(0, -size * 0.28); ctx.lineTo(-size * 0.08, -size * 0.06); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, -size * 0.28); ctx.lineTo(size * 0.08, -size * 0.06); ctx.stroke();
  } else if (symbol === 'lemon') {
    ctx.fillStyle = '#fde047';
    ctx.beginPath();
    ctx.ellipse(0, 0, size * 0.28, size * 0.2, -0.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#f59e0b'; ctx.lineWidth = 3; ctx.stroke();
  } else if (symbol === 'bar') {
    roundRect(ctx, -size * 0.34, -size * 0.18, size * 0.68, size * 0.36, 8);
    ctx.fillStyle = '#111827';
    ctx.fill();
    ctx.strokeStyle = '#f8fafc';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = '#f8fafc';
    ctx.font = `bold ${Math.floor(size * 0.22)}px Sans`;
    ctx.textAlign = 'center';
    ctx.fillText('BAR', 0, size * 0.08);
  } else if (symbol === 'seven') {
    ctx.fillStyle = '#ef4444';
    ctx.font = `bold ${Math.floor(size * 0.8)}px Sans`;
    ctx.textAlign = 'center';
    ctx.fillText('7', 0, size * 0.28);
  } else if (symbol === 'diamond') {
    ctx.fillStyle = '#38bdf8';
    ctx.beginPath();
    ctx.moveTo(0, -size * 0.34);
    ctx.lineTo(size * 0.24, 0);
    ctx.lineTo(0, size * 0.34);
    ctx.lineTo(-size * 0.24, 0);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#e0f2fe';
    ctx.lineWidth = 3;
    ctx.stroke();
  } else if (symbol === 'bell') {
    ctx.fillStyle = '#f59e0b';
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.24, Math.PI, 0);
    ctx.lineTo(size * 0.2, size * 0.18);
    ctx.lineTo(-size * 0.2, size * 0.18);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#fde68a';
    ctx.beginPath();
    ctx.arc(0, size * 0.2, size * 0.06, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function evaluateSlots(reels) {
  if (reels.every((symbol) => symbol === 'diamond')) return { multiplier: 20, label: 'Diamond Rush' };
  if (reels.every((symbol) => symbol === 'seven')) return { multiplier: 15, label: 'Lucky Sevens' };
  if (reels.every((symbol) => symbol === 'bar')) return { multiplier: 12, label: 'BAR Vault' };
  if (new Set(reels).size === 1) return { multiplier: 6, label: 'Triple Match' };
  if (reels.filter((s) => s === 'cherry').length >= 2) return { multiplier: 2, label: 'Cherry Pair' };
  return { multiplier: 0, label: 'No Line' };
}

function drawSlotsCanvas(game, frame = 0, revealCount = 3) {
  const width = 940;
  const height = 620;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  casinoBackdrop(ctx, width, height, '#facc15');
  glowText(ctx, 'LUXE REELS', width / 2, 58, '#fde68a', 'bold 36px Sans');

  roundRect(ctx, 80, 110, 520, 380, 28);
  const machine = ctx.createLinearGradient(80, 110, 600, 490);
  machine.addColorStop(0, '#6b21a8');
  machine.addColorStop(1, '#1f1147');
  ctx.fillStyle = machine;
  ctx.fill();
  ctx.strokeStyle = '#facc15';
  ctx.lineWidth = 5;
  ctx.stroke();

  const displayY = 190;
  const reelSymbols = [];
  for (let i = 0; i < 3; i++) {
    roundRect(ctx, 125 + i * 150, displayY, 110, 160, 16);
    ctx.fillStyle = '#f8fafc';
    ctx.fill();
    ctx.strokeStyle = '#cbd5e1';
    ctx.lineWidth = 3;
    ctx.stroke();

    if (i < revealCount) {
      reelSymbols[i] = game.reels[i];
      drawSlotSymbol(ctx, game.reels[i], 180 + i * 150, displayY + 82, 92);
    } else {
      ctx.globalAlpha = 0.45;
      for (let b = -1; b <= 1; b++) {
        const symbol = SLOT_SYMBOLS[(frame + i + b + SLOT_SYMBOLS.length) % SLOT_SYMBOLS.length];
        drawSlotSymbol(ctx, symbol, 180 + i * 150, displayY + 82 + (b * 34), 92);
      }
      ctx.globalAlpha = 1;
    }
  }

  ctx.strokeStyle = game.multiplier > 0 && revealCount >= 3 ? '#22c55e' : 'rgba(255,255,255,0.18)';
  ctx.lineWidth = game.multiplier > 0 && revealCount >= 3 ? 6 : 3;
  ctx.shadowColor = game.multiplier > 0 && revealCount >= 3 ? '#4ade80' : 'transparent';
  ctx.shadowBlur = game.multiplier > 0 && revealCount >= 3 ? 18 : 0;
  ctx.beginPath();
  ctx.moveTo(120, displayY + 82);
  ctx.lineTo(470, displayY + 82);
  ctx.stroke();
  ctx.shadowBlur = 0;

  roundRect(ctx, 640, 110, 230, 380, 24);
  ctx.fillStyle = 'rgba(8,15,25,0.88)';
  ctx.fill();
  ctx.strokeStyle = '#facc15';
  ctx.lineWidth = 3;
  ctx.stroke();

  ctx.fillStyle = '#f8fafc';
  ctx.font = 'bold 24px Sans';
  ctx.textAlign = 'center';
  ctx.fillText('PAYTABLE', 755, 148);
  const table = [
    ['💎💎💎', '20x'],
    ['777', '15x'],
    ['BAR BAR BAR', '12x'],
    ['Any Triple', '6x'],
    ['2 Cherries+', '2x'],
  ];
  table.forEach(([label, mult], index) => {
    ctx.fillStyle = index === 0 ? '#4ade80' : '#e5e7eb';
    ctx.font = index === 0 ? 'bold 18px Sans' : '16px Sans';
    ctx.fillText(`${label}  •  ${mult}`, 755, 196 + index * 44);
  });

  glowText(ctx, `${game.label} • ${money(game.payout, game.guildId)}`, width / 2, 548, game.multiplier > 0 ? '#4ade80' : '#f87171', 'bold 30px Sans');
  return canvas.toBuffer('image/png');
}

function calculateMinesMultiplier(reveals, mineCount) {
  if (reveals <= 0) return 1;
  return Number((1 + (reveals * (mineCount * 0.14 + 0.12))).toFixed(2));
}

function drawDiamond(ctx, x, y, size, color = '#4ade80') {
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, y - size / 2);
  ctx.lineTo(x + size / 2, y);
  ctx.lineTo(x, y + size / 2);
  ctx.lineTo(x - size / 2, y);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawBomb(ctx, x, y, size) {
  ctx.save();
  ctx.fillStyle = '#ef4444';
  ctx.beginPath();
  ctx.arc(x, y, size / 2.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#fca5a5';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(x, y - size / 2.5);
  ctx.lineTo(x + 10, y - size / 1.6);
  ctx.stroke();
  ctx.fillStyle = '#facc15';
  ctx.beginPath();
  ctx.arc(x + 12, y - size / 1.6, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawMinesCanvas(state, revealAll = false, explodedAt = -1) {
  const width = 760;
  const height = 840;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  casinoBackdrop(ctx, width, height, '#22c55e');
  glowText(ctx, 'MINES VAULT', width / 2, 58, '#86efac', 'bold 34px Sans');
  ctx.fillStyle = '#ffffff';
  ctx.font = '22px Sans';
  ctx.textAlign = 'center';
  ctx.fillText(`Bet ${money(state.bet, state.guildId)} • Mines ${state.mineCount} • Multiplier ${state.multiplier.toFixed(2)}x`, width / 2, 94);

  const startX = 85;
  const startY = 140;
  const size = 112;
  for (let row = 0; row < MINES_GRID; row++) {
    for (let col = 0; col < MINES_GRID; col++) {
      const index = row * MINES_GRID + col;
      const x = startX + col * 118;
      const y = startY + row * 118;
      roundRect(ctx, x, y, size, size, 18);
      const revealed = state.revealed.has(index);
      const mine = state.mines.has(index);
      if (revealed || (revealAll && mine)) {
        ctx.fillStyle = mine ? '#3f1117' : '#0f3d2e';
      } else {
        ctx.fillStyle = '#16263d';
      }
      if (index === explodedAt) ctx.fillStyle = '#67151d';
      ctx.fill();
      ctx.strokeStyle = revealed ? '#86efac' : 'rgba(255,255,255,0.18)';
      if (mine && (revealed || revealAll)) ctx.strokeStyle = '#fca5a5';
      ctx.lineWidth = 3;
      ctx.stroke();

      if (revealed && !mine) drawDiamond(ctx, x + size / 2, y + size / 2, 42);
      if ((revealed || revealAll) && mine) drawBomb(ctx, x + size / 2, y + size / 2, 46);
      if (!revealed && !(revealAll && mine)) {
        ctx.fillStyle = 'rgba(255,255,255,0.18)';
        ctx.font = 'bold 24px Sans';
        ctx.fillText(String(index + 1), x + size / 2, y + size / 2 + 8);
      }
    }
  }

  glowText(ctx, state.finished ? state.finishText : `Safe picks ${state.revealed.size} • Cashout ${money(Math.floor(state.bet * state.multiplier), state.guildId)}`, width / 2, 792, state.finishColor || '#f8fafc', 'bold 28px Sans');
  return canvas.toBuffer('image/png');
}

function buildMinesRows(state, disabled = false) {
  const rows = [];
  for (let row = 0; row < MINES_GRID; row++) {
    const actionRow = new ActionRowBuilder();
    for (let col = 0; col < MINES_GRID; col++) {
      const index = row * MINES_GRID + col;
      actionRow.addComponents(
        new ButtonBuilder()
          .setCustomId(`mines:${state.id}:${index}`)
          .setLabel(String(index + 1))
          .setStyle(state.revealed.has(index) ? ButtonStyle.Success : ButtonStyle.Secondary)
          .setDisabled(disabled || state.revealed.has(index))
      );
    }
    rows.push(actionRow);
  }
  return rows;
}

function drawCrashCanvas(game, currentMultiplier, status) {
  const width = 980;
  const height = 620;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  casinoBackdrop(ctx, width, height, '#22c55e');
  glowText(ctx, 'CRASH LIVE', width / 2, 56, '#86efac', 'bold 34px Sans');

  const graph = { x: 82, y: 96, w: 820, h: 420 };
  roundRect(ctx, graph.x, graph.y, graph.w, graph.h, 26);
  ctx.fillStyle = '#08131f';
  ctx.fill();
  ctx.strokeStyle = '#134e4a';
  ctx.lineWidth = 3;
  ctx.stroke();

  ctx.strokeStyle = 'rgba(255,255,255,0.09)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 8; i++) {
    const x = graph.x + (graph.w / 8) * i;
    ctx.beginPath();
    ctx.moveTo(x, graph.y);
    ctx.lineTo(x, graph.y + graph.h);
    ctx.stroke();
  }
  for (let i = 0; i <= 6; i++) {
    const y = graph.y + (graph.h / 6) * i;
    ctx.beginPath();
    ctx.moveTo(graph.x, y);
    ctx.lineTo(graph.x + graph.w, y);
    ctx.stroke();
  }

  const maxMult = Math.max(game.crashPoint, currentMultiplier, game.cashedOutAt || 1);
  const pts = [];
  for (let i = 0; i < game.history.length; i++) {
    const mult = game.history[i];
    const px = graph.x + (i / Math.max(1, game.maxSteps - 1)) * graph.w;
    const py = graph.y + graph.h - ((mult - 1) / Math.max(1, maxMult - 1)) * (graph.h - 20);
    pts.push({ px, py, mult });
  }

  ctx.strokeStyle = status === 'cashed' ? '#22c55e' : status === 'crashed' ? '#ef4444' : '#38bdf8';
  ctx.lineWidth = 4;
  ctx.beginPath();
  pts.forEach((pt, index) => {
    if (index === 0) ctx.moveTo(pt.px, pt.py);
    else ctx.lineTo(pt.px, pt.py);
  });
  ctx.stroke();

  const last = pts[pts.length - 1];
  ctx.save();
  ctx.shadowColor = status === 'crashed' ? '#ef4444' : '#ffffff';
  ctx.shadowBlur = 18;
  ctx.fillStyle = status === 'crashed' ? '#fca5a5' : '#ffffff';
  ctx.beginPath();
  ctx.arc(last.px, last.py, 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  if (status === 'crashed') {
    ctx.save();
    ctx.strokeStyle = '#f87171';
    ctx.lineWidth = 5;
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = (Math.PI * 2 * i) / 8;
      ctx.moveTo(last.px, last.py);
      ctx.lineTo(last.px + Math.cos(a) * 28, last.py + Math.sin(a) * 28);
    }
    ctx.stroke();
    ctx.restore();
  }

  glowText(ctx, `${currentMultiplier.toFixed(2)}x`, width / 2, 560, status === 'crashed' ? '#f87171' : status === 'cashed' ? '#4ade80' : '#e0f2fe', 'bold 38px Sans');
  ctx.fillStyle = '#ffffff';
  ctx.font = '20px Sans';
  ctx.textAlign = 'center';
  ctx.fillText(`Crash point ${game.crashPoint.toFixed(2)}x • Bet ${money(game.bet, game.guildId)} • ${status === 'cashed' ? `Cashed ${money(game.payout, game.guildId)}` : status === 'crashed' ? 'Boom.' : 'Cash out before the explosion.'}`, width / 2, 596);
  return canvas.toBuffer('image/png');
}

function baseGameDescription(interaction, title, summary, color) {
  const user = getUser(interaction.guildId, interaction.user.id);
  return themedEmbed(title, `${summary}\n\nBalance: ${money(user.balance, interaction.guildId)} • Bank: ${money(user.bank, interaction.guildId)} • Level ${user.level}`, color);
}

async function startBlackjack(interaction, bet) {
  const user = getUser(interaction.guildId, interaction.user.id);
  if (user.balance < bet) return interaction.editReply({ content: `You need ${money(bet, interaction.guildId)}.` });

  adjustBalance(interaction.guildId, interaction.user.id, -bet, 'bet', 'blackjack ante');
  const deck = createDeck();
  const state = {
    id: crypto.randomUUID(),
    type: 'blackjack',
    guildId: interaction.guildId,
    userId: interaction.user.id,
    baseBet: bet,
    dealer: [deck.pop(), deck.pop()],
    playerHands: [{ cards: [deck.pop(), deck.pop()], bet, stood: false, busted: false, doubled: false, resultLabel: '' }],
    activeHand: 0,
    insuranceAvailable: false,
    insuranceTaken: false,
    insuranceBet: 0,
    bannerText: 'Place your move',
    bannerColor: '#facc15',
    resolved: false,
    deck,
  };
  state.insuranceAvailable = state.dealer[0].rank === 'A';
  client.activeGames.set(state.id, state);

  const playerHand = handValue(state.playerHands[0].cards);
  const dealerUp = cardPoints(state.dealer[0]);
  const embed = baseGameDescription(interaction, '🃏 Premium Blackjack', `Dealer shows **${state.dealer[0].rank}${state.dealer[0].suit}**.`, Colors.Gold);
  const message = await interaction.editReply(attachmentPayload(drawBlackjackCanvas(state), embed, buildBlackjackRows(state)));

  async function finishBlackjack(reason = 'resolved') {
    if (state.resolved) return;
    state.resolved = true;
    await animateBlackjackReveal(message, state, embed);

    while (handValue(state.dealer).total < 17) state.dealer.push(state.deck.pop());
    const dealerValue = handValue(state.dealer);
    let totalPayout = 0;
    let totalRisk = state.playerHands.reduce((sum, hand) => sum + hand.bet, 0) + state.insuranceBet;

    state.playerHands.forEach((hand) => {
      const hv = handValue(hand.cards);
      if (hv.total > 21) {
        hand.busted = true;
        hand.resultLabel = 'BUST';
        return;
      }
      if (dealerValue.total > 21) {
        const winReturn = hv.blackjack && state.playerHands.length === 1 ? Math.floor(hand.bet * 2.5) : hand.bet * 2;
        totalPayout += winReturn;
        hand.resultLabel = hv.blackjack ? 'BLACKJACK' : 'WIN';
        return;
      }
      if (hv.blackjack && !dealerValue.blackjack && state.playerHands.length === 1) {
        totalPayout += Math.floor(hand.bet * 2.5);
        hand.resultLabel = 'BLACKJACK';
        return;
      }
      if (dealerValue.blackjack && !hv.blackjack) {
        hand.resultLabel = 'LOSE';
        return;
      }
      if (hv.total > dealerValue.total) {
        totalPayout += hand.bet * 2;
        hand.resultLabel = 'WIN';
      } else if (hv.total === dealerValue.total) {
        totalPayout += hand.bet;
        hand.resultLabel = 'PUSH';
      } else {
        hand.resultLabel = 'LOSE';
      }
    });

    if (state.insuranceTaken && dealerValue.blackjack) totalPayout += state.insuranceBet * 3;
    if (totalPayout > 0) adjustBalance(state.guildId, state.userId, totalPayout, 'payout', `blackjack:${reason}`);

    const net = totalPayout - totalRisk;
    state.bannerText = net > 0 ? `YOU WIN ${money(net, state.guildId)}` : net === 0 ? 'PUSH' : `HOUSE WINS ${money(Math.abs(net), state.guildId)}`;
    state.bannerColor = net > 0 ? '#4ade80' : net === 0 ? '#facc15' : '#f87171';
    applyGameStats(state.guildId, state.userId, totalRisk, totalPayout, 'blackjack');
    const finalEmbed = themedEmbed(
      '🃏 Blackjack Result',
      `${state.bannerText}\nDealer: **${dealerValue.total}**\n${state.playerHands.map((hand, index) => `Hand ${index + 1}: **${handValue(hand.cards).total}** • ${hand.resultLabel}`).join('\n')}`,
      net > 0 ? Colors.Green : net === 0 ? Colors.Yellow : Colors.Red,
    );
    await message.edit(attachmentPayload(drawBlackjackCanvas(state, { revealDealer: true }), finalEmbed, buildBlackjackRows(state)));
    client.activeGames.delete(state.id);
  }

  if (dealerUp === 10 && handValue(state.dealer).blackjack) {
    await finishBlackjack('dealer-blackjack');
    return;
  }

  if (playerHand.blackjack) {
    await finishBlackjack('natural');
    return;
  }

  const collector = message.createMessageComponentCollector({ componentType: ComponentType.Button, time: 180000 });
  collector.on('collect', async (btn) => {
    if (btn.user.id !== interaction.user.id) {
      await btn.reply({ ephemeral: true, content: 'This blackjack seat belongs to someone else.' });
      return;
    }
    if (state.resolved) {
      await btn.deferUpdate();
      return;
    }
    await btn.deferUpdate();
    const action = btn.customId.split(':')[0];

    if (state.insuranceAvailable && !state.insuranceTaken && (action !== 'bj_insure')) {
      if (handValue(state.dealer).blackjack) {
        await finishBlackjack('dealer-blackjack');
        collector.stop('resolved');
        return;
      }
      state.insuranceAvailable = false;
    }

    const current = state.playerHands[state.activeHand];
    if (!current) return;

    if (action === 'bj_insure' && state.insuranceAvailable && !state.insuranceTaken) {
      const insuranceBet = Math.floor(state.baseBet / 2);
      const refreshed = getUser(state.guildId, state.userId);
      if (refreshed.balance >= insuranceBet) {
        adjustBalance(state.guildId, state.userId, -insuranceBet, 'bet', 'blackjack insurance');
        state.insuranceTaken = true;
        state.insuranceBet = insuranceBet;
        state.bannerText = 'Insurance placed';
        state.bannerColor = '#60a5fa';
      }
      state.insuranceAvailable = false;
      if (handValue(state.dealer).blackjack) {
        await finishBlackjack('insurance-peek');
        collector.stop('resolved');
        return;
      }
    }

    if (action === 'bj_split' && canSplit(current) && state.playerHands.length === 1) {
      const refreshed = getUser(state.guildId, state.userId);
      if (refreshed.balance >= current.bet) {
        adjustBalance(state.guildId, state.userId, -current.bet, 'bet', 'blackjack split');
        const [c1, c2] = current.cards;
        state.playerHands = [
          { cards: [c1, state.deck.pop()], bet: current.bet, stood: false, busted: false, doubled: false, resultLabel: '' },
          { cards: [c2, state.deck.pop()], bet: current.bet, stood: false, busted: false, doubled: false, resultLabel: '' },
        ];
        state.activeHand = 0;
        state.bannerText = 'Split accepted';
        state.bannerColor = '#60a5fa';
      }
    } else if (action === 'bj_double' && current.cards.length === 2 && !current.doubled) {
      const refreshed = getUser(state.guildId, state.userId);
      if (refreshed.balance >= current.bet) {
        adjustBalance(state.guildId, state.userId, -current.bet, 'bet', 'blackjack double');
        current.bet *= 2;
        current.doubled = true;
        current.cards.push(state.deck.pop());
        if (handValue(current.cards).total > 21) current.busted = true;
        current.stood = true;
      }
    } else if (action === 'bj_hit') {
      current.cards.push(state.deck.pop());
      if (handValue(current.cards).total > 21) {
        current.busted = true;
        current.stood = true;
      }
    } else if (action === 'bj_stand') {
      current.stood = true;
    }

    while (state.playerHands[state.activeHand] && state.playerHands[state.activeHand].stood) state.activeHand += 1;
    if (state.activeHand >= state.playerHands.length) {
      await finishBlackjack('played-out');
      collector.stop('resolved');
      return;
    }

    await message.edit(attachmentPayload(drawBlackjackCanvas(state), embed, buildBlackjackRows(state)));
  });

  collector.on('end', async () => {
    if (!state.resolved) {
      state.playerHands.forEach((hand) => { hand.stood = true; });
      await finishBlackjack('timeout');
    }
  });
}

async function startPlinko(interaction, bet, risk) {
  const user = getUser(interaction.guildId, interaction.user.id);
  if (user.balance < bet) return interaction.editReply({ content: `You need ${money(bet, interaction.guildId)}.` });
  adjustBalance(interaction.guildId, interaction.user.id, -bet, 'bet', `plinko:${risk}`);
  const game = simulatePlinko(interaction.guildId, bet, risk);
  const base = themedEmbed('🟦 Plinko', `Ball loaded. Risk: **${risk}**.`, Colors.Blue);
  const message = await interaction.editReply(attachmentPayload(drawPlinkoCanvas(game, 0, false), base, []));
  for (let step = 1; step < game.path.length; step++) {
    await sleep(300);
    await message.edit(attachmentPayload(drawPlinkoCanvas(game, step, false), base, []));
  }
  await sleep(250);
  if (game.payout > 0) adjustBalance(interaction.guildId, interaction.user.id, game.payout, 'payout', `plinko:${risk}`);
  applyGameStats(interaction.guildId, interaction.user.id, bet, game.payout, 'plinko');
  const embed = themedEmbed('🟦 Plinko Result', `Path complete. Slot multiplier: **${game.payoutMultiplier}x**\nPayout: **${money(game.payout, interaction.guildId)}**`, game.payout > bet ? Colors.Green : game.payout === bet ? Colors.Yellow : Colors.Red);
  await message.edit(attachmentPayload(drawPlinkoCanvas(game, game.path.length - 1, true), embed, []));
}

async function startRoulette(interaction, bet, betType, selectedNumber) {
  const user = getUser(interaction.guildId, interaction.user.id);
  if (user.balance < bet) return interaction.editReply({ content: `You need ${money(bet, interaction.guildId)}.` });
  if (betType === 'single' && (selectedNumber === null || selectedNumber === undefined)) return interaction.editReply({ content: 'Pick a number for a straight-up bet.' });
  if (betType === 'single' && (selectedNumber < 0 || selectedNumber > 36)) return interaction.editReply({ content: 'Roulette numbers must be between 0 and 36.' });

  adjustBalance(interaction.guildId, interaction.user.id, -bet, 'bet', `roulette:${betType}`);
  const number = rand(0, 36);
  const multiplier = rouletteOutcome(number, betType, selectedNumber);
  const payout = multiplier >= 0 ? bet * (multiplier + 1) : 0;
  const game = { guildId: interaction.guildId, bet, number, selectedType: betType, selectedNumber, multiplier, payout, frameAngle: 0 };
  const embed = themedEmbed('🎡 Roulette', `Spinning for **${betType}**...`, Colors.Red);
  const message = await interaction.editReply(attachmentPayload(drawRouletteCanvas(game, 'spin'), embed, []));
  for (let i = 0; i < 5; i++) {
    game.frameAngle = (-Math.PI / 2) + ((i / 5) * Math.PI * 2 * 1.6);
    await sleep(220);
    await message.edit(attachmentPayload(drawRouletteCanvas(game, 'spin'), embed, []));
  }

  if (payout > 0) adjustBalance(interaction.guildId, interaction.user.id, payout, 'payout', `roulette:${betType}`);
  applyGameStats(interaction.guildId, interaction.user.id, bet, payout, 'roulette');
  const final = themedEmbed('🎡 Roulette Result', `Winning number: **${number} ${rouletteColor(number)}**\nYour bet: **${betType}${betType === 'single' ? ` ${selectedNumber}` : ''}**\nPayout: **${money(payout, interaction.guildId)}**`, payout > bet ? Colors.Green : Colors.Red);
  await message.edit(attachmentPayload(drawRouletteCanvas(game, 'final'), final, []));
}

async function startSlots(interaction, bet) {
  const user = getUser(interaction.guildId, interaction.user.id);
  if (user.balance < bet) return interaction.editReply({ content: `You need ${money(bet, interaction.guildId)}.` });
  adjustBalance(interaction.guildId, interaction.user.id, -bet, 'bet', 'slots');

  const reels = [choice(SLOT_SYMBOLS), choice(SLOT_SYMBOLS), choice(SLOT_SYMBOLS)];
  const result = evaluateSlots(reels);
  const payout = bet * result.multiplier;
  const game = { guildId: interaction.guildId, reels, multiplier: result.multiplier, label: result.label, payout };
  const embed = themedEmbed('🎰 Luxe Slots', 'Reels are spinning...', Colors.Gold);
  const message = await interaction.editReply(attachmentPayload(drawSlotsCanvas(game, 0, 0), embed, []));

  for (let frame = 0; frame < 4; frame++) {
    await sleep(220);
    await message.edit(attachmentPayload(drawSlotsCanvas(game, frame, 0), embed, []));
  }
  for (let reveal = 1; reveal <= 3; reveal++) {
    await sleep(360);
    await message.edit(attachmentPayload(drawSlotsCanvas(game, reveal, reveal), embed, []));
  }

  if (payout > 0) adjustBalance(interaction.guildId, interaction.user.id, payout, 'payout', 'slots');
  applyGameStats(interaction.guildId, interaction.user.id, bet, payout, 'slots');
  const final = themedEmbed('🎰 Slots Result', `Reels: **${reels.join(' • ')}**\nLine: **${result.label}**\nPayout: **${money(payout, interaction.guildId)}**`, payout > bet ? Colors.Gold : Colors.Red);
  await message.edit(attachmentPayload(drawSlotsCanvas(game, 5, 3), final, []));
}

async function startMines(interaction, bet, mineCount) {
  const user = getUser(interaction.guildId, interaction.user.id);
  if (user.balance < bet) return interaction.editReply({ content: `You need ${money(bet, interaction.guildId)}.` });
  if (mineCount < 3 || mineCount > 10) return interaction.editReply({ content: 'Choose between 3 and 10 mines.' });

  adjustBalance(interaction.guildId, interaction.user.id, -bet, 'bet', `mines:${mineCount}`);
  const cells = Array.from({ length: 25 }, (_, i) => i);
  const shuffled = [...cells].sort(() => Math.random() - 0.5);
  const mines = new Set(shuffled.slice(0, mineCount));
  const state = {
    id: crypto.randomUUID(),
    guildId: interaction.guildId,
    userId: interaction.user.id,
    bet,
    mineCount,
    mines,
    revealed: new Set(),
    multiplier: 1,
    finished: false,
    finishText: 'Pick a tile',
    finishColor: '#f8fafc',
  };
  client.activeGames.set(state.id, state);

  const embed = themedEmbed('💎 Mines', `Uncover gems and cash out before you hit a bomb.`, Colors.Green);
  const boardMessage = await interaction.editReply(attachmentPayload(drawMinesCanvas(state), embed, buildMinesRows(state)));
  const cashoutRow = () => [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`mines_cashout:${state.id}`).setLabel(`Cash Out ${money(Math.floor(state.bet * state.multiplier), state.guildId)}`).setStyle(ButtonStyle.Success).setDisabled(state.finished || state.revealed.size === 0))];
  const cashoutMessage = await interaction.followUp({ content: 'Use the board above to reveal tiles. Cash out from here anytime.', components: cashoutRow(), fetchReply: true });

  async function finalize(status, explodedAt = -1) {
    if (state.finished) return;
    state.finished = true;
    let payout = 0;
    if (status === 'cashout') {
      payout = Math.floor(state.bet * state.multiplier);
      adjustBalance(state.guildId, state.userId, payout, 'payout', 'mines cashout');
      state.finishText = `Cashed out ${money(payout, state.guildId)}`;
      state.finishColor = '#4ade80';
    } else {
      state.finishText = 'Boom! Mine triggered';
      state.finishColor = '#f87171';
    }
    applyGameStats(state.guildId, state.userId, bet, payout, 'mines');
    if (state.revealed.size >= 8) grantAchievement(state.guildId, state.userId, 'nerve of steel');
    const finalEmbed = themedEmbed('💎 Mines Result', state.finishText, status === 'cashout' ? Colors.Green : Colors.Red);
    await boardMessage.edit(attachmentPayload(drawMinesCanvas(state, true, explodedAt), finalEmbed, buildMinesRows(state, true)));
    await cashoutMessage.edit({ content: status === 'cashout' ? 'Cashout secured.' : 'Game over.', components: cashoutRow() });
    client.activeGames.delete(state.id);
  }

  const filter = (i) => i.user.id === interaction.user.id;
  const boardCollector = boardMessage.createMessageComponentCollector({ componentType: ComponentType.Button, filter, time: 240000 });
  const cashCollector = cashoutMessage.createMessageComponentCollector({ componentType: ComponentType.Button, filter, time: 240000 });

  boardCollector.on('collect', async (btn) => {
    await btn.deferUpdate();
    if (state.finished) return;
    const index = Number(btn.customId.split(':')[2]);
    if (state.revealed.has(index)) return;
    if (state.mines.has(index)) {
      state.revealed.add(index);
      await finalize('boom', index);
      boardCollector.stop('done');
      cashCollector.stop('done');
      return;
    }
    state.revealed.add(index);
    state.multiplier = calculateMinesMultiplier(state.revealed.size, state.mineCount);
    if (state.revealed.size === 25 - state.mineCount) {
      await finalize('cashout');
      boardCollector.stop('done');
      cashCollector.stop('done');
      return;
    }
    await boardMessage.edit(attachmentPayload(drawMinesCanvas(state), embed, buildMinesRows(state)));
    await cashoutMessage.edit({ content: 'Use the board above to reveal tiles. Cash out from here anytime.', components: cashoutRow() });
  });

  cashCollector.on('collect', async (btn) => {
    await btn.deferUpdate();
    if (state.finished || state.revealed.size === 0) return;
    await finalize('cashout');
    boardCollector.stop('done');
    cashCollector.stop('done');
  });

  const onEnd = async () => {
    if (!state.finished) {
      if (state.revealed.size > 0) await finalize('cashout');
      else await finalize('boom');
    }
  };
  boardCollector.on('end', onEnd);
  cashCollector.on('end', onEnd);
}

async function startCrash(interaction, bet) {
  const user = getUser(interaction.guildId, interaction.user.id);
  if (user.balance < bet) return interaction.editReply({ content: `You need ${money(bet, interaction.guildId)}.` });
  adjustBalance(interaction.guildId, interaction.user.id, -bet, 'bet', 'crash');

  const crashPoint = chance(0.08) ? rand(9, 25) + Math.random() : 1 + (Math.random() * 5.4);
  const game = {
    id: crypto.randomUUID(),
    guildId: interaction.guildId,
    userId: interaction.user.id,
    bet,
    crashPoint: Number(crashPoint.toFixed(2)),
    history: [1],
    cashedOutAt: null,
    payout: 0,
    maxSteps: 16,
    ended: false,
  };
  client.activeGames.set(game.id, game);

  const row = () => [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`crash_cashout:${game.id}`).setLabel(game.ended ? 'Closed' : `Cash Out ${game.history.at(-1).toFixed(2)}x`).setStyle(ButtonStyle.Success).setDisabled(game.ended))];
  const embed = themedEmbed('📈 Crash', 'Cash out before the line detonates.', Colors.Green);
  const message = await interaction.editReply(attachmentPayload(drawCrashCanvas(game, 1, 'live'), embed, row()));

  const collector = message.createMessageComponentCollector({ componentType: ComponentType.Button, time: 60000 });
  collector.on('collect', async (btn) => {
    if (btn.user.id !== interaction.user.id) return btn.reply({ ephemeral: true, content: 'This crash round is not yours.' });
    await btn.deferUpdate();
    if (game.ended || game.cashedOutAt) return;
    game.cashedOutAt = game.history.at(-1);
    game.payout = Math.floor(game.bet * game.cashedOutAt);
    adjustBalance(game.guildId, game.userId, game.payout, 'payout', `crash:${game.cashedOutAt.toFixed(2)}`);
  });

  for (let step = 1; step < game.maxSteps; step++) {
    await sleep(800);
    if (game.ended) break;
    const multiplier = Number((1 + Math.pow(step / 2.7, 1.65)).toFixed(2));
    game.history.push(Math.min(multiplier, game.crashPoint));
    if (game.cashedOutAt) {
      game.ended = true;
      collector.stop('cashed');
      break;
    }
    if (multiplier >= game.crashPoint) {
      game.ended = true;
      collector.stop('crashed');
      break;
    }
    await message.edit(attachmentPayload(drawCrashCanvas(game, game.history.at(-1), 'live'), embed, row()));
  }

  const status = game.cashedOutAt ? 'cashed' : 'crashed';
  const finalMultiplier = game.cashedOutAt || game.crashPoint;
  if (!game.cashedOutAt) game.payout = 0;
  game.ended = true;
  applyGameStats(game.guildId, game.userId, bet, game.payout, 'crash');
  const finalEmbed = themedEmbed('📈 Crash Result', `${status === 'cashed' ? `You escaped at **${game.cashedOutAt.toFixed(2)}x**` : `Crashed at **${game.crashPoint.toFixed(2)}x**`}\nPayout: **${money(game.payout, game.guildId)}**`, status === 'cashed' ? Colors.Green : Colors.Red);
  await message.edit(attachmentPayload(drawCrashCanvas(game, finalMultiplier, status), finalEmbed, row()));
  client.activeGames.delete(game.id);
}

async function showBalance(interaction, target) {
  const user = getUser(interaction.guildId, target.id);
  const nextLevel = xpForLevel(user.level);
  const embed = themedEmbed('💰 Balance', `<@${target.id}>\nWallet: **${money(user.balance, interaction.guildId)}**\nBank: **${money(user.bank, interaction.guildId)}**\nLevel: **${user.level}**\nXP: **${user.xp}/${nextLevel}**\nAchievements: **${user.achievements.length}**`, Colors.Gold);
  return interaction.editReply({ embeds: [embed] });
}

async function claimDaily(interaction) {
  const user = getUser(interaction.guildId, interaction.user.id);
  const timestamp = now();
  const diff = timestamp - user.last_daily;
  if (diff < 20 * 3600) {
    const remaining = 20 * 3600 - diff;
    const hours = Math.floor(remaining / 3600);
    const minutes = Math.ceil((remaining % 3600) / 60);
    return interaction.editReply({ content: `Daily already claimed. Try again in ${hours}h ${minutes}m.` });
  }
  user.daily_streak = diff <= 48 * 3600 ? user.daily_streak + 1 : 1;
  user.last_daily = timestamp;
  const settings = getGuildSettings(interaction.guildId);
  const reward = settings.daily_base + Math.min(4000, user.daily_streak * 250);
  saveUser(user);
  adjustBalance(interaction.guildId, interaction.user.id, reward, 'daily', `streak:${user.daily_streak}`);
  awardXp(interaction.guildId, interaction.user.id, 70 + user.daily_streak * 4);
  if (user.daily_streak >= 7) grantAchievement(interaction.guildId, interaction.user.id, 'weekly regular');
  const embed = themedEmbed('🎁 Daily Reward', `Collected **${money(reward, interaction.guildId)}**\nStreak: **${user.daily_streak} days**`, Colors.Green);
  await interaction.editReply({ embeds: [embed] });
}

async function deposit(interaction, amount) {
  const user = getUser(interaction.guildId, interaction.user.id);
  if (amount <= 0 || user.balance < amount) return interaction.editReply({ content: 'Not enough wallet funds.' });
  adjustBalance(interaction.guildId, interaction.user.id, -amount, 'deposit', 'wallet to bank');
  adjustBank(interaction.guildId, interaction.user.id, amount, 'deposit', 'wallet to bank');
  const updated = getUser(interaction.guildId, interaction.user.id);
  const embed = themedEmbed('🏦 Deposit', `Deposited **${money(amount, interaction.guildId)}**\nWallet: **${money(updated.balance, interaction.guildId)}**\nBank: **${money(updated.bank, interaction.guildId)}**`, Colors.Blue);
  await interaction.editReply({ embeds: [embed] });
}

async function withdraw(interaction, amount) {
  const user = getUser(interaction.guildId, interaction.user.id);
  if (amount <= 0 || user.bank < amount) return interaction.editReply({ content: 'Not enough bank funds.' });
  adjustBank(interaction.guildId, interaction.user.id, -amount, 'withdraw', 'bank to wallet');
  adjustBalance(interaction.guildId, interaction.user.id, amount, 'withdraw', 'bank to wallet');
  const updated = getUser(interaction.guildId, interaction.user.id);
  const embed = themedEmbed('🏦 Withdraw', `Withdrew **${money(amount, interaction.guildId)}**\nWallet: **${money(updated.balance, interaction.guildId)}**\nBank: **${money(updated.bank, interaction.guildId)}**`, Colors.Blurple);
  await interaction.editReply({ embeds: [embed] });
}

async function showStats(interaction, target) {
  const user = getUser(interaction.guildId, target.id);
  const embed = themedEmbed('📊 Casino Stats', `<@${target.id}>\nGames: **${user.games_played}**\nWins/Losses/Pushes: **${user.wins}/${user.losses}/${user.pushes}**\nTotal wagered: **${money(user.total_wagered, interaction.guildId)}**\nProfit won: **${money(user.total_won, interaction.guildId)}**\nLosses absorbed: **${money(user.total_lost, interaction.guildId)}**\nBiggest win: **${money(user.biggest_win, interaction.guildId)}**\nBiggest loss: **${money(user.biggest_loss, interaction.guildId)}**\nAchievements: **${user.achievements.join(', ') || 'None yet'}**`, Colors.Blurple);
  await interaction.editReply({ embeds: [embed] });
}

async function showLeaderboard(interaction) {
  const rows = stmt.topUsers.all(interaction.guildId);
  const lines = rows.map((row, index) => `${index + 1}. <@${row.user_id}> • ${money(row.net_worth, interaction.guildId)} • Lvl ${row.level}`);
  const embed = themedEmbed('🏆 Leaderboard', lines.join('\n') || 'No players yet.', Colors.Gold);
  await interaction.editReply({ embeds: [embed] });
}

async function handleAdminAdjust(interaction, mode) {
  if (!isAdmin(interaction)) return interaction.editReply({ content: 'Admin only.', ephemeral: true });
  const target = interaction.options.getUser('user', true);
  const amount = interaction.options.getInteger('amount', true);
  if (amount < 0) return interaction.editReply({ content: 'Amount must be positive.' });

  const before = getUser(interaction.guildId, target.id);
  if (mode === 'give') adjustBalance(interaction.guildId, target.id, amount, 'admin', `given by ${interaction.user.id}`);
  if (mode === 'remove') adjustBalance(interaction.guildId, target.id, -amount, 'admin', `removed by ${interaction.user.id}`);
  if (mode === 'set') {
    const delta = amount - before.balance;
    adjustBalance(interaction.guildId, target.id, delta, 'admin', `set by ${interaction.user.id}`);
  }
  stmt.addAdminLog.run(interaction.guildId, interaction.user.id, target.id, `admin_${mode}`, `${amount}`);
  const updated = getUser(interaction.guildId, target.id);
  const embed = themedEmbed('🛠 Admin Economy', `${mode.toUpperCase()} completed for <@${target.id}>.\nWallet: **${money(updated.balance, interaction.guildId)}**`, Colors.Orange);
  await interaction.editReply({ embeds: [embed] });
}

function buildCommands() {
  return [
    new SlashCommandBuilder().setName('blackjack').setDescription('Premium blackjack with live buttons').addIntegerOption((o) => o.setName('bet').setDescription('Bet amount').setRequired(true).setMinValue(1)).setDMPermission(false),
    new SlashCommandBuilder().setName('plinko').setDescription('Drop a ball down a glowing plinko board').addIntegerOption((o) => o.setName('bet').setDescription('Bet amount').setRequired(true).setMinValue(1)).addStringOption((o) => o.setName('risk').setDescription('Risk profile').setRequired(true).addChoices({ name: 'low', value: 'low' }, { name: 'medium', value: 'medium' }, { name: 'high', value: 'high' })).setDMPermission(false),
    new SlashCommandBuilder().setName('roulette').setDescription('Roulette with table and wheel visuals').addIntegerOption((o) => o.setName('bet').setDescription('Bet amount').setRequired(true).setMinValue(1)).addStringOption((o) => o.setName('type').setDescription('Bet type').setRequired(true).addChoices({ name: 'single number', value: 'single' }, { name: 'red', value: 'red' }, { name: 'black', value: 'black' }, { name: 'odd', value: 'odd' }, { name: 'even', value: 'even' }, { name: '1-18', value: 'low' }, { name: '19-36', value: 'high' }, { name: '1st dozen', value: 'dozen1' }, { name: '2nd dozen', value: 'dozen2' }, { name: '3rd dozen', value: 'dozen3' }, { name: 'column 1', value: 'column1' }, { name: 'column 2', value: 'column2' }, { name: 'column 3', value: 'column3' })).addIntegerOption((o) => o.setName('number').setDescription('0-36, only for single number bets').setMinValue(0).setMaxValue(36)).setDMPermission(false),
    new SlashCommandBuilder().setName('slots').setDescription('Luxury 3-reel slots with animated symbols').addIntegerOption((o) => o.setName('bet').setDescription('Bet amount').setRequired(true).setMinValue(1)).setDMPermission(false),
    new SlashCommandBuilder().setName('mines').setDescription('Reveal gems on a 5x5 grid and cash out').addIntegerOption((o) => o.setName('bet').setDescription('Bet amount').setRequired(true).setMinValue(1)).addIntegerOption((o) => o.setName('mines').setDescription('Number of mines').setRequired(true).setMinValue(3).setMaxValue(10)).setDMPermission(false),
    new SlashCommandBuilder().setName('crash').setDescription('Watch the multiplier rise and cash out').addIntegerOption((o) => o.setName('bet').setDescription('Bet amount').setRequired(true).setMinValue(1)).setDMPermission(false),
    new SlashCommandBuilder().setName('balance').setDescription('View wallet, bank, XP and level').addUserOption((o) => o.setName('user').setDescription('Target user')).setDMPermission(false),
    new SlashCommandBuilder().setName('daily').setDescription('Claim your daily casino stipend').setDMPermission(false),
    new SlashCommandBuilder().setName('deposit').setDescription('Move funds into your bank').addIntegerOption((o) => o.setName('amount').setDescription('Amount to deposit').setRequired(true).setMinValue(1)).setDMPermission(false),
    new SlashCommandBuilder().setName('withdraw').setDescription('Move funds out of your bank').addIntegerOption((o) => o.setName('amount').setDescription('Amount to withdraw').setRequired(true).setMinValue(1)).setDMPermission(false),
    new SlashCommandBuilder().setName('stats').setDescription('View player stats and achievements').addUserOption((o) => o.setName('user').setDescription('Target user')).setDMPermission(false),
    new SlashCommandBuilder().setName('leaderboard').setDescription('View the richest casino players').setDMPermission(false),
    new SlashCommandBuilder().setName('admin_give').setDescription('Admin: give chips').addUserOption((o) => o.setName('user').setDescription('Target').setRequired(true)).addIntegerOption((o) => o.setName('amount').setDescription('Amount').setRequired(true).setMinValue(1)).setDMPermission(false),
    new SlashCommandBuilder().setName('admin_remove').setDescription('Admin: remove chips').addUserOption((o) => o.setName('user').setDescription('Target').setRequired(true)).addIntegerOption((o) => o.setName('amount').setDescription('Amount').setRequired(true).setMinValue(1)).setDMPermission(false),
    new SlashCommandBuilder().setName('admin_set').setDescription('Admin: set wallet balance').addUserOption((o) => o.setName('user').setDescription('Target').setRequired(true)).addIntegerOption((o) => o.setName('amount').setDescription('New wallet value').setRequired(true).setMinValue(0)).setDMPermission(false),
  ];
}

async function registerCommands() {
  const commands = buildCommands();
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  const body = commands.map((cmd) => cmd.toJSON());
  if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body });
    console.log(`✓ Registered ${commands.length} guild commands`);
  } else {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body });
    console.log(`✓ Registered ${commands.length} global commands`);
  }
  commands.forEach((cmd) => client.commands.set(cmd.name, cmd));
}

client.once(Events.ClientReady, async () => {
  console.log(`✓ Logged in as ${client.user.tag}`);
  try {
    await registerCommands();
  } catch (error) {
    console.error('✗ Failed to register commands:', error.message);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.inGuild()) return interaction.reply({ ephemeral: true, content: 'Guild only.' });

  try {
    await interaction.deferReply();
    const name = interaction.commandName;
    if (name === 'blackjack') return startBlackjack(interaction, interaction.options.getInteger('bet', true));
    if (name === 'plinko') return startPlinko(interaction, interaction.options.getInteger('bet', true), interaction.options.getString('risk', true));
    if (name === 'roulette') return startRoulette(interaction, interaction.options.getInteger('bet', true), interaction.options.getString('type', true), interaction.options.getInteger('number'));
    if (name === 'slots') return startSlots(interaction, interaction.options.getInteger('bet', true));
    if (name === 'mines') return startMines(interaction, interaction.options.getInteger('bet', true), interaction.options.getInteger('mines', true));
    if (name === 'crash') return startCrash(interaction, interaction.options.getInteger('bet', true));
    if (name === 'balance') return showBalance(interaction, interaction.options.getUser('user') || interaction.user);
    if (name === 'daily') return claimDaily(interaction);
    if (name === 'deposit') return deposit(interaction, interaction.options.getInteger('amount', true));
    if (name === 'withdraw') return withdraw(interaction, interaction.options.getInteger('amount', true));
    if (name === 'stats') return showStats(interaction, interaction.options.getUser('user') || interaction.user);
    if (name === 'leaderboard') return showLeaderboard(interaction);
    if (name === 'admin_give') return handleAdminAdjust(interaction, 'give');
    if (name === 'admin_remove') return handleAdminAdjust(interaction, 'remove');
    if (name === 'admin_set') return handleAdminAdjust(interaction, 'set');
    return interaction.editReply({ content: 'Unknown command.' });
  } catch (error) {
    console.error('✗ Command failure:', error);
    const payload = { content: '❌ Something went wrong while running that command.' };
    if (interaction.deferred || interaction.replied) return interaction.editReply(payload).catch(() => null);
    return interaction.reply({ ...payload, ephemeral: true }).catch(() => null);
  }
});

process.on('unhandledRejection', (error) => console.error('✗ Unhandled rejection:', error));
process.on('uncaughtException', (error) => {
  console.error('✗ Uncaught exception:', error);
  process.exit(1);
});

client.login(TOKEN).catch((error) => {
  console.error('✗ Login failed:', error.message);
  process.exit(1);
});
