/**
 * Every user-visible string in the trading UI, in English and 中文.
 *
 * Kept as data, next to `faq.ts`, for the same reason that file is: copy is reviewed as prose, by
 * people reading it side by side, not hunted through JSX. Components import a `Text` from here and
 * hand it to `t(lang, …)`; nothing in a component holds a bare sentence.
 *
 * The typing is the point. Every leaf is a `Text` — `{ en, zh }`, both required — so a half-done
 * translation is a compile error rather than an English sentence leaking into a 中文 screen at
 * runtime. Copy that depends on a number takes it as an argument and returns a `Text`, so the two
 * languages can put the number where their own grammar wants it instead of sharing one word order.
 *
 * Register (see `GLOSSARY.md`): 你, never 您. No exclamation marks. Buttons are verbs. Where the
 * English admits it does not know something, the 中文 admits it too — 还不知道 is a legitimate
 * thing for this product to say and 处理中 would be a lie.
 */
import { activeChain, chainLabel } from '../config/chains'
import type { Lang, Text } from '../lib/i18n'
import type { PositionStatus, RoundPhase } from '../lib/market'

/**
 * A round number, wherever one stands on its own.
 *
 * English writes the bare id it would type into a block explorer; 中文 counts rounds the way it
 * counts everything else — 第 40 轮 — and keeps the numeral a numeral.
 */
export function roundNo(epoch: bigint | number, lang: Lang): string {
  return lang === 'zh' ? `第 ${epoch.toString()} 轮` : `#${epoch.toString()}`
}

/**
 * The two seams where JSX has to join two pieces of copy and the languages disagree.
 *
 * English separates a label from the number after it, and one sentence from the next, with a
 * space. 中文 sets nothing between two CJK characters: a stray space there reads as a typo at
 * best and as a missing word at worst. So a label takes the app's own `·` and a sentence boundary
 * takes nothing at all — the full stop is already the separator.
 */
export const join = {
  labelNumber: { en: ' ', zh: ' · ' },
  sentence: { en: ' ', zh: '' },
} satisfies Record<string, Text>

/** UP / DOWN stay Latin in both languages, exactly as the FAQ and the pool labels have them. */
export function sideName(side: 'up' | 'down'): string {
  return side === 'up' ? 'UP' : 'DOWN'
}

// ── document ────────────────────────────────────────────────────────────────────────────────────

export const meta = {
  description: {
    en: 'UpDown Protocol — non-custodial parimutuel binary options on BNB Smart Chain. Ties and one-sided books are refunded in full, zero fee.',
    zh: 'UpDown Protocol —— BNB 智能链上的非托管平价池二元期权。平局和单边池全额退回，零手续费。',
  },
} satisfies Record<string, Text>

// ── header ──────────────────────────────────────────────────────────────────────────────────────

export const header = {
  faq: { en: 'FAQ', zh: '常见问题' },
} satisfies Record<string, Text>

export function headerTagline(lang: Lang): Text {
  return {
    en: `Parimutuel binary options · ${activeChain.name}`,
    zh: `平价池二元期权 · ${chainLabel(lang)}`,
  }
}

export const themeToggle = {
  system: { en: 'Switch to light theme', zh: '切换到浅色主题' },
  light: { en: 'Switch to dark theme', zh: '切换到深色主题' },
  dark: { en: 'Use system theme', zh: '跟随系统主题' },
} satisfies Record<string, Text>

// ── wallet ──────────────────────────────────────────────────────────────────────────────────────

export const connect = {
  switching: { en: 'Switching…', zh: '切换中…' },
  explorer: { en: 'View on explorer ↗', zh: '在区块浏览器中查看 ↗' },
  disconnect: { en: 'Disconnect', zh: '断开连接' },
  installWallet: { en: 'Install a wallet', zh: '安装钱包' },
  connecting: { en: 'Connecting…', zh: '连接中…' },
  connect: { en: 'Connect wallet', zh: '连接钱包' },
  openInWallet: { en: 'Open in wallet app', zh: '在钱包 App 中打开' },
  openInWalletHint: {
    en: 'A phone browser cannot talk to your wallet directly. This reopens the page inside your wallet app, where it can.',
    zh: '手机浏览器没法直接和钱包通话。这会把本页在你的钱包 App 里重新打开，在那里就可以了。',
  },
  noWalletYet: { en: "Don't have one? Install MetaMask", zh: '还没有钱包？安装 MetaMask' },
  failed: { en: 'Could not connect', zh: '没能连上' },
  walletWaiting: { en: 'Your wallet is waiting for you', zh: '钱包在等你处理' },
  // Approval is the only outcome the page can detect on its own: a dismissed request leaves no
  // trace it can read. So the copy promises auto-connect only for approval, and names the one
  // extra click a dismissal costs — promising it for both stranded people on a toast that never
  // came true.
  walletWaitingBody: {
    en: 'A connect request is already open in your wallet — its popup is probably hidden behind this window. Confirm it there and this page connects on its own; if you dismiss it instead, come back and press Connect again.',
    zh: '钱包里已经有一个连接请求了——它的弹窗多半被挡在这个窗口后面。在钱包里批准它，这个页面就会自己连上；如果你把它关掉了，就回来再点一次连接。',
  },
} satisfies Record<string, Text>

export function switchNetwork(lang: Lang): Text {
  return { en: `Switch to ${activeChain.name}`, zh: `切换到 ${chainLabel(lang)}` }
}

// ── testnet banner ──────────────────────────────────────────────────────────────────────────────

export const testnet = {
  chip: { en: 'Testnet', zh: '测试网' },
  faucetTitle: { en: 'Mint 1,000 test USDT', zh: '铸造 1,000 测试 USDT' },
  faucetNeedsWallet: { en: 'Connect your wallet first', zh: '先连接钱包' },
  faucetHowTo: {
    en: 'The faucet mints 1,000 test USDT straight to your connected address. Press "Connect wallet" at the top right (it reads "Install a wallet" if you don\'t have one yet), then press this button again.',
    zh: '水龙头会把 1,000 测试 USDT 直接铸到你连上的地址。先点右上角的"连接钱包"（还没有钱包的话，那里显示的是"安装钱包"），再回来点一次这个按钮。',
  },
  // Every transaction here — the USDT faucet included — needs a little testnet BNB for gas, and a
  // fresh test wallet has none. This is the one link that unblocks step one of the funnel.
  gasFaucet: { en: 'Get gas (tBNB) ↗', zh: '领 gas（tBNB）↗' },
  gasFaucetTitle: {
    en: 'Every transaction here needs a little testnet BNB for gas. The official BNB Chain faucet gives it away.',
    zh: '这里的每一笔交易都需要一点测试网 BNB 付 gas。BNB Chain 官方水龙头免费发。',
  },
  faucetBusy: { en: 'Minting…', zh: '铸造中…' },
  faucet: { en: 'Get 1,000 test USDT', zh: '领 1,000 测试 USDT' },
  faucetTx: { en: 'Test USDT faucet', zh: '测试 USDT 水龙头' },
} satisfies Record<string, Text>

export function testnetNotice(lang: Lang): Text {
  return {
    en: `You are on ${activeChain.name}. Funds here are worthless. Prices come from a keeper-fed relay feed, not Chainlink, because the testnet Chainlink feeds are far too stale for 5-minute rounds.`,
    zh: `你在 ${chainLabel(lang)}上。这里的钱没有价值。价格来自 keeper 推送的中继喂价，不是 Chainlink——测试网自带的 Chainlink 喂价滞后得太厉害，5 分钟的轮次撑不住。`,
  }
}

// ── no deployment ───────────────────────────────────────────────────────────────────────────────

export const noDeployment = {
  chip: { en: 'Setup required', zh: '需要先完成部署' },
  title: { en: 'No contracts configured yet', zh: '还没有配置合约' },
  step1: {
    en: 'Deploy the contracts so',
    zh: '部署合约，让',
  },
  step1After: { en: 'exists.', zh: '这个文件出现。' },
  step2: {
    en: 'Rebuild the web app. The build reads that file automatically — or point',
    zh: '重新构建前端。构建会自动读取那个文件——或者把',
  },
  step2After: { en: 'at a copy of it.', zh: '指向它的一份副本。' },
  step3: { en: 'Set', zh: '在 CI 里设置' },
  step3After: {
    en: 'in CI so a missing deployment fails the build instead of shipping this screen.',
    zh: '，这样缺少部署会让构建失败，而不是把这个页面发出去。',
  },
  runBefore: { en: 'Run', zh: '运行' },
  runAfter: {
    en: 'to see exactly which file the build would pick up.',
    zh: '就能看到构建究竟会读取哪一个文件。',
  },
} satisfies Record<string, Text>

export function noDeploymentBody(source: string, lang: Lang): { before: Text; after: Text } {
  return {
    before: {
      en: 'This build is using the placeholder addresses from',
      zh: '这个构建用的是占位地址，来自',
    },
    after: {
      en: `(resolved as ${source}), so there is nothing to trade on ${activeChain.name} yet.`,
      zh: `（解析为 ${source}），所以 ${chainLabel(lang)}上暂时没有可交易的东西。`,
    },
  }
}

// ── market picker ───────────────────────────────────────────────────────────────────────────────

export const marketPicker = {
  tablist: { en: 'Markets', zh: '市场' },
  empty: {
    en: 'No enabled markets found in the registry.',
    zh: '注册表里没有找到已启用的市场。',
  },
  collectableDot: { en: 'Money to collect in this market', zh: '这个市场有可领的钱' },
} satisfies Record<string, Text>

/** `5m rounds · settles in USDT` / `5 分钟一轮 · 用 USDT 结算`. */
export function marketSubtitle(interval: string, asset: string): Text {
  return {
    en: `${interval} rounds · settles in ${asset}`,
    zh: `${interval}一轮 · 用 ${asset} 结算`,
  }
}

// ── the live round card ─────────────────────────────────────────────────────────────────────────

/**
 * The phase chips.
 *
 * "Pending" is three separate states in this product and they stay three in 中文: 开放下注 (the
 * window is open), 进行中 (locked, the price is running), 待结算 (past close, nobody has executed
 * the round yet). Collapsing them into 处理中 would hide from a reader which one holds their money.
 *
 * 可退款 is not 已退款: `expired` means the chain will now hand the stake back to whoever asks,
 * not that anything has been sent. And 作废 is not 失败 — a void is a defined, correct outcome.
 */
export const phaseChip: Record<RoundPhase, Text> = {
  unstarted: { en: 'Not started', zh: '未开始' },
  upcoming: { en: 'Opening soon', zh: '即将开始' },
  betting: { en: 'Betting open', zh: '开放下注' },
  live: { en: 'Live', zh: '进行中' },
  settling: { en: 'Settling', zh: '待结算' },
  expired: { en: 'Refundable', zh: '可退款' },
  settled: { en: 'Settled', zh: '已结算' },
  voided: { en: 'Voided · refundable', zh: '已作废 · 可退款' },
}

export const countdownLabel = {
  bettingCloses: { en: 'Betting closes in', zh: '距停止下注' },
  bettingOpens: { en: 'Betting opens in', zh: '距开放下注' },
  windowClosed: { en: 'Settlement window closed', zh: '结算时限已过' },
  waitingToLock: { en: 'Waiting to lock', zh: '等待锁定' },
  settlesIn: { en: 'Settles in', zh: '距结算' },
  settlementWindow: { en: 'Settlement window', zh: '结算时限' },
} satisfies Record<string, Text>

/** The countdown's accessible text — what a screen reader says instead of `04:59`. */
export function remaining(duration: string): Text {
  return { en: `${duration} remaining`, zh: `剩余 ${duration}` }
}

export const liveCard = {
  paused: { en: 'Paused', zh: '已暂停' },
  liveRound: { en: 'Live round', zh: '进行中的轮次' },
  strike: { en: 'Strike (locked)', zh: '行权价（已锁定）' },
  noLiveRound: {
    en: 'No live round yet. The first round settles one interval after the market opens.',
    zh: '还没有进行中的轮次。市场开启一个间隔之后，第一轮才会结算。',
  },
  refundTitle: { en: 'Full refund, zero fee', zh: '全额退回，零手续费' },
  refundWhen: { en: 'When does this apply?', zh: '哪些情况会退？' },
  refundBody: {
    en: 'A round is voided and every stake refunded in full, with no fee taken, if the settlement price is exactly the strike (a tie), if one side of the book is empty, if no usable oracle print exists at the boundary, if the settlement window is missed, or if the market was paused before the round locked. A round that had already locked is not on that list: it settles through a pause at the price the feed printed. Winners are paid from the losing pool only, so a winner never receives less than their own stake.',
    zh: '出现下面任何一种情况，轮次作废、每一笔本金全额退回、不收手续费：结算价正好等于行权价（平局）、盘口有一边是空的、边界时刻没有可用的预言机报价、错过结算时限，或者市场在该轮锁定之前就被暂停。已经锁定的轮次不在这张清单里：它会穿过暂停，按喂价报出的价格结算。赢家的钱只从输的那一边的池子里出，所以赢家拿到的钱永远不会少于自己的本金。',
  },
} satisfies Record<string, Text>

export function liveRoundAria(marketLabel: string): Text {
  return { en: `${marketLabel} live round`, zh: `${marketLabel} 进行中的轮次` }
}

export function feedAge(seconds: number): Text {
  return { en: `feed ${seconds}s ago`, zh: `喂价 ${seconds} 秒前` }
}

export function printedAt(time: string): Text {
  return { en: `printed ${time}`, zh: `报价时间 ${time}` }
}

export function lockedSettles(lockTime: string, closeTime: string): Text {
  return {
    en: `Locked at ${lockTime} · settles at ${closeTime}`,
    zh: `锁定于 ${lockTime} · 结算于 ${closeTime}`,
  }
}

/**
 * What the price column is allowed to claim, once the round has closed.
 *
 * These are the sentences that make the product trustworthy, so the 中文 keeps every admission the
 * English makes: 还没确定下来 where the English says "not resolved yet", and 没有人能结算这一轮 where
 * it says nobody can settle it. Softening either into 处理中 would be a lie.
 */
export function settlementNote(
  kind:
    | 'boundary'
    | 'pending'
    | 'no-print'
    | 'one-sided-committed'
    | 'one-sided-pending'
    | 'tie-committed'
    | 'tie-pending'
    | 'window'
    | 'no-winner',
  closedAt: string,
): Text {
  switch (kind) {
    case 'boundary':
      return {
        en: `Closed at ${closedAt}. This is the last feed print at or before that moment — the price the contract settles on. Not final until the round is executed on chain.`,
        zh: `本轮已于 ${closedAt} 结束。这是那一刻之前（含那一刻）的最后一笔喂价报价——合约就按它结算。在轮次于链上执行之前，它还不是最终结果。`,
      }
    case 'pending':
      return {
        en: `Closed at ${closedAt}. This round settles on the last feed print at or before that moment, which is not the live price, and that print is not resolved yet — no outcome here.`,
        zh: `本轮已于 ${closedAt} 结束。它按那一刻之前（含那一刻）的最后一笔报价结算——那不是实时价格——而那笔报价现在还没有确定下来。所以这里还没有结果。`,
      }
    case 'no-print':
      return {
        en: `There is no usable feed print at or before ${closedAt}, so nobody can settle this round. Once its settlement window closes, every stake is returned in full with no fee taken.`,
        zh: `${closedAt} 之前（含那一刻）没有可用的喂价报价，所以没有人能结算这一轮。等它的结算时限过去，每一笔本金全额退回，不收手续费。`,
      }
    case 'one-sided-committed':
      return {
        en: 'Only one side of this round had money in it, so there was nobody to win from: every stake is returned in full, no fee taken.',
        zh: '这一轮只有一边有钱，没有可以赢的对手：每一笔本金全额退回，不收手续费。',
      }
    case 'one-sided-pending':
      return {
        en: 'Only one side of this round has money in it, so there is nobody to win from. Whatever this price is, every stake is returned in full once the round is executed, with no fee taken.',
        zh: '这一轮只有一边有钱，没有可以赢的对手。不管这个价格是多少，轮次执行之后每一笔本金都全额退回，不收手续费。',
      }
    case 'tie-committed':
      return {
        en: 'The settlement price landed exactly on the strike — a tie. Every stake is returned in full, no fee taken.',
        zh: '结算价正好落在行权价上——平局。每一笔本金全额退回，不收手续费。',
      }
    case 'tie-pending':
      return {
        en: 'This price is exactly the strike — a tie, so there is no winner. Every stake is returned in full once the round is executed, with no fee taken.',
        zh: '这个价格正好等于行权价——平局，没有赢家。轮次执行之后每一笔本金全额退回，不收手续费。',
      }
    case 'window':
      return {
        en: 'This round’s settlement window closed without a settlement, so it can no longer be settled: every stake is returned in full, no fee taken.',
        zh: '本轮的结算时限已经过去，却始终没有人结算，所以它再也无法结算了：每一笔本金全额退回，不收手续费。',
      }
    default:
      return {
        en: 'There is no winner in this round: every stake is returned in full, no fee taken.',
        zh: '这一轮没有赢家：每一笔本金全额退回，不收手续费。',
      }
  }
}

// ── pools ───────────────────────────────────────────────────────────────────────────────────────

export const pool = {
  up: { en: 'Up pool', zh: 'UP 池' },
  down: { en: 'Down pool', zh: 'DOWN 池' },
  reading: { en: 'Reading the book…', zh: '正在读取盘口…' },
  emptyLive: { en: 'Nobody bet on this round', zh: '这一轮没有人下注' },
  emptyOpen: {
    en: 'No bets yet — the first one opens the book',
    zh: '还没有人下注——第一注就把盘口开出来了',
  },
  emptyLiveNote: {
    en: 'Both pools are empty, so there was nobody to win from: this round is refunded in full, with no fee taken.',
    zh: '两边池子都是空的，没有可以赢的对手：这一轮全额退回，不收手续费。',
  },
  emptyOpenNote: {
    en: 'Both pools are empty. There is no house and no market maker here — the pools are the other traders, so the book is 0 until somebody bets.',
    zh: '两边池子都是空的。这里没有庄家，也没有做市商——池子就是其他交易者，所以在有人下注之前，盘口就是 0。',
  },
  oneSidedLive: {
    en: 'One-sided: there is nobody to win from, so every stake is refunded in full, no fee taken.',
    zh: '单边池：没有可以赢的对手，每一笔本金全额退回，不收手续费。',
  },
  oneSidedOpen: {
    en: 'One side only. If the round locks like this, every stake is refunded in full with no fee.',
    zh: '目前只有一边有钱。如果就这样锁定，每一笔本金全额退回，不收手续费。',
  },
  whyZero: { en: 'Why is the book 0?', zh: '为什么盘口是 0？' },
} satisfies Record<string, Text>

export function poolShareAria(upPct: string, downPct: string): Text {
  return {
    en: `Up holds ${upPct} percent of the book, down holds ${downPct} percent`,
    zh: `UP 占盘口的 ${upPct}%，DOWN 占 ${downPct}%`,
  }
}

// ── odds ────────────────────────────────────────────────────────────────────────────────────────

export const odds = {
  heading: { en: 'Odds', zh: '赔率' },
  payoutOnWin: { en: 'payout on a win', zh: '赢了的赔付倍数' },
  reading: { en: 'reading the book…', zh: '正在读取盘口…' },
  breakEven: { en: 'break-even win rate', zh: '保本胜率' },
  ifYouMatch: { en: 'if you match the other side', zh: '如果你和对面下得一样多' },
  ifEven: { en: 'if the book ends even', zh: '如果盘口最终两边持平' },
  emptyBook: {
    en: 'No bets yet on either side, so there is no price. Your bet is the first half of it.',
    zh: '两边都还没有人下注，所以没有价格。你这一注就是价格的前一半。',
  },
  alone: {
    en: 'Only this side has money. Nobody to win from yet — if it locks like this, every stake comes back in full.',
    zh: '只有这一边有钱。目前没有可以赢的对手——如果就这样锁定，每一笔本金全额退回。',
  },
  unread: {
    en: 'The book for this round has not been read yet.',
    zh: '这一轮的盘口还没有读到。',
  },
  finalLive: {
    en: 'These are the final odds for this round — the book is locked.',
    zh: '这就是本轮的最终赔率——盘口已经锁定。',
  },
  movingOpen: {
    en: 'Odds move with every bet and are only final at lock. The number you see is the multiple the contract itself would use.',
    zh: '每一笔下注都会让赔率变动，只有到锁定那一刻才最终确定。你看到的数字就是合约自己会用的倍数。',
  },
  oneSidedLive: {
    en: 'This round locked without a counterparty, so every stake in it is refunded in full, with zero fee.',
    zh: '这一轮锁定时没有对手方，所以里面每一笔本金都全额退回，零手续费。',
  },
  oneSidedOpen: {
    en: 'A round that locks one-sided is refunded in full, with zero fee — nobody can lose money for want of an opponent.',
    zh: '单边锁定的轮次全额退回，零手续费——没有人会因为找不到对手而亏钱。',
  },
  howTitle: { en: 'How this number is worked out', zh: '这个数字是怎么算出来的' },
  whyNoPrice: { en: 'Why there is no price yet', zh: '为什么还没有价格' },
  howIntro: {
    en: 'Winners split the losing side, minus the fee. The fee comes off the losing pool only, so a winner is never paid less than their stake.',
    zh: '赢的一方分掉输的一方，扣掉手续费。手续费只从输的池子里扣，所以赢家拿到的永远不会低于本金。',
  },
  howYourShare: {
    en: 'Your share of your own side is what decides your cut — the contract never records a price for your order.',
    zh: '决定你分多少的，是你在自己这一边占的比例——合约从不为你的订单记录任何价格。',
  },
} satisfies Record<string, Text>

/** The odds formula with this round's live pools substituted in, so it can be checked by eye. */
export function oddsFormula(side: 'up' | 'down', win: string, lose: string, feePct: string, result: string): Text {
  const other = side === 'up' ? 'DOWN' : 'UP'
  const mine = side === 'up' ? 'UP' : 'DOWN'
  return {
    en: `( ${mine} ${win} + ${other} ${lose} x ${feePct} ) / ${mine} ${win} = ${result}`,
    zh: `( ${mine}池 ${win} + ${other}池 ${lose} x ${feePct} ) / ${mine}池 ${win} = ${result}`,
  }
}

export function oddsWaiting(otherStake: string): Text {
  return {
    en: `Nothing here yet. ${otherStake} is waiting on the other side.`,
    zh: `这一边还是空的。对面有 ${otherStake} 在等对手。`,
  }
}

export function feeNote(fee: string): Text {
  return {
    en: `${fee}% fee, charged on the losing pool only`,
    zh: `${fee}% 手续费，只从输的那一边的池子里收`,
  }
}

/** The unpriced-book explanation, split around the `odds()` and multiple that render as markup. */
export const oddsUnpriced = {
  before: {
    en: 'A parimutuel price is one pool divided by the other, so the contract’s ',
    zh: '平价池的价格就是一个池子除以另一个池子，所以在两边都有钱之前，合约的 ',
  },
  middle: {
    en: ' returns nothing at all until ',
    zh: ' 根本不会给出价格——要',
  },
  bold: { en: 'both', zh: '两边' },
  afterBold: {
    en: ' sides hold money — the greyed ',
    zh: '都有钱才行。上面那个灰色的 ',
  },
  after: {
    en: ' above is what an evenly matched book pays at this round’s fee, not a quote. ',
    zh: ' 是按本轮手续费算、两边持平时的赔付，不是报价。',
  },
} satisfies Record<string, Text>

/** The overround note. `total` and `points` are rendered as their own spans, so the copy splits. */
export const oddsOverround = {
  leadBold: { en: 'break-even win rate', zh: '保本胜率' },
  lead: { en: 'A ', zh: '所谓' },
  afterLead: {
    en: ' is what a side has to win to leave you level at that payout — not a forecast. The two add up to ',
    zh: '，是指按这个赔付、这一边要赢多少比例你才刚好不亏不赚——它不是预测。两边相加是 ',
  },
  afterTotal: { en: ', and the ', zh: '，超出 100 的那 ' },
  afterPoints: {
    en: ' points above 100 are the fee sitting inside both multiples, so they are not probabilities and cannot be read as a pair of them. A pool price says where the money is; on a short coin-flip window that is not the same thing as how likely the move is.',
    zh: ' 个百分点就是嵌在两个倍数里的手续费，所以它们不是概率，也不能当成一对概率来读。池子的价格说明的是钱在哪一边；在这么短的一个近乎抛硬币的窗口里，这和涨跌的可能性并不是一回事。',
  },
} satisfies Record<string, Text>

// ── bet panel ───────────────────────────────────────────────────────────────────────────────────

export const bet = {
  direction: { en: 'Bet direction', zh: '下注方向' },
  amount: { en: 'Amount', zh: '金额' },
  balance: { en: 'Balance:', zh: '余额：' },
  max: { en: 'Max', zh: '全部' },
  noCounterparty: { en: 'no counterparty yet', zh: '还没有对手方' },
  quoteNoteBefore: {
    en: 'Quoted at the book as it stands right now, including your own stake. ',
    zh: '这是按此刻的盘口报的价，已经把你自己这笔本金算进去了。',
  },
  quoteNoteBold: {
    en: 'Odds keep moving until the round locks',
    zh: '赔率会一直变到轮次锁定为止',
  },
  quoteNoteAfter: {
    en: ' — the payout is computed from the final book.',
    zh: '——最终赔付按锁定时的盘口计算。',
  },
  approval: { en: 'Approval', zh: '授权' },
  approvalSize: { en: 'Approval size', zh: '授权额度' },
  approvalExact: { en: 'This bet only', zh: '只授权这一注' },
  approvalUnlimited: { en: 'Unlimited', zh: '不限额' },
  approvalUnlimitedBody: { en: 'no approval again', zh: '以后不用再授权' },
  approving: { en: 'Approving…', zh: '授权中…' },
  placing: { en: 'Placing bet…', zh: '下注中…' },
  betUp: { en: '▲ Bet Up', zh: '▲ 押 UP' },
  betDown: { en: '▼ Bet Down', zh: '▼ 押 DOWN' },
  firstIn: {
    en: 'You are first in this round — if nobody takes the other side, you are refunded in full.',
    zh: '你是这一轮第一个下注的——如果没有人接对面，你的本金全额退回。',
  },
  openedTitle: { en: 'Position open', zh: '仓位已建立' },
  openedBody: {
    en: 'Odds keep moving until this round locks. Your payout is settled from the final book.',
    zh: '赔率会一直变到本轮锁定为止。你的赔付按锁定时的盘口结算。',
  },
} satisfies Record<string, Text>

export function betSideButton(side: 'up' | 'down'): Text {
  return side === 'up' ? { en: '▲ Up', zh: '▲ UP' } : { en: '▼ Down', zh: '▼ DOWN' }
}

export function betTxTitle(side: 'up' | 'down'): Text {
  return side === 'up' ? { en: 'Bet Up', zh: '押 UP' } : { en: 'Bet Down', zh: '押 DOWN' }
}

export function approveTitle(symbol: string): Text {
  return { en: `Approve ${symbol}`, zh: `授权 ${symbol}` }
}

export function ifSideWins(side: 'up' | 'down'): Text {
  return { en: `If ${side} wins`, zh: `${sideName(side)} 赢的话` }
}

export function profitLine(profit: string): Text {
  return { en: `profit ${profit}`, zh: `盈利 ${profit}` }
}

/**
 * A line that mixes prose with numerals the design sets in the mono `num` face.
 *
 * Not a `Text`, because the two languages do not agree on where the numbers go: English closes with
 * "(1,200 left on up)" and 中文 with "（UP 还剩 1,200）", the last two swapped. Flattening either into
 * one string would either lose the mono digits or set a whole Chinese sentence in a mono face.
 */
export type NumSegment = string | { num: string }
export type NumLine = Record<Lang, NumSegment[]>

export function betLimits(args: {
  min: string
  max: string
  sideCap: string
  symbol: string
  left: string
  side: 'up' | 'down'
}): NumLine {
  return {
    en: [
      'Min ',
      { num: args.min },
      ' · max ',
      { num: args.max },
      ' per bet · side cap ',
      { num: args.sideCap },
      ` ${args.symbol} (`,
      { num: args.left },
      ` left on ${args.side})`,
    ],
    zh: [
      '每注最小 ',
      { num: args.min },
      ' · 最大 ',
      { num: args.max },
      ' · 单边上限 ',
      { num: args.sideCap },
      ` ${args.symbol}（${sideName(args.side)} 还剩 `,
      { num: args.left },
      '）',
    ],
  }
}

export function approvalNote(mode: 'exact' | 'unlimited', amountOrSymbol: string): Text {
  return mode === 'exact'
    ? {
        en: `Approves exactly this stake, so the market can never move more than ${amountOrSymbol} — you approve again for the next bet.`,
        zh: `只授权这一笔本金，市场最多动得了 ${amountOrSymbol}——下一注要再授权一次。`,
      }
    : {
        en: `The market can move any amount of your ${amountOrSymbol} until you revoke it, and you never approve again. Revoke by approving 0 in your wallet or any allowance manager.`,
        zh: `在你撤销之前，市场可以动用你任意数量的 ${amountOrSymbol}，而你不用再授权。要撤销就在钱包或任意授权管理工具里把授权额度改成 0。`,
      }
}

// ── positions ───────────────────────────────────────────────────────────────────────────────────

/**
 * 未结算 rather than 处理中: the round has no result yet, and nothing is being \"processed\".
 * 可退款 rather than 已退款: the money is claimable, and this product never pushes funds.
 */
export const positionStatus: Record<PositionStatus, Text> = {
  pending: { en: 'Pending', zh: '未结算' },
  won: { en: 'Won', zh: '赢' },
  lost: { en: 'Lost', zh: '输' },
  refunded: { en: 'Refundable', zh: '可退款' },
  claimed: { en: 'Collected', zh: '已领取' },
}

export const positions = {
  heading: { en: 'Your positions', zh: '我的仓位' },
  both: { en: 'Both', zh: '两边都押' },
  claiming: { en: 'Claiming…', zh: '领取中…' },
  checking: { en: 'Checking…', zh: '核对中…' },
  connect: {
    en: 'Connect your wallet to see your positions.',
    zh: '连接钱包才能看到你的仓位。',
  },
  empty: {
    en: 'No positions in this market yet. Place a bet on the round above and it will show up here.',
    zh: '你在这个市场还没有仓位。在上面的轮次里下一注，它就会出现在这里。',
  },
  colRound: { en: 'Round', zh: '轮次' },
  colSide: { en: 'Side', zh: '方向' },
  colStake: { en: 'Stake', zh: '本金' },
  colResult: { en: 'Result', zh: '结果' },
  colPayout: { en: 'Payout', zh: '赔付' },
  colCollect: { en: 'Collect', zh: '领取' },
  collect: { en: 'Collect', zh: '领取' },
  payoutPending: {
    en: 'Not decided yet — this round has not resolved.',
    zh: '还没有结果——这一轮尚未结算。',
  },
  payoutLost: {
    en: 'The other side won this round, so there is nothing to collect.',
    zh: '这一轮是对面赢，所以没有可领的钱。',
  },
  loadOlder: { en: 'Load older rounds', zh: '加载更早的轮次' },
  searchOlder: { en: 'Search older rounds', zh: '搜索更早的轮次' },
  nothingFoundTitle: { en: 'Nothing collectable has been found yet', zh: '目前还没有找到可领取的轮次' },
  incompleteNote: {
    en: 'Part of your history could not be read just now, so a collectable round may be missing from the count above. Reload before assuming there is nothing left to collect — your stake stays on chain and stays claimable either way.',
    zh: '你的一部分历史刚才没能读出来，所以上面的计数里可能漏掉了某个可领取的轮次。在断定"没得领了"之前先刷新一次——不管怎样，你的本金一直在链上，也一直可以领。',
  },
  footerUnscanned: {
    en: 'The button above collects the rounds found so far — not your whole history, because part of it has not been searched yet.',
    zh: '上面那个按钮领的是目前已经找到的轮次，不是你的全部历史，因为还有一部分没搜过。',
  },
  footerIncomplete: {
    en: 'The button above collects the rounds found so far — part of your history could not be read just now, so there may be more.',
    zh: '上面那个按钮领的是目前已经找到的轮次——你的一部分历史刚才没能读出来，所以可能还有更多。',
  },
  footerCompleteBold: { en: 'Collect all', zh: '全部领取' },
  footerComplete: {
    en: ' covers every collectable round in this market, including ones older than the rows shown here.',
    zh: '涵盖这个市场里每一个可领取的轮次，包括比这里显示的行更早的那些。',
  },
  footerTail: {
    en: 'When there are more than one transaction can carry, the button says exactly how many it is sending, and each batch is re-checked on chain the moment you press it. Collecting is a pull payment: nothing is ever pushed to you during settlement, and claiming is never pausable. A refunded round returns your full stake with no fee taken.',
    zh: '当可领取的轮次超过一笔交易装得下的数量时，按钮会写清楚这一次发送多少个，而且每一批在你按下的那一刻都会重新在链上核对一遍。领取是"你来取"：结算时不会有任何钱被推给你，而领取这个动作永远不会被暂停。作废退回的轮次会把你的本金全额退还，不收手续费。',
  },
  revalidateFailed: {
    en: 'Could not check which of these rounds are still collectable, so nothing was sent.',
    zh: '没能确认这些轮次里哪些还能领，所以什么都没有发送。',
  },
  revalidateUnread: {
    en: 'Could not check which of these rounds are still collectable, so nothing was sent. Your stake stays on chain and stays claimable — try again in a moment.',
    zh: '没能确认这些轮次里哪些还能领，所以什么都没有发送。你的本金一直在链上，也一直可以领——过一会儿再试。',
  },
  nothingLeftTitle: { en: 'Nothing left to collect here', zh: '这里没有可领的了' },
  nothingLeftBody: {
    en: 'These rounds have already been collected. Your positions are being refreshed.',
    zh: '这些轮次已经领过了。正在刷新你的仓位。',
  },
  claimAllTx: { en: 'Collect all', zh: '全部领取' },
  autoClaim: { en: 'Let anyone collect for me', zh: '允许他人替我领取' },
  autoClaimTx: { en: 'Auto-collect setting', zh: '自动领取设置' },
  autoClaimOn: {
    en: 'On. Anyone can now spend their own gas to send your winnings to this address — they cannot send them anywhere else. You can still collect yourself, and you can turn this off at any time.',
    zh: '已开启。现在任何人都可以自掏 gas 把你的赔付打到这个地址——他们没法打去别处。你依然可以自己领取，也可以随时关掉。',
  },
  autoClaimOff: {
    en: 'Off. Nothing is ever pushed at you: your winnings wait in the contract until you collect them. There is no deadline and nobody can stop you.',
    zh: '未开启。不会有任何东西被推给你：你的赔付存在合约里，直到你自己领取。没有期限，也没有人能拦住你。',
  },
  autoClaimBusy: { en: 'Confirming…', zh: '确认中…' },
  // The toggle's description asserts an on-chain fact; until the read lands there is no fact to
  // assert, and "Off" while unknown invites a redundant transaction from someone already opted in.
  autoClaimUnknown: {
    en: 'Reading this setting from the chain…',
    zh: '正在从链上读取这个设置…',
  },
  // A failed read is not an empty history. The empty-state copy invites a bet; showing it over a
  // read failure would tell a user with unclaimed winnings that they have none.
  readFailed: { en: 'Could not read your positions', zh: '读不到你的仓位' },
  readFailedBody: {
    en: 'Nothing is lost — your bets and any winnings live on chain and stay collectable. Retry in a moment.',
    zh: '什么都没有丢——你的注单和赔付都在链上，一直可以领。过一会儿重试。',
  },
} satisfies Record<string, Text>

export function toCollect(amount: string): Text {
  return { en: `${amount} to collect`, zh: `可领 ${amount}` }
}

export function positionsCaption(shown: number, total: string): Text {
  return {
    en: `${shown} of your ${total} rounds in this market, newest first`,
    zh: `你在这个市场的 ${total} 个轮次中的 ${shown} 个，最新的在前`,
  }
}

export function showingRounds(shown: number, total: bigint): Text {
  return {
    en: `Showing ${shown} of ${total.toString()} round${total === 1n ? '' : 's'}.`,
    zh: `${total.toString()} 个轮次里显示了 ${shown} 个。`,
  }
}

export function claimRoundTx(epoch: bigint, lang: Lang): Text {
  return { en: `Claim round #${epoch.toString()}`, zh: `领取${roundNo(epoch, lang)}` }
}

export function txFailedTitle(title: string): Text {
  return { en: `${title} failed`, zh: `${title} · 失败` }
}

/** The Claim-all button's `title`, which is where the batching is explained. */
export function claimAllTitle(args: { batch: number; collectable: number; remaining: number; complete: boolean }): Text {
  const { batch, collectable, remaining: left, complete } = args
  if (left > 0) {
    return {
      en: `Collecting ${batch} of the ${collectable} collectable rounds found — one transaction can only carry so many. Press again for the remaining ${left}.`,
      zh: `这一次领取已找到的 ${collectable} 个可领轮次中的 ${batch} 个——一笔交易装不下更多。再按一次领剩下的 ${left} 个。`,
    }
  }
  if (!complete) {
    return {
      en: `Collect the ${batch} collectable round${batch === 1 ? '' : 's'} found so far — part of your history has not been searched yet, so there may be more`,
      zh: `领取目前找到的 ${batch} 个可领轮次——你的历史还没有全部搜完，可能还有更多`,
    }
  }
  return {
    en: `Collect all ${batch} collectable round${batch === 1 ? '' : 's'}, including any older than the rows shown below`,
    zh: `领取全部 ${batch} 个可领轮次，包括比下面列表更早的那些`,
  }
}

// ── history ─────────────────────────────────────────────────────────────────────────────────────

export const history = {
  heading: { en: 'Recent rounds', zh: '最近的轮次' },
  empty: {
    en: 'No completed rounds yet. The first result appears one interval after the market opens.',
    zh: '还没有跑完的轮次。市场开启一个间隔之后，才会出现第一个结果。',
  },
  caption: {
    en: 'The most recent resolved rounds in this market',
    zh: '这个市场最近已出结果的轮次',
  },
  colRound: { en: 'Round', zh: '轮次' },
  colStrike: { en: 'Strike', zh: '行权价' },
  colSettlement: { en: 'Settlement', zh: '结算价' },
  colMove: { en: 'Move', zh: '涨跌' },
  colWinner: { en: 'Winner', zh: '结果' },
  colPaid: { en: 'Paid', zh: '实付倍数' },
  colPools: { en: 'Pools (up / down)', zh: '池子（UP / DOWN）' },
  verify: { en: 'Verify', zh: '核验' },
  // The buttons under the Verify column say the column's own word — a VERIFY header over a row of
  // Check buttons named one control two ways (中文 already said 核验 for both).
  check: { en: 'Verify', zh: '核验' },
  hide: { en: 'Hide', zh: '收起' },
  // Why the money came back, in words a row can show: an admin void and a blown settlement window
  // are different facts about the market, and the distinction used to live only in a hover title.
  refundReasonVoided: { en: 'voided', zh: '已作废' },
  refundReasonWindow: { en: 'window elapsed', zh: '超时未结算' },
  close: { en: 'Close', zh: '关闭' },
  readBack: {
    en: 'read back from the feed, in your browser',
    zh: '在你的浏览器里从喂价合约读回',
  },
  refunded: { en: 'Refunded', zh: '全额退回' },
  pending: { en: 'Pending', zh: '未结算' },
  refundedVoidedTitle: {
    en: 'This round was voided on chain — every stake comes back in full, with no fee.',
    zh: '这一轮在链上被作废了——每一笔本金全额退回，不收手续费。',
  },
  refundedWindowTitle: {
    en: 'This round’s settlement window elapsed without a settlement, so every stake in it is refundable in full right now.',
    zh: '本轮的结算时限过去了却没有人结算，所以里面每一笔本金现在都可以全额退回。',
  },
  footer: {
    en: '“Refunded” covers a tie, a one-sided book, no usable oracle print at the boundary, a missed settlement window, or a pause that landed before the round locked — in all of those every stake is returned in full and no fee is charged. A round that had already locked when a pause landed settles normally instead. “Paid” is the multiple the winning side actually received.',
    zh: '"全额退回"涵盖平局、单边池、边界时刻没有可用的预言机报价、错过结算时限，以及在该轮锁定之前落下的暂停——这几种情况下每一笔本金都全额退回，不收手续费。而暂停落下时已经锁定的轮次，仍会照常结算。"实付倍数"是赢的那一边实际拿到的倍数。',
  },
} satisfies Record<string, Text>

export function lastNRounds(n: number | string): Text {
  return { en: `last ${n} rounds`, zh: `最近 ${n} 轮` }
}

// ── price chart ─────────────────────────────────────────────────────────────────────────────────

export const chart = {
  heading: { en: 'Oracle price', zh: '预言机价格' },
  subheading: { en: 'the series this round settles on', zh: '本轮据以结算的那条序列' },
  howToRead: { en: 'How to read this chart', zh: '怎么读这张图' },
  style: { en: 'Chart style', zh: '图表样式' },
  line: { en: 'Line', zh: '折线' },
  candles: { en: 'Candles', zh: 'K 线' },
  candlesUnavailable: {
    en: 'This feed has not printed often enough for candles to have bodies — see the note below.',
    zh: '这个喂价的报价太稀疏，K 线画出来没有实体——见下面的说明。',
  },
  upWinsHere: { en: '▲ UP wins here', zh: '▲ 这一侧 UP 赢' },
  downWinsHere: { en: '▼ DOWN wins here', zh: '▼ 这一侧 DOWN 赢' },
  axisStrike: { en: 'strike', zh: '行权价' },
  axisLocked: { en: 'locked', zh: '已锁定' },
  axisStrikeHere: { en: 'strike here', zh: '行权价在此' },
  axisLock: { en: 'lock', zh: '锁定' },
  axisSettles: { en: 'settles', zh: '结算' },
  loadingHistory: { en: 'Reading the feed’s history…', zh: '正在读取喂价的历史…' },
  noPrintInWindow: { en: 'No print inside this round’s window', zh: '本轮窗口里没有任何报价' },
  neverPrinted: { en: 'This feed has not printed yet', zh: '这个喂价还没有出过报价' },
  limitFeedStart: {
    en: 'That is the whole history this feed has, and it begins after this round’s boundary — so no print exists at or before it. A boundary with no usable print cannot be settled, and the round will be refunded in full, with no fee taken, once its settlement window elapses.',
    zh: '这就是这个喂价的全部历史，而它的起点在本轮边界时刻之后——所以边界时刻之前（含那一刻）根本不存在任何报价。没有可用报价的边界无法结算，等本轮的结算时限过去，每一笔本金全额退回，不收手续费。',
  },
  limitPhaseStart: {
    en: 'History here stops at an aggregator phase change: any print that priced this round belongs to the previous phase of the feed and is not read here.',
    zh: '这里的历史止于一次聚合器换代：为本轮定价的那笔报价属于喂价的上一代，这里读不到。',
  },
  limitReadCap: {
    en: 'The chart reads only the most recent prints, so it cannot say from here whether an older print priced this round.',
    zh: '图表只读最近的一段报价，所以从这里判断不了是否有更早的报价为本轮定了价。',
  },
  // The one line each empty-window state must keep VISIBLE — the fact, not the mechanism. Under a
  // capped or phase-limited history the honest fact is uncertainty; only at the feed's own start
  // is "no print exists" a fact, and with it the eventual refund.
  noPrintUncertain: {
    en: 'Whether an older print priced this round cannot be told from the history read here.',
    zh: '单凭这里读到的这段历史，判断不了是否有更早的报价为本轮定了价。',
  },
  noPrintRefund: {
    en: 'No usable print exists at or before this round’s boundary: once its settlement window elapses, every stake refunds in full with no fee.',
    zh: '本轮边界时刻之前（含那一刻）不存在可用报价：等它的结算时限过去，每一笔本金全额退回，不收手续费。',
  },
  nothingToPlot: {
    en: 'There is nothing to plot until the oracle publishes an answer. Until then no round can be priced, and any round whose boundary passes without a print is refunded in full with no fee taken.',
    zh: '在预言机发出第一笔报价之前，没有东西可画。在那之前任何轮次都定不出价格，而边界时刻过去时仍然没有报价的轮次，全额退回，不收手续费。',
  },
  noStrikeBold: { en: 'No strike yet.', zh: '还没有行权价。' },
  notLockedBold: { en: 'Not locked yet.', zh: '还没有锁定。' },
  neverLockedBold: { en: 'This round never locked.', zh: '这一轮从未锁定。' },
  neverLocked: {
    en: ' Its settlement window elapsed with no strike recorded, so there is no reference line: the round can only be refunded in full, with no fee taken.',
    zh: '它的结算时限已经过去，却没有记下任何行权价，所以没有基准线可画：这一轮只能全额退回，不收手续费。',
  },
  dashedBold: { en: 'dashed', zh: '虚线' },
  coversPhaseStart: {
    en: 'History stops at an aggregator phase change: older prints belong to the previous phase of this feed and are not read here.',
    zh: '历史止于一次聚合器换代：更早的报价属于这个喂价的上一代，这里不读取。',
  },
  coversFeedStart: {
    en: 'This is the whole history the feed has — it starts here.',
    zh: '这就是这个喂价的全部历史——它就是从这里开始的。',
  },
  coversReadCap: {
    en: 'History is capped at the most recent prints, so the window is only partly filled.',
    zh: '历史只取最近的一段报价，所以这个窗口只填了一部分。',
  },
  coversLoading: { en: 'Earlier prints are still loading.', zh: '更早的报价还在加载。' },
} satisfies Record<string, Text>

/**
 * What the settlement feed is, in words. Passed into the chart rather than built there, because it
 * depends on which chain the bundle was built for.
 */
export function feedName(relay: boolean): Text {
  return relay
    ? {
        en: 'plotted from the market’s own relay feed, the series it settles on — not an exchange price',
        zh: '画的是这个市场自己的中继喂价，也就是它结算所依据的那条序列——不是交易所价格',
      }
    : {
        en: 'plotted from the market’s own Chainlink feed, the series it settles on — not an exchange price',
        zh: '画的是这个市场自己的 Chainlink 喂价，也就是它结算所依据的那条序列——不是交易所价格',
      }
}

/**
 * The chart's `role=\"img\"` description.
 *
 * The feed clause is a trailing sentence rather than a noun in front of \"price\": spliced in as a
 * modifier it produced \"…not an exchange price price between 10:00 and 10:05\" — a duplicated word
 * in the one string a blind reader has instead of the picture.
 */
export function chartAria(args: { from: string; to: string; strike?: string; feed: string }): Text {
  const strikeEn = args.strike ? `, strike ${args.strike}` : ', no strike yet'
  const strikeZh = args.strike ? `，行权价 ${args.strike}` : '，尚无行权价'
  return {
    en: `Oracle price between ${args.from} and ${args.to}${strikeEn} — ${args.feed}.`,
    zh: `预言机价格，从 ${args.from} 到 ${args.to}${strikeZh}——${args.feed}。`,
  }
}

export function feedAgeBadgeTitle(budget: number, stale: boolean): Text {
  return stale
    ? {
        en: `The last print is older than this round’s ${budget}s oracle budget: a boundary now could not be priced, and the round would refund in full.`,
        zh: `最后一笔报价已经超出本轮 ${budget} 秒的预言机时限：现在的边界时刻根本定不出价格，这一轮会全额退回。`,
      }
    : {
        en: `Age of the newest print. Past ${budget}s a boundary cannot be priced and the round refunds.`,
        zh: `最新一笔报价距今多久。超过 ${budget} 秒，边界时刻就定不出价格，轮次退款。`,
      }
}

export function candlesTitle(bucketSec: number): Text {
  return {
    en: `OHLC of the oracle prints in each ${bucketSec}s bucket`,
    zh: `每 ${bucketSec} 秒一根，取该区间内预言机报价的开高低收`,
  }
}

/** Split around the two timestamps, which render as their own `<span class="num">`s. */
export const noPrintExplain = {
  before: {
    en: 'Every print read here is newer than this window: the oldest is from ',
    zh: '这里读到的每一笔报价都比这个窗口更新：最早的一笔来自 ',
  },
  middle: { en: ', and the window closes at ', zh: '，而窗口在 ' },
  after: { en: '. ', zh: ' 结束。' },
} satisfies Record<string, Text>

/** Split around the feed clause and the budget, both of which render as their own spans. */
export const strikeSetNote = {
  before: {
    en: 'Above the dashed line UP wins, below it DOWN wins. ',
    zh: '虚线以上 UP 赢，以下 DOWN 赢。',
  },
  middle: {
    en: '; the value between prints is the last print — exactly how the contract reads it, so the line is drawn as steps, and it stops after ',
    zh: '；两笔报价之间的取值就是上一笔报价——合约就是这么读的，所以线画成阶梯状；而它在 ',
  },
  after: {
    en: ' because past that a boundary has no usable price at all.',
    zh: '之后就断开，因为再往后，边界时刻根本没有可用价格。',
  },
} satisfies Record<string, Text>

export const strikeOnlyNote = {
  before: { en: 'This round’s strike is ', zh: '本轮的行权价是 ' },
  after: { en: ', and ', zh: '；' },
  end: { en: '.', zh: '。' },
} satisfies Record<string, Text>

export const noStrikeNote = {
  before: {
    en: ' This round is still taking bets — its strike is the feed print at or before ',
    zh: '本轮还在接受下注——它的行权价是 ',
  },
  after: {
    en: ', so there is no line to draw until then, and no side is winning or losing yet.',
    zh: ' 之前（含那一刻）的那笔喂价报价，所以在那之前没有线可画，也谈不上哪一边输赢。',
  },
} satisfies Record<string, Text>

export const awaitingStrikeNote = {
  before: {
    en: ' This round’s strike is already decided — it is the feed print at or before ',
    zh: '本轮的行权价其实已经定了——就是 ',
  },
  middle: {
    en: ', and that set of prints is frozen — but no ',
    zh: ' 之前（含那一刻）的那笔报价，符合条件的报价集合已经冻结——只是还没有任何一次 ',
  },
  after: {
    en: ' call has recorded it on chain, so there is nothing to draw against yet. Anyone may make that call, and being late cannot change the price it records.',
    zh: ' 调用把它写到链上，所以暂时没有可对照的基准线。任何人都可以去发起这个调用，而调用得早或晚，都不会改变它记录下来的价格。',
  },
} satisfies Record<string, Text>

export const dashedNote = {
  before: { en: 'The ', zh: '' },
  middle: {
    en: ' stretches are where the feed had gone quiet for longer than this round’s ',
    zh: '段是喂价安静的时间超过了本轮 ',
  },
  after: {
    en: ' oracle budget. A boundary landing in one of them cannot be priced at all — not stale, but absent — so that round is refunded in full with no fee.',
    zh: '预言机时限的部分。落在这些区间里的边界时刻根本定不出价格——不是价格滞后，而是压根没有——所以那一轮全额退回，不收手续费。',
  },
} satisfies Record<string, Text>

/** `90s` / `90 秒`: the round's own oracle budget, wherever it is set in the mono `num` face. */
export function budgetSpan(budget: number, lang: Lang): string {
  return lang === 'zh' ? `${budget} 秒` : `${budget}s`
}

/**
 * The stale feed's consequence for money — the one chart warning that stays on the trading
 * surface in every view. Until this existed the consequence lived only in the badge's hover
 * title, mute on every phone.
 */
export function staleCandlesNote(budget: string): Text {
  return {
    en: `The feed has been quiet past this round's ${budget} oracle budget: a boundary landing now cannot be priced at all, and that round is refunded in full with no fee taken.`,
    zh: `喂价安静的时间已经超过本轮 ${budget}的预言机时限：现在落下的边界时刻根本定不出价格，那一轮会全额退回，不收手续费。`,
  }
}

export function feedQuietNow(ago: string): Text {
  return {
    en: ` The feed is in that state right now: nothing has printed for ${ago}.`,
    zh: `喂价现在就处于这种状态：已经 ${ago}没有出过报价了。`,
  }
}

export function candlesNote(bucketSec: number, perBucket: string): Text {
  return {
    en: `Candles are the real open / high / low / close of the oracle prints inside each ${bucketSec}s bucket — ${perBucket} prints per bucket on average. A bucket the feed did not print in is left empty rather than filled with a made-up candle.`,
    zh: `K 线画的是每 ${bucketSec} 秒区间内预言机报价真实的开、高、低、收——平均每个区间 ${perBucket} 笔报价。喂价没有出过报价的区间就留空，而不是补一根编出来的 K 线。`,
  }
}

export function candlesOffNote(perBucket: string): Text {
  return {
    en: `Candles are off because this feed is too sparse for them: an oracle print is a point in time, not an OHLC bar, so a candle here can only be the open/high/low/close of the prints inside a bucket — and at ${perBucket} prints per bucket almost every candle would be a bodyless doji. That would look like a flat market when the truth is a quiet feed.`,
    zh: `K 线被关掉了，因为这个喂价对它来说太稀疏：一笔预言机报价是一个时间点，不是一根 OHLC，所以这里的 K 线只能是区间内那几笔报价的开高低收——而平均每个区间只有 ${perBucket} 笔的时候，几乎每根都会是没有实体的十字线。那看起来像行情不动，事实却只是喂价很安静。`,
  }
}

// ── toasts / transactions ───────────────────────────────────────────────────────────────────────

export const toast = {
  region: { en: 'Notifications', zh: '通知' },
  viewTx: { en: 'View transaction', zh: '查看交易' },
  dismiss: { en: 'Dismiss notification', zh: '关闭通知' },
  confirmInWallet: { en: 'Confirm in your wallet…', zh: '在钱包里确认…' },
  waiting: { en: 'Waiting for confirmation…', zh: '等待链上确认…' },
  reverted: { en: 'The transaction was reverted on chain.', zh: '这笔交易在链上被回滚了。' },
  stillPending: {
    en: 'Your transaction was submitted but has not confirmed yet. Check the explorer before sending it again.',
    zh: '你的交易已经发出去了，但还没有确认。再发一次之前，先去区块浏览器看一眼。',
  },
  // A wallet "cancel" mines a replacement transaction whose receipt reads success — success for
  // the cancellation, not for the action. Reporting it as "confirmed" would tell the user their
  // money moved at the exact moment they made sure it did not.
  cancelled: {
    en: 'You cancelled or replaced this transaction in your wallet, so the original was never executed.',
    zh: '你在钱包里把这笔交易取消或者替换掉了，原来那一笔没有执行。',
  },
} satisfies Record<string, Text>

/**
 * A transaction's own name, plus what happened to it.
 *
 * 中文 joins with `·` rather than a space: the titles mix Latin and CJK (`押 UP`, `全部领取`), and a
 * bare space reads as a missing word after one of them and as a typo after the other.
 */
export function txConfirmed(title: string): Text {
  return { en: `${title} confirmed`, zh: `${title} · 已确认` }
}

export function txFailed(title: string): Text {
  return { en: `${title} failed`, zh: `${title} · 失败` }
}

export function txStillPending(title: string): Text {
  return { en: `${title} still pending`, zh: `${title} · 仍未确认` }
}

export function txCancelled(title: string): Text {
  return { en: `${title} cancelled`, zh: `${title} · 已取消` }
}

// ── app shell ───────────────────────────────────────────────────────────────────────────────────

export const app = {
  loadingRound: { en: 'Loading round', zh: '正在加载轮次' },
  marketReadFailed: { en: 'Could not read this market', zh: '读不到这个市场' },
  retry: { en: 'Retry', zh: '重试' },
  notOpenBold: { en: 'This market has not opened yet.', zh: '这个市场还没有开启。' },
  notOpenBefore: { en: ' The owner still has to call ', zh: '第一轮开始之前，管理员还得调用一次 ' },
  notOpenAfter: { en: ' before the first round begins.', zh: '。' },
  registryFallback: {
    en: 'The registry could not be read, so markets are listed from the deployment file instead.',
    zh: '注册表读不到，所以这里的市场列表来自部署文件。',
  },
  market: { en: 'Market', zh: '市场' },
  feed: { en: 'Feed', zh: '喂价合约' },
  registry: { en: 'Registry', zh: '注册表' },
  footer: {
    en: 'Non-custodial and parimutuel: there is no house. The winning side splits the losing side’s pool and the fee is charged on the losing pool only, so a winner is never paid less than their own stake. Nothing here is financial advice.',
    zh: '非托管、平价池（同注分彩）：这里没有庄家。赢的一方瓜分输的一方的池子，手续费只从输的那一边收，所以赢家拿到的钱永远不会少于自己的本金。本页内容不构成任何投资建议。',
  },
} satisfies Record<string, Text>

export function noMarkets(lang: Lang): Text {
  return {
    en: `No markets available on ${activeChain.name}`,
    zh: `${chainLabel(lang)}上没有可用的市场`,
  }
}

export const noMarketsBody = {
  before: { en: 'The registry at ', zh: '注册表 ' },
  after: { en: ' has no enabled markets yet.', zh: ' 还没有启用任何市场。' },
} satisfies Record<string, Text>
