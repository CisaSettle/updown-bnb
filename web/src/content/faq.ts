/**
 * The product's own explanation of itself, in English and 中文.
 *
 * Kept as data rather than JSX so the copy can be reviewed as prose, and so the same text can be
 * rendered in the app and lifted into the docs without drifting apart. Every claim here is
 * checkable against the chain — where a section describes a number, it also says how to read that
 * number yourself.
 */

export type Lang = 'en' | 'zh'

export interface FaqBlock {
  /** A short paragraph. */
  p?: { en: string; zh: string }
  /** A bullet list. */
  ul?: { en: string; zh: string }[]
  /** A labelled sequence of steps a reader can actually follow. */
  steps?: { title: { en: string; zh: string }; body: { en: string; zh: string } }[]
  /** A code block, shown verbatim in both languages. */
  code?: string
  /** A short caption for a code block. */
  caption?: { en: string; zh: string }
  /** A two-column table. */
  table?: { head: { en: string; zh: string }[]; rows: { en: string; zh: string }[][] }
  /** A callout that carries a warning or a promise. */
  note?: { en: string; zh: string }
}

export interface FaqEntry {
  id: string
  q: { en: string; zh: string }
  blocks: FaqBlock[]
}

export interface FaqSection {
  id: string
  title: { en: string; zh: string }
  entries: FaqEntry[]
}

export const FAQ: FaqSection[] = [
  // ───────────────────────────────────────────────────────────────────────────
  {
    id: 'product',
    title: { en: 'The product', zh: '这是什么' },
    entries: [
      {
        id: 'what',
        q: { en: 'What is UpDown?', zh: 'UpDown 是什么？' },
        blocks: [
          {
            p: {
              en: 'A binary option on price, settled entirely on BNB Smart Chain. You pick UP or DOWN on BTC or BNB over a fixed round — 5 minutes or 1 hour. When the round locks, an on-chain price becomes the strike; when it closes, another on-chain price decides the outcome. The winning side splits the losing side’s stake.',
              zh: '一个完全在 BNB 智能链上结算的价格二元期权。你在一个固定时长的轮次里（5 分钟或 1 小时）押 BTC 或 BNB 的涨或跌。轮次锁定时，一个链上价格成为行权价；轮次结束时，另一个链上价格决定结果。赢的一方瓜分输的一方的本金。',
            },
          },
          {
            p: {
              en: 'It is non-custodial. Your stake sits in a contract whose code is public and verified, and no key — including the admin’s — can move it anywhere except to whoever the round’s rules say it belongs to.',
              zh: '它是非托管的。你的本金放在一个代码公开且已验证的合约里，任何私钥——包括管理员的——都无法把它转去轮次规则规定的收款人之外的任何地方。',
            },
          },
          {
            note: {
              en: 'You can never lose more than you stake, and there is no liquidation, no margin and no counterparty who can fail to pay you. The money that pays a winner is already in the contract before the round settles.',
              zh: '你的最大损失就是你押进去的钱，没有杠杆、没有强平、没有可能赖账的对手方。赔付给赢家的钱在轮次结算之前就已经躺在合约里了。',
            },
          },
        ],
      },
      {
        id: 'round',
        q: { en: 'How does one round work?', zh: '一个轮次是怎么走的？' },
        blocks: [
          {
            steps: [
              {
                title: { en: 'Betting is open', zh: '开放下注' },
                body: {
                  en: 'For one interval, anyone can stake on UP or DOWN. There is no strike yet — it does not exist until the round locks.',
                  zh: '持续一个间隔时长，任何人都可以押 UP 或 DOWN。这个阶段还没有行权价——它要到锁定那一刻才存在。',
                },
              },
              {
                title: { en: 'The round locks', zh: '锁定' },
                body: {
                  en: 'Betting closes and the strike (lockPrice) is recorded from the oracle. Everyone in the round shares the same strike.',
                  zh: '下注关闭，行权价（lockPrice）从预言机记录下来。这一轮里所有人共用同一个行权价。',
                },
              },
              {
                title: { en: 'The position runs', zh: '持仓中' },
                body: {
                  en: 'For another interval nothing can be added or withdrawn. The price moves.',
                  zh: '再持续一个间隔时长，既不能加注也不能退出。价格自由波动。',
                },
              },
              {
                title: { en: 'The round settles', zh: '结算' },
                body: {
                  en: 'The settlement price (closePrice) is recorded. Above the strike, UP wins; below it, DOWN wins; exactly equal is a tie and everyone is refunded.',
                  zh: '结算价（closePrice）被记录。高于行权价 UP 赢，低于行权价 DOWN 赢，正好相等算平局、全员退款。',
                },
              },
              {
                title: { en: 'You collect', zh: '领取' },
                body: {
                  en: 'Winnings and refunds are pulled, not pushed: you call claim when you want the money. There is no deadline and no one can stop you.',
                  zh: '赔付和退款是"你来取"而不是"我来发"：你想拿钱的时候自己调 claim。没有截止时间，也没有任何人能拦住你。',
                },
              },
            ],
          },
          {
            p: {
              en: 'One round’s close is the next round’s lock, so consecutive rounds share a single boundary price and there is no gap between them.',
              zh: '一轮的结算时刻就是下一轮的锁定时刻，所以相邻两轮共用同一个边界价格，中间没有缝隙。',
            },
          },
        ],
      },
    ],
  },

  // ───────────────────────────────────────────────────────────────────────────
  {
    id: 'prices',
    title: { en: 'The two prices, and how to check them', zh: '两个价格，以及怎么复查' },
    entries: [
      {
        id: 'no-entry-price',
        q: { en: 'What price did I enter at?', zh: '我的下单价格是多少？' },
        blocks: [
          {
            p: {
              en: 'None — and this is the most important thing to understand about the product. There is no per-user entry price. The strike belongs to the round, not to your order: whether you bet in the first second of the betting window or the last, you get exactly the same strike as everyone else in that round.',
              zh: '没有——而这是理解本产品最重要的一点。这里不存在"每个人各自的下单价"。**行权价属于轮次，不属于你的订单**：无论你是在下注窗口的第一秒还是最后一秒下注，你拿到的行权价和这一轮里所有人完全相同。',
            },
          },
          {
            p: {
              en: 'That is a deliberate difference from a centralised event contract, where the strike is the index price at the moment your order is filled. Here everyone in a round is betting on the same question with the same reference point, which is what makes the pool split fair and what makes the whole round checkable from one pair of numbers.',
              zh: '这是与中心化事件合约的一个刻意区别——在那类产品里，行权价是你下单成交那一刻的指数价。而这里，同一轮次里所有人押的是同一个问题、同一个参照点，这既是池子按比例分配得以公平的前提，也是整轮可以用一对数字就核查清楚的原因。',
            },
          },
          {
            p: {
              en: 'What varies with timing is not your price but your odds: the pools move as people bet, so betting early or late changes the multiple you are quoted. The multiple is fixed for you at the moment the round locks, not at the moment you bet.',
              zh: '随时间变化的不是你的价格，而是你的**赔率**：池子随着有人下注而变动，早下注和晚下注拿到的倍数不同。而这个倍数对你而言是在**轮次锁定的那一刻**才最终确定的，不是在你下注的那一刻。',
            },
          },
        ],
      },
      {
        id: 'which-price',
        q: { en: 'Where exactly does the price come from?', zh: '价格到底来自哪里？' },
        blocks: [
          {
            p: {
              en: 'From a Chainlink-shaped price feed, on chain, read by the contract itself. The market records which feed it uses and you can read it directly. On BNB Chain mainnet that is Chainlink’s aggregated BTC/USD or BNB/USD feed — a price assembled from many exchanges, not one.',
              zh: '来自一个 Chainlink 形态的链上价格喂价，由合约自己读取。市场合约会记录它使用哪个喂价，你可以直接去读。在 BNB 链主网上，那就是 Chainlink 的 BTC/USD 或 BNB/USD 聚合喂价——由多家交易所汇总而成，而不是某一家。',
            },
          },
          {
            note: {
              en: 'On BSC testnet the feed is a relay this project runs, because the testnet’s own Chainlink feeds go up to 25 minutes stale and every 5-minute round would void. That is a testnet-only substitution and the deploy script refuses to put it on mainnet.',
              zh: '在 BSC 测试网上，喂价是本项目自己运行的一个中继（RelayAggregator），因为测试网自带的 Chainlink 喂价最长会滞后 25 分钟，那样每个 5 分钟轮次都会作废。这是仅限测试网的替代方案，部署脚本会拒绝把它部署到主网。',
            },
          },
          {
            p: {
              en: 'The price the chart shows is that same feed. It is deliberately not a candlestick series from an exchange: if the chart showed one price and the contract settled on another, the chart would be lying to you about the only thing that matters.',
              zh: '图表上画的就是同一个喂价。它刻意不是某个交易所的 K 线：如果图表给你看一个价格、合约却用另一个价格结算，那这张图就是在唯一重要的事情上骗你。',
            },
          },
        ],
      },
      {
        id: 'settlement-rule',
        q: { en: 'What exactly is the settlement rule?', zh: '结算机制究竟是什么？' },
        blocks: [
          {
            p: {
              en: 'A round’s price is the last feed print at or before that round’s boundary timestamp. Not "the price when someone got round to settling it" — the price as of a specific second, fixed by the round’s schedule before the round ever opened.',
              zh: '一个轮次的价格，是**该轮边界时刻之前（含该时刻）的最后一笔喂价**。不是"某人想起来去结算时的价格"——而是某个特定秒的价格，这个秒在轮次开始之前就由时间网格确定好了。',
            },
          },
          {
            p: {
              en: 'Whoever settles the round hands the contract a feed round id, and the contract proves it is the right one: the print must be at or before the boundary, must be recent enough that the feed was genuinely alive there, and must be the last one that qualifies — either the feed’s newest print, or the very next print must already be past the boundary. A wrong id does not settle the round at a wrong price; the transaction simply reverts.',
              zh: '来结算的人把一个喂价轮次 id 交给合约，合约会**证明**它是对的：这笔报价必须在边界时刻或之前、必须足够新以证明喂价当时确实活着、并且必须是符合条件的最后一笔——要么它就是喂价的最新一笔，要么紧接着的下一笔已经越过了边界。交错 id 不会导致按错误价格结算，那笔交易只会直接失败。',
            },
          },
          {
            p: {
              en: 'Because the qualifying set of prints is frozen the moment the boundary second has passed, the settlement price is a pure function of the boundary. Calling one second late and calling three minutes late give byte-identical outcomes. Nobody — not the project, not a bot, not a whale — can improve their result by choosing when to settle.',
              zh: '由于边界那一秒过去之后，符合条件的报价集合就永久冻结了，**结算价是边界时刻的纯函数**。晚一秒调用和晚三分钟调用，结果一模一样。没有任何人——项目方、机器人、巨鲸——能通过选择结算时机来改善自己的结果。',
            },
          },
          {
            note: {
              en: 'Settling is permissionless. There is no operator role and no privileged settler; anyone can turn the crank, and the winners are the ones with a reason to. The project runs a keeper because someone should do it promptly, not because the keeper is trusted.',
              zh: '结算是**无许可**的。没有 operator 角色，也没有特权结算者；任何人都能推动它，而有动力去推动的正是赢家。项目方运行一个 keeper，是因为总得有人及时去做，而不是因为这个 keeper 被信任。',
            },
          },
        ],
      },
      {
        id: 'verify',
        q: {
          en: 'How do I check the strike and the settlement price myself?',
          zh: '我怎么自己复查行权价和结算价？',
        },
        blocks: [
          {
            p: {
              en: 'In four reads, none of which involve trusting this page. Every round records which feed round it used, so you can go straight to the feed and read the same number the contract read.',
              zh: '四步读取，全程不需要相信这个页面。每一轮都记录了它用的是哪一笔喂价，所以你可以直接去喂价合约读出合约当初读到的同一个数字。',
            },
          },
          {
            steps: [
              {
                title: { en: '1 · Read the round', zh: '1 · 读取轮次' },
                body: {
                  en: 'Call getRound(epoch) on the market. It returns lockPrice, closePrice and — the key part — lockOracleId and closeOracleId: the exact feed rounds the contract used.',
                  zh: '对市场合约调用 getRound(epoch)。它会返回 lockPrice、closePrice，以及关键的 lockOracleId 和 closeOracleId——合约当初使用的那两笔喂价的精确编号。',
                },
              },
              {
                title: { en: '2 · Read those feed rounds', zh: '2 · 读取那两笔喂价' },
                body: {
                  en: 'Call getRoundData(lockOracleId) and getRoundData(closeOracleId) on the market’s oracle() address. Each returns the answer and the timestamp it was published.',
                  zh: '对市场的 oracle() 地址调用 getRoundData(lockOracleId) 和 getRoundData(closeOracleId)。每个都会返回价格和它被发布的时间戳。',
                },
              },
              {
                title: { en: '3 · Compare', zh: '3 · 比对' },
                body: {
                  en: 'The answers must equal lockPrice and closePrice exactly. Prices carry 8 decimals, so 7877399000000 is 78,773.99.',
                  zh: '返回的价格必须与 lockPrice、closePrice 完全相等。价格是 8 位小数，所以 7877399000000 就是 78,773.99。',
                },
              },
              {
                title: { en: '4 · Check the timing', zh: '4 · 核对时间' },
                body: {
                  en: 'Each print’s updatedAt must be at or before its boundary (lockTs, closeTs) and no older than the market’s oracleMaxAge. That is the whole rule, and you have just checked it.',
                  zh: '每笔报价的 updatedAt 必须在其边界（lockTs、closeTs）之前或恰好等于它，且与边界的间隔不超过市场的 oracleMaxAge。整条规则就这些，你刚刚已经验完了。',
                },
              },
            ],
          },
          {
            caption: {
              en: 'A real settled round on BSC testnet, checked end to end:',
              zh: 'BSC 测试网上一个真实已结算轮次的完整复查：',
            },
            code: `# 1 · the round, from the market
$ cast call $MARKET "getRound(uint256)" 9 --rpc-url $RPC
  lockTs        1787721000
  closeTs       1787721300
  lockPrice     7877399000000     # 78,773.99
  closePrice    7893064000000     # 78,930.64
  lockOracleId  10
  closeOracleId 11

# 2 · those exact feed rounds, from the oracle
$ cast call $FEED "getRoundData(uint80)" 10 --rpc-url $RPC
  answer      7877399000000       # matches lockPrice
  updatedAt   1787720962          # 38s before lockTs, inside the 150s budget

$ cast call $FEED "getRoundData(uint80)" 11 --rpc-url $RPC
  answer      7893064000000       # matches closePrice
  updatedAt   1787721267          # 33s before closeTs, inside the budget

# closePrice > lockPrice, so UP won this round.`,
          },
          {
            note: {
              en: 'You can do all of this in a browser on BscScan’s Read Contract tab for the market and the feed — no tooling required. The app also runs this check for you on every round and shows you the result, but the point is that you never have to take its word for it.',
              zh: '这些你都可以在浏览器里用 BscScan 的 Read Contract 页面对市场合约和喂价合约完成，不需要任何工具。本应用也会为每一轮自动跑一遍这个核对并把结果显示给你——但重点在于，你从来不必相信它的说法。',
            },
          },
        ],
      },
    ],
  },

  // ───────────────────────────────────────────────────────────────────────────
  {
    id: 'odds',
    title: { en: 'Odds and payouts', zh: '赔率与赔付' },
    entries: [
      {
        id: 'how-odds',
        q: { en: 'Where do the odds come from?', zh: '赔率是怎么来的？' },
        blocks: [
          {
            p: {
              en: 'From the two pools, and nothing else. There is no house setting a price and no order book. Whatever is staked on the losing side is shared out among the winning side in proportion to their stakes.',
              zh: '完全来自两个池子，别无其他。没有庄家定价，也没有订单簿。输的一方押进去的钱，按各自本金的比例分给赢的一方。',
            },
          },
          {
            p: {
              en: 'So the multiple on a side is (that side + the other side, less the fee) ÷ that side. The smaller side always pays more, and the numbers move as people bet — right up until the round locks, which is when your multiple is fixed.',
              zh: '所以某一侧的倍数 =（这一侧 + 另一侧扣除手续费后）÷ 这一侧。人少的一侧永远赔得更高，而这些数字会随着下注不断变化——直到轮次锁定的那一刻，你的倍数才最终固定。',
            },
          },
          {
            note: {
              en: 'The "implied chance" shown next to each multiple is just 1 ÷ multiple. The two sides add up to slightly more than 100% because the fee is inside both — that gap is the fee, not a mispricing, and the app shows it explicitly.',
              zh: '每个倍数旁边显示的"隐含概率"就是 1 ÷ 倍数。两侧加起来会略高于 100%，因为手续费包含在两者之中——那个差额就是手续费，不是定价错误，应用会把它明确标出来。',
            },
          },
        ],
      },
      {
        id: 'fee',
        q: { en: 'What is the fee, and who pays it?', zh: '手续费是多少，谁付？' },
        blocks: [
          {
            p: {
              en: '3%, and it is taken only from the losing pool. A winner is therefore never paid less than the money they staked — the fee comes out of what they won, never out of what they put in.',
              zh: '3%，而且**只从输方池抽取**。因此赢家拿到的钱永远不会少于自己押进去的本金——手续费出自他赢来的部分，绝不动他的本金。',
            },
          },
          {
            p: {
              en: 'The common way to build this charges the fee on the total pool, which quietly eats into the winner’s own stake. A 100 stake into a 1000-vs-1000 book returns 194 there, and 197 here. The odds you are quoted are the odds you are paid.',
              zh: '常见的做法是从**总池**抽成，那会悄悄吃掉赢家自己的本金。在 1000 对 1000 的盘口里押 100，那种做法赔 194，本产品赔 197。**报给你的赔率，就是付给你的赔率。**',
            },
          },
        ],
      },
      {
        id: 'refund',
        q: { en: 'When do I get my money back instead?', zh: '什么情况下会原样退钱？' },
        blocks: [
          {
            p: {
              en: 'Whenever a round cannot be settled honestly. In every one of these cases the round is voided and every stake — winning side and losing side alike — is returned in full, with no fee taken at all:',
              zh: '任何一轮无法被诚实结算的时候。在下列每一种情况下，该轮都会作废，**双方所有本金原样全额退回，一分手续费都不收**：',
            },
          },
          {
            ul: [
              {
                en: 'A tie — the settlement price lands exactly on the strike.',
                zh: '平局——结算价正好落在行权价上。',
              },
              {
                en: 'A one-sided book — nobody took the other side, so there was nothing to win from.',
                zh: '单边池——没有人押另一边，所以根本无从赢起。',
              },
              {
                en: 'The feed went dark — no usable price existed at the boundary before the round’s window ran out.',
                zh: '喂价中断——在该轮时限用尽之前，边界时刻不存在可用的价格。',
              },
              {
                en: 'Nobody settled the round in time — the window elapsed, so it can no longer be settled at all.',
                zh: '没有人及时结算——时限已过，该轮从此不可能再被结算。',
              },
              {
                en: 'The market was paused while your round was live.',
                zh: '你的轮次进行中时市场被暂停。',
              },
            ],
          },
          {
            note: {
              en: 'A stuck round frees itself. If nobody ever settles it, it becomes refundable on a timer with no transaction from anyone and no action from the project — you just claim. Claiming is not pausable and has no owner check, so there is no state in which your money is locked in and someone else holds the key.',
              zh: '卡住的轮次会自己解开。如果没有任何人去结算它，它会在时限到达后**自动转为可退款**——不需要任何人发交易，也不需要项目方做任何事，你直接领取即可。领取功能不受暂停影响、也没有任何权限检查，因此不存在"你的钱被锁住而钥匙在别人手里"的状态。',
            },
          },
        ],
      },
    ],
  },

  // ───────────────────────────────────────────────────────────────────────────
  {
    id: 'trust',
    title: { en: 'What you have to trust', zh: '你需要信任什么' },
    entries: [
      {
        id: 'admin',
        q: { en: 'What can the admin do?', zh: '管理员能做什么？' },
        blocks: [
          {
            table: {
              head: [
                { en: 'Can', zh: '可以' },
                { en: 'Cannot', zh: '不可以' },
              ],
              rows: [
                [
                  { en: 'Pause the market, which stops new bets and refunds live rounds in full', zh: '暂停市场——停止新下注，并让进行中的轮次全额退款' },
                  { en: 'Touch your principal or your unclaimed winnings, by any path at all', zh: '通过任何途径动你的本金或未领取的赔付' },
                ],
                [
                  { en: 'Change the fee and the limits — but only for rounds that start afterwards', zh: '修改手续费和限额——但只对之后开始的轮次生效' },
                  { en: 'Block, delay or reverse a withdrawal — claiming is not pausable and has no owner check', zh: '阻止、拖延或撤销一次提取——领取不受暂停影响且无权限检查' },
                ],
                [
                  { en: 'Withdraw the accrued protocol fee', zh: '提取已累计的协议手续费' },
                  { en: 'Choose, supply or override a settlement price', zh: '选择、提供或覆盖任何结算价格' },
                ],
                [
                  { en: 'Replace the price feed, and only while the market is paused', zh: '更换价格喂价，且只能在市场暂停时进行' },
                  { en: 'Settle, un-void or un-expire a round, or revive one that already expired', zh: '结算、撤销作废、撤销过期，或让已过期的轮次复活' },
                ],
                [
                  { en: 'Hand ownership to another address, in two steps', zh: '把所有权分两步移交给另一个地址' },
                  { en: 'Renounce ownership — it is disabled, because an ownerless market could never be paused or repaired again', zh: '放弃所有权——该功能已被禁用，因为无主的市场将永远无法暂停或修复' },
                ],
              ],
            },
          },
          {
            note: {
              en: 'The honest part: pausing is worth money to an owner who is also betting. Once a settlement price is visible, an owner who can see they are losing could pause instead of letting the round settle, and get their stake back. It cannot take your money — it can only cancel a round — but it is a real option, and it is why the mainnet owner is a multisig behind a time delay: by the time a pause could land, the round has already settled.',
              zh: '说实话的部分：暂停对一个同时下注的 owner 来说是有价值的。一旦结算价可见，看到自己要输的 owner 可以选择暂停而不是让轮次结算，从而拿回本金。它拿不走你的钱——只能取消一个轮次——但这确实是一个真实存在的期权，也正是主网 owner 必须是**带时间锁的多签**的原因：等一笔暂停交易能够生效时，那一轮早就结算完了。',
            },
          },
        ],
      },
      {
        id: 'risks',
        q: { en: 'What are the real risks?', zh: '真实的风险有哪些？' },
        blocks: [
          {
            ul: [
              {
                en: 'You can lose your whole stake. A binary option is all-or-nothing, and a 5-minute price move is close to a coin flip before fees — the 3% fee means a random bettor loses money over time.',
                zh: '你可能亏光押进去的钱。二元期权是全有或全无，而 5 分钟的价格波动在扣费之前接近抛硬币——3% 的手续费意味着随机下注的人长期必然亏损。',
              },
              {
                en: 'Smart contract risk. The code has been through several rounds of adversarial review and a large test suite, and it is verified on chain so you can read it, but no review makes a contract certainly correct.',
                zh: '智能合约风险。这份代码经过多轮对抗式评审和大量测试，并且已在链上完成源码验证、你可以自己读——但没有任何评审能保证一份合约绝对无误。',
              },
              {
                en: 'Oracle risk. Settlement is only as good as the feed. A feed that stops publishing voids rounds into refunds rather than settling them wrongly, which is the safe failure, but a feed reporting a wrong price would settle a wrong outcome.',
                zh: '预言机风险。结算的可靠性上限就是喂价的可靠性。喂价停止发布时，轮次会作废退款而不是错误结算——这是安全的失败方式；但如果喂价报出错误价格，就会导致错误的结算结果。',
              },
              {
                en: 'Thin books. In a round where almost nobody took your side, your multiple is large but the round may void for want of a counterparty — you get your stake back, not a win.',
                zh: '盘口太薄。在几乎没人押你这一边的轮次里，你的倍数会很高，但该轮也可能因为没有对手方而作废——你拿回的是本金，不是赢利。',
              },
              {
                en: 'This is testnet. Until a mainnet deployment exists, everything here uses valueless test tokens.',
                zh: '当前是测试网。在主网部署存在之前，这里的一切使用的都是没有价值的测试代币。',
              },
            ],
          },
        ],
      },
    ],
  },
]
