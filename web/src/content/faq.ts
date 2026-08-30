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
  /** A named external destination, kept explicit instead of hiding a URL in prose. */
  link?: { label: { en: string; zh: string }; href: string }
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
        id: 'rules',
        q: { en: 'The rules, in short', zh: '规则速览' },
        blocks: [
          {
            p: {
              en: 'Everything on this list is enforced by the contract rather than promised by a policy document — the one client-side courtesy is marked as such where it appears — and every line has a longer answer further down this page.',
              zh: '这张清单上的每一条都由合约执行，而不是由一份政策文件承诺——唯一一处属于页面自身的辅助行为，会在出现的地方注明——每一条在本页下方都有更完整的解答。',
            },
          },
          {
            ul: [
              {
                en: 'A round settles on the last print at or before its boundary second, from the one aggregator this market is bound to for life — and that print must still be inside the round’s oracle staleness budget (oracleMaxAge) at that boundary. Anyone who settles within the window records the same boundary price and the same outcome.',
                zh: '一个轮次按其边界时刻之前（含那一刻）的最后一笔报价结算，报价必须来自本市场终身绑定的那一个聚合器，并且在边界时刻仍处于本轮的预言机时限（oracleMaxAge）之内。任何人在时限内来结算，记录下的边界价格与结果都相同。',
              },
              {
                en: 'Betting closes at the round’s lock second: the contract rejects any bet mined at or after it. The form also closes a few seconds earlier — a client-side guard, not a contract rule — to reduce the risk that an already-signed bet lands too late.',
                zh: '下注在轮次锁定那一秒截止：合约拒绝任何在该时刻或之后上链的注单。页面表单还会再提前几秒关闭——这是页面自身的保护，不是合约规则——用来降低已签名的交易来不及上链的风险。',
              },
              {
                en: 'Full refund with zero fee, for both sides, when a round cannot be settled honestly: a tie on the strike, a one-sided book, no usable print at the boundary, a missed settlement window, or a pause that landed before the round locked and was still in force when its lock window ran out.',
                zh: '一轮无法被诚实结算时，双方全额退回、零手续费：结算价正好等于行权价（平局）、单边池、边界时刻没有可用报价、错过结算时限、或市场在该轮锁定之前被暂停、且暂停一直持续到该轮的锁定时限耗尽。',
              },
              {
                en: 'A round that had locked before a pause still settles normally, at the price the feed printed.',
                zh: '在暂停落下之前已经锁定的轮次照常结算，按喂价真实报出的价格。',
              },
              {
                en: 'The fee is charged on the losing pool only, so a winner is never paid less than their own stake — and a voided round pays no fee at all.',
                zh: '手续费只从输的那一边的池子里收，所以赢家拿到的钱永远不少于自己的本金——作废的轮次一分手续费都不收。',
              },
              {
                en: 'Settling is permissionless and timing-independent inside the window: whoever calls, whenever they call, the recorded result is the same. A boundary with no usable print cannot be settled by anyone, and such a round becomes refundable once its settlement window expires — not immediately.',
                zh: '结算无需许可，且在时限之内与时机无关：无论谁来调用、何时调用，记录下的结果都一样。边界时刻没有可用报价的轮次谁都无法结算，这样的轮次要等自己的结算时限耗尽后才转为可退款——不是立刻。',
              },
              {
                en: 'Collecting is pull-based: winnings and refunds wait in the contract until you claim them. Claiming never expires, is never pausable, and has no owner check.',
                zh: '领取是“你来取”：赢利和退款都存放在合约里，直到你自己来领。领取永不过期、不受暂停影响、也没有任何权限检查。',
              },
              {
                en: 'There is no separate settlement or collection fee. Beyond the protocol fee above, the only cost is network gas.',
                zh: '没有单独的结算费或领取费。除了上面说的协议手续费，唯一的成本就是链上 gas。',
              },
            ],
          },
          {
            note: {
              en: 'The proofs live further down: “What exactly is the settlement rule?”, “When do I get my money back instead?”, and “How do I check the strike and the settlement price myself?”. Each market’s own parameters are shown in the live panels on this page.',
              zh: '证明都在下文：“结算机制究竟是什么？”“什么情况下会原样退钱？”“我怎么自己复查行权价和结算价？”。每个市场自己的参数，见本页的实时数据面板。',
            },
          },
        ],
      },
      {
        id: 'what',
        q: { en: 'What is UpDown?', zh: 'UpDown 是什么？' },
        blocks: [
          {
            p: {
              en: 'A binary option on price, settled entirely on BNB Smart Chain. You pick UP or DOWN on BTC, ETH or BNB over a fixed round — 1 minute or 10 minutes. When the round locks, an on-chain price becomes the strike; when it closes, another on-chain price decides the outcome. The winning side splits the losing side’s stake.',
              zh: '一个完全在 BNB 智能链上结算的价格二元期权。你在一个固定时长的轮次里（1 分钟或 10 分钟）押 BTC、ETH 或 BNB 的涨或跌。轮次锁定时，一个链上价格成为行权价；轮次结束时，另一个链上价格决定结果。赢的一方瓜分输的一方的本金。',
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
                  en: 'Winnings and refunds are pulled, not pushed: you call claim when you want the money. There is no deadline and no one can stop you — and anyone can pay the gas to push it to you.',
                  zh: '赔付和退款是"你来取"而不是"我来发"：你想拿钱的时候自己调 claim。没有截止时间，也没有任何人能拦住你——而且任何人都可以自掏 gas 把钱推给你。',
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
        {
          id: 'auto-claim',
          q: { en: 'Why is collecting not automatic?', zh: '为什么不自动领取？' },
          blocks: [
            {
              p: {
                en: 'Because paying everyone out during settlement would put your money at the mercy of strangers. Settlement is one transaction that has to close the round for every bettor at once. If that transaction also had to send funds to each winner, then a single winner whose address rejects the transfer — a contract with no payable receive, a token blocklist, an address that simply burns all the gas it is given — would make the whole transaction fail. The round could not settle. Everybody else would be stuck behind that one address, and it would cost an attacker one minimum bet to do it on purpose.',
                zh: '因为"结算时给所有人打钱"会把你的钱交到陌生人手里。结算是一笔交易，要一次性为本轮所有下注者收尾。如果这笔交易还得给每个赢家转账，那么只要有一个赢家的地址拒收——没有 payable receive 的合约、代币黑名单、或者一个把 gas 烧光的地址——整笔交易就会失败，这一轮就结算不了。所有其他人都会被这一个地址卡住，而攻击者只需要下一笔最小注就能故意这么干。',
              },
            },
            {
              p: {
                en: 'So the contract never sends money on its own. It writes down what it owes you, and that entry sits there until it is collected. It has no expiry, it is not pausable, and it has no owner check — which is the same reason a pause cannot strand you.',
                zh: '所以合约从不主动打钱。它只是记下欠你多少，这条记录就一直放在那里等人来取。它不会过期、不受暂停影响、也没有任何权限检查——这也正是暂停困不住你的原因。',
              },
            },
            {
              p: {
                en: 'That is the guarantee. The convenience is layered on top of it, not traded against it. Call setAutoClaimOptIn(true) once and anyone at all — our keeper, a sweeper bot, a friend — can then spend their own gas to collect for you, with the contract paying **you**, at **your** address. The caller cannot redirect a single wei; all they can buy is the right to have paid your gas. Turn it off the same way, any time. Either way you can always claim yourself.',
                zh: '这是**保证**。便利是叠在保证之上的，而不是拿保证换来的。你调用一次 setAutoClaimOptIn(true)，之后任何人——我们的 keeper、清扫机器人、你的朋友——都可以自掏 gas 替你领取，而合约把钱付给**你**、打到**你的地址**。调用者一个 wei 都改不了流向，他能买到的只是替你付了一次 gas。想关掉，同样一句话，随时。开着关着，你都能自己领。',
              },
            },
            {
              p: {
                en: 'Why does it need your say-so at all, rather than being on for everyone? Because the contract cannot tell what kind of account you are. An address reports no code while its constructor is still running, and again after it has self-destructed, so a contract can take a position from inside its own constructor and afterwards look exactly like a wallet. Some contracts genuinely cannot spend from their own address — the whole reason claimTo exists — and paying one of those would strand its winnings and cancel the route it had planned. Rather than guess, and be wrong about somebody, the contract asks.',
                zh: '那为什么还要你点头，不能默认对所有人打开？因为合约无法判断你是哪一种账户。一个地址在自己的构造函数还没跑完时、以及自毁之后，都会报告没有代码——所以一个合约可以在自己的 constructor 里下注，事后看起来和普通钱包一模一样。而确实有些合约没法从自己地址上把钱花出去，这正是 claimTo 存在的理由：把钱打给这种账户会把它的赔付卡死，还顺手取消了它安排好的路径。与其猜错某个人，合约选择先问你一句。',
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
              en: 'That differs from products that assign each order its own reference price. For example, Binance Event Contracts use the Price Index at the next second after placement as that order\'s open price; other products define their own entry rules. Here everyone in a round is betting on the same question with the same reference point, which makes the pool split fair and the whole round checkable from one pair of numbers.',
              zh: '这与“每笔订单各有参照价”的产品不同。例如，币安事件合约把下单后下一秒的 Price Index 作为该笔订单的开仓价；其他产品则按各自规则确定入场基准。而这里，同一轮次里所有人押的是同一个问题、同一个参照点，这既是池子按比例分配得以公平的前提，也是整轮可以用一对数字就核查清楚的原因。',
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
              en: 'On BSC testnet the feed is a relay this project runs, because the testnet’s own Chainlink feeds go up to 25 minutes stale and every 1-minute round would void. That is a testnet-only substitution and the deploy script refuses to put it on mainnet.',
              zh: '在 BSC 测试网上，喂价是本项目自己运行的一个中继（RelayAggregator），因为测试网自带的 Chainlink 喂价最长会滞后 25 分钟，那样每个 1 分钟轮次都会作废。这是仅限测试网的替代方案，部署脚本会拒绝把它部署到主网。',
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
              en: 'Whoever settles the round hands the contract a feed round id, and the contract proves it is the right one: the print must come from the one aggregator this market is bound to, must be at or before the boundary, must be recent enough that the feed was genuinely alive there, and must be the last one that qualifies — either nothing later exists on that aggregator, or the very next print is already past the boundary. A wrong id does not settle the round at a wrong price; the transaction simply reverts.',
              zh: '来结算的人把一个喂价轮次 id 交给合约，合约会**证明**它是对的：这笔报价必须来自本市场绑定的那一个聚合器、必须在边界时刻或之前、必须足够新以证明喂价当时确实活着、并且必须是符合条件的最后一笔——要么该聚合器上再没有更晚的报价，要么紧接着的下一笔已经越过了边界。交错 id 不会导致按错误价格结算，那笔交易只会直接失败。',
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
            code: `# Archived proof from round 9 of the retired BTC/USD 5-minute testnet market.
# Give cast the return types, or it prints one unbroken word of hex.

# 1 · the round, from the market
$ cast call $MARKET "getRound(uint256)(uint64,uint64,uint64,uint16,uint16,bool,bool,\\
    bool,int256,int256,uint80,uint80,uint32,uint256,uint256,uint256,uint256)" \\
    9 --rpc-url $RPC
1787720700                    # startTs
1787721000                    # lockTs         ← the strike boundary
1787721300                    # closeTs        ← the settlement boundary
300                           # feeBps         = 3%
240                           # bufferSeconds
true                          # locked
true                          # settled
false                         # voided
7877399000000                 # lockPrice      = 78,773.99
7893064000000                 # closePrice     = 78,930.64
10                            # lockOracleId   ← read this feed round
11                            # closeOracleId  ← and this one
150                           # oracleMaxAge
6390000000000000000           # upAmount
11670000000000000000          # downAmount
6390000000000000000           # rewardBaseAmount
17709900000000000000          # rewardPoolAmount

# 2 · those exact feed rounds, from the oracle
$ cast call $FEED "getRoundData(uint80)(uint80,int256,uint256,uint256,uint80)" \\
    10 --rpc-url $RPC
10                            # roundId, echoed back for the id we asked for
7877399000000                 # answer     = lockPrice, to the last digit
1787720962                    # startedAt
1787720962                    # updatedAt  = 38s before lockTs, inside the 150s budget
10                            # answeredInRound

$ cast call $FEED "getRoundData(uint80)(uint80,int256,uint256,uint256,uint80)" \\
    11 --rpc-url $RPC
11
7893064000000                 # answer     = closePrice
1787721267                    # startedAt
1787721267                    # updatedAt  = 33s before closeTs, inside the budget
11

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
            // The screen's own name for this number, and the screen's own framing: the odds panel
            // calls it a break-even win rate and explicitly denies the probability reading, so the
            // FAQ must not teach a term that exists nowhere in the app — least of all the exact
            // reading the app forbids.
            note: {
              en: 'The "break-even win rate" shown next to each multiple is just 1 ÷ multiple — what a side has to win for you to come out level at that payout, not a probability. The two sides add up to slightly more than 100% because the fee is inside both — that gap is the fee, not a mispricing, and the app shows it explicitly.',
              zh: '每个倍数旁边显示的"保本胜率"就是 1 ÷ 倍数——按这个赔付、这一边要赢多少比例你才刚好不亏不赚，它不是概率。两侧加起来会略高于 100%，因为手续费包含在两者之中——那个差额就是手续费，不是定价错误，应用会把它明确标出来。',
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
                en: 'The feed went dark — no usable price existed at the boundary before the round’s window ran out. A feed migration to a new aggregator phase ends the same way, but not instantly: prints from the new phase are rejected, boundaries still covered by the bound aggregator’s last print settle normally, and every round whose boundary falls past that coverage runs out its window and becomes refundable.',
                zh: '喂价中断——在该轮时限用尽之前，边界时刻不存在可用的价格。喂价换到新的聚合器相位（phase）最终也是同一个结局，但不是立刻：新相位的报价会被拒绝，仍在被绑定聚合器最后一笔报价覆盖范围内的边界照常结算，越过这个范围之后的每一轮才耗尽时限、转为可退款。',
              },
              {
                en: 'Nobody settled the round in time — the window elapsed, so it can no longer be settled at all.',
                zh: '没有人及时结算——时限已过，该轮从此不可能再被结算。',
              },
              {
                en: 'The market was paused **before your round locked** — it never received a strike, so nobody could have known its outcome.',
                zh: '市场在**你的轮次锁定之前**被暂停——它从未拿到行权价，谁都不可能预知它的结果。',
              },
            ],
          },
          {
            p: {
              en: 'A pause is not on that list for a round that has already locked. Once a round has its strike, it settles through a pause at the price the feed actually printed, and the winning side is paid — see “What can the admin do?” below.',
              zh: '对一个**已经锁定**的轮次来说，暂停不在上面这张清单里。轮次一旦拿到行权价，就会穿过暂停、按喂价真实报出的价格结算，赢的一方照常拿钱——详见下面的"管理员能做什么？"。',
            },
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
                  { en: 'Pause the market — new bets stop, and no further round locks or opens', zh: '暂停市场——停止新下注，此后不再有轮次被锁定或开出' },
                  { en: 'Cancel a round that has already locked — it settles through a pause, at the price the feed actually printed', zh: '取消一个已经锁定的轮次——它会照常穿过暂停结算，用的就是喂价真实报出的价格' },
                ],
                [
                  { en: 'Change the fee, which only ever applies to rounds starting after the call, and the bet-size limits, which apply to the open round at once — neither reaches a bet already placed', zh: '修改手续费（永远只对调用之后开始的轮次生效）和下注额度上限（对正在开放下注的那一轮立即生效）——两者都够不到已经下好的注' },
                  { en: 'Touch your principal or your unclaimed winnings, by any path at all', zh: '通过任何途径动你的本金或未领取的赔付' },
                ],
                [
                  { en: 'Withdraw the accrued protocol fee', zh: '提取已累计的协议手续费' },
                  { en: 'Block, delay or reverse a withdrawal — claiming is not pausable and has no owner check', zh: '阻止、拖延或撤销一次提取——领取不受暂停影响且无权限检查' },
                ],
                [
                  { en: 'Rescue a token someone sent to the market by mistake — never the settlement asset', zh: '取回别人误转进市场合约的代币——但结算资产永远取不走' },
                  { en: 'Choose, supply, override or replace the price source — the feed address is immutable and there is no setter for it', zh: '选择、提供、覆盖或更换价格来源——喂价地址是不可变的，合约里根本没有对应的设置函数' },
                ],
                [
                  { en: 'Hand ownership to another address, in two steps', zh: '把所有权分两步移交给另一个地址' },
                  { en: 'Settle a round at a price of their choosing, un-void or un-expire one, or revive one that already expired — anyone may call executeRound, and it takes the same proof from everybody', zh: '按自己选定的价格结算某一轮、撤销作废、撤销过期，或让已过期的轮次复活——executeRound 谁都能调用，而且对谁都要求同一份证明' },
                ],
                [
                  { en: 'Hide a market from this app’s list, through the registry — the contract keeps running and every claim still works', zh: '通过注册表把某个市场从本应用的列表里隐藏——合约照常运行，所有领取照常可用' },
                  { en: 'Renounce ownership — it is disabled, because an ownerless market could never be paused or repaired again', zh: '放弃所有权——该功能已被禁用，因为无主的市场将永远无法暂停或修复' },
                ],
              ],
            },
          },
          {
            note: {
              en: 'The honest part: a pause is not a cancel button, but it is not nothing either. A round that has already locked settles straight through a pause, at its true price, and the winner can claim while the market is paused — so an owner who watches the settlement print land, sees they have lost and hits pause gains exactly nothing. What a pause does end is a round that had **not** locked yet: it never received a strike, so nobody could have known its outcome, and every stake in it comes back in full. That is the whole residual, and it is bounded by design: an owner can stop the market, never a bet whose result is already visible.',
              zh: '说实话的部分：暂停不是一个"取消按钮"，但它也不是完全没有代价。**已经锁定**的轮次会径直穿过暂停、按真实价格结算，赢家在市场暂停期间照样可以领取——所以一个眼看结算价落定、发现自己输了才去按暂停的管理员，什么也捞不到。暂停真正终结的是**还没锁定**的轮次：它从未拿到行权价，谁都不可能预知它的结果，因此里面每一笔本金全额退回。这就是全部的残余风险，而且它天生有界：管理员能停下市场，却停不下一笔结果已经摆在明面上的下注。',
            },
          },
        ],
      },
      {
        id: 'price-source',
        q: {
          en: 'Can the admin change where the price comes from?',
          zh: '管理员能改动价格的来源吗？',
        },
        blocks: [
          {
            p: {
              en: 'No. The feed address is fixed when the market is deployed and cannot be changed afterwards — it is immutable, and the contract has no function that sets it. Read oracle() on the market once and you have read the only price source it will ever have.',
              zh: '不能。喂价地址在市场部署的那一刻就定死了，之后无法更改——它是不可变的，合约里根本没有任何设置它的函数。对市场调用一次 oracle()，你读到的就是它这辈子唯一的价格来源。',
            },
          },
          {
            p: {
              en: 'This is not a small detail. A settable price source would be a path from the admin key straight to the settlement price of a round that has **already locked**: pause the market, point it at a feed you control, settle the locked round at whatever price you like, point it back, unpause. A locked position has no exit, so no time delay and no multisig fixes that — the only answer is that the source cannot change at all.',
              zh: '这不是细枝末节。一个可设置的价格来源，等于给管理员私钥开了一条直通**已锁定**轮次结算价的路：暂停市场、把它指向一个自己控制的喂价、按任意价格结算那个已锁定的轮次、再指回去、解除暂停。已锁定的仓位没有退出通道，所以时间锁和多签都救不了——唯一的答案就是这个来源根本不能改。',
            },
          },
          {
            p: {
              en: 'The market is also bound for life to the single Chainlink aggregator it was deployed against. A print from any other aggregator is not a valid proof and is rejected outright. If the feed genuinely moves on, the market winds down rather than breaking: boundaries the bound aggregator’s last print still covers, inside oracleMaxAge, settle normally; every boundary past that coverage can no longer be proved, so those rounds run out their settlement windows and every stake in them is refunded in full with no fee. A new market is deployed against the new feed. Nothing gets stuck, and nothing is ever settled on a price you cannot check.',
              zh: '这个市场同时被终身绑定在它部署时对应的那一个 Chainlink 聚合器上。来自任何其他聚合器的报价都不是有效证明，会被直接拒绝。如果喂价真的换代了，这个市场是有序收场，而不是坏掉：仍在被绑定聚合器最后一笔报价覆盖范围内（预言机时限之内）的边界照常结算；越过这个范围的边界从此无法被证明，那些轮次会耗尽各自的结算时限，其中每一笔本金全额退回、不收手续费，这个市场就此退役。新的市场会针对新的喂价重新部署。不会有钱被卡住，也不会有任何一轮按你无法核查的价格结算。',
            },
          },
          {
            note: {
              en: 'That is true of the markets you are trading right now, not only of the source: chain 97 was redeployed on the current code, and you can check it yourself — oraclePhase() answers, and setOracle reverts because it is not there.',
              zh: '这一点对你现在正在交易的市场就是成立的，不只是对源码而言：97 链已在当前代码上重新部署，你可以自己验证——oraclePhase() 能回答，而 setOracle 会回滚，因为它根本不存在。',
            },
          },
        ],
      },
      {
        id: 'dispute',
        q: { en: 'What if I dispute a settlement?', zh: '对结算结果有争议怎么办？' },
        blocks: [
          {
            p: {
              en: 'There is no review desk here, and no corrected re-settlement path — not because disputes are unwelcome, but because a ticket could not change anything. The settlement price is proved against public chain data by the contract itself, and a settled round is final for everyone, the team included.',
              zh: '这里没有人工复核，也没有“修正后重新结算”的通道——不是不欢迎质疑，而是工单改变不了任何东西。结算价由合约自己对照公开的链上数据完成证明，已结算的轮次对所有人都是终局，包括团队自己。',
            },
          },
          {
            p: {
              en: 'Checking comes before trusting. Every round’s proof panel re-derives the strike and the settlement price in your own browser, straight from the feed contract, and names the oracle round ids it used; the same round data and events are one click away on the block explorer.',
              zh: '核验先于信任。每一轮的证明面板都会在你自己的浏览器里、直接从喂价合约重新推导行权价和结算价，并写明它用到的预言机轮次 id；同样的轮次数据和事件，在区块浏览器上一键可查。',
            },
          },
          {
            p: {
              en: 'The failure modes need no judgment call. A feed silent past the point where its last print can still cover a boundary, a missed window, a feed migration that outlives the bound aggregator’s last valid print — each leaves the affected rounds unable to settle, and they become refundable automatically once their own settlement window expires. A refund is still collected by you, through the same claim button, and claiming never expires.',
              zh: '故障场景不需要任何人裁量。喂价安静到其最后一笔报价再也盖不住边界时刻、错过时限、喂价换代且超出了被绑定聚合器最后一笔报价的有效期——这些都只会让受影响的轮次无法结算，并在各自的结算时限耗尽后自动转为可退款。退款仍由你自己通过同一个领取按钮取回，领取永不过期。',
            },
          },
          {
            p: {
              en: 'What people can do: investigate a UI or infrastructure problem, pause the market against taking new risk, and publish a dated incident note naming the affected markets and epochs, the transaction evidence, and the forward-only remediation — explicitly without touching any settled round. What nobody can do is alter a recorded settlement; the oracle risk in the next answer is the honest limit of that guarantee.',
              zh: '人能做的是：排查界面或基础设施的问题、暂停市场以挡住新的风险进入、以及发布带日期的事件说明——写明受影响的市场与轮次、交易证据、只面向未来的补救措施，并明确不改动任何已结算轮次。没有人能做的，是改写一笔已被记录的结算；下一条回答里的预言机风险，就是这条保证的诚实边界。',
            },
          },
          {
            note: {
              en: 'Found a mismatch between the proof panel and the chain, or anything else that looks wrong? Open an issue on the GitHub repository (github.com/CisaSettle/updown-bnb) with the market address, the epoch, the transaction hash, and the oracle round ids from the proof panel — exactly the evidence that lets anyone reproduce what you saw.',
              zh: '发现证明面板和链上数据对不上，或任何看起来不对的地方？到 GitHub 仓库（github.com/CisaSettle/updown-bnb）提一个 issue，附上市场地址、轮次号、交易哈希，以及证明面板里的预言机轮次 id——这正是让任何人都能复现你所见的全部证据。',
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
                en: 'You can lose your whole stake. A binary option is all-or-nothing, and a 1-minute price move is close to a coin flip before fees — the 3% fee means a random bettor loses money over time.',
                zh: '你可能亏光押进去的钱。二元期权是全有或全无，而 1 分钟的价格波动在扣费之前接近抛硬币——3% 的手续费意味着随机下注的人长期必然亏损。',
              },
              {
                en: 'Smart contract risk. The code has been through six rounds of adversarial cross-vendor review and an independent audit, on top of a large test suite, and it is verified on chain so you can read it. The most recent of those found a critical bug — an admin path to the settlement price of an already-locked round — which is why the price source is now immutable. That is the argument for reading the review log, not for trusting that the next one finds nothing.',
                zh: '智能合约风险。这份代码经过六轮对抗式跨厂商评审和一次独立审计，外加大量测试，并且已在链上完成源码验证、你可以自己读。其中最近的一次查出了一个严重漏洞——管理员可以插手一个已锁定轮次的结算价——这正是价格来源现在改为不可变的原因。这说明的是"评审记录值得一读"，而不是"下一轮评审一定查不出东西"。',
              },
              {
                en: 'Oracle risk. Settlement is only as good as the feed. A feed that stops publishing settles the boundaries its last print still covers and lets everything after run out its window into refunds rather than settle wrongly; a feed that moves to a new aggregator winds the market down the same way. Both are the safe failure. But a feed reporting a wrong price would settle a wrong outcome, and nothing on chain can tell the difference.',
                zh: '预言机风险。结算的可靠性上限就是喂价的可靠性。喂价停止发布时，其最后一笔报价仍覆盖的边界照常结算，之后的每一轮耗尽时限、转为退款，而不是错误结算；喂价换到新的聚合器时，市场也以同样的方式有序收场。这两种都是安全的失败方式。但如果喂价报出的价格本身就是错的，就会结算出错误的结果，而链上没有任何东西能分辨这一点。',
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

  // ───────────────────────────────────────────────────────────────────────────
  {
    id: 'contact',
    title: { en: 'Contact us', zh: '联系我们' },
    entries: [
      {
        id: 'contact-x',
        q: { en: 'How can I contact the team?', zh: '如何联系我们？' },
        blocks: [
          {
            p: {
              en: 'Contact us on X / Twitter, or follow the account for public product updates and service notices.',
              zh: '可通过 X / Twitter 联系我们，也可以关注公开产品更新与服务通知。',
            },
          },
          {
            link: {
              label: { en: '@BluffKingAI on X / Twitter', zh: 'X / Twitter：@BluffKingAI' },
              href: 'https://x.com/BluffKingAI',
            },
          },
        ],
      },
    ],
  },
]
