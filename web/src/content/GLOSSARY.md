# Translation glossary and register

The English copy in this app is deliberately plain: it states what happens, admits what it does not
know, and never sells. **The 中文 must read the same way** — written by someone who understands a
parimutuel binary option, not translated word by word. A reader should not be able to tell which
language was written first.

## Register

- Address the reader as **你**, never 您. This is a trading screen, not a bank letter.
- No exclamation marks. No 尊敬的用户, no 欢迎使用, no marketing adjectives.
- Buttons are verbs, and short: 下注 / 领取 / 授权 / 连接钱包 — not 点击下注.
- State facts in the active voice. "轮次作废，全额退回" beats "该轮次将会被系统作废并进行退款处理".
- Where the English admits uncertainty, the 中文 must admit it too. "还不知道" is a legitimate thing
  for this product to say, and softening it into 正在处理中 is a lie.
- Keep numerals as numerals. 3%, 5 分钟, 78,773.99 — never 百分之三.
- Do not translate: USDT, BNB, BTC, Chainlink, BscScan, Sourcify, MetaMask, gas, epoch id, and the
  contract identifiers a reader will type or grep (`lockPrice`, `getRoundData`, `oracleMaxAge`).

## Terms — use these exactly, everywhere

| English | 中文 | note |
|---|---|---|
| binary option | 二元期权 | |
| parimutuel | 平价池 | gloss as（同注分彩）on first use in a long text, then just 平价池 |
| round / epoch | 轮次 | the number itself is "第 N 轮" |
| betting window | 下注窗口 | |
| lock / locked | 锁定 | |
| strike, `lockPrice` | 行权价 | **never** 开仓价 or 下单价 — there is no per-user entry price |
| settlement price, `closePrice` | 结算价 | |
| settle / settlement | 结算 | |
| boundary (timestamp) | 边界时刻 | |
| settlement window (`bufferSeconds`) | 结算时限 | |
| void / voided | 作废 | |
| refund | 退款 / 全额退回 | |
| claim | 领取 | the button is 领取; "collectable" is 可领取 |
| stake (noun) | 本金 | "your stake" = 你的本金 |
| bet (verb) | 下注 | |
| pool | 池 | UP pool = UP 池 |
| one-sided book | 单边池 | |
| tie | 平局 | |
| odds / multiple | 赔率 / 倍数 | "3.91x" stays "3.91x" |
| implied probability | 隐含概率 | |
| overround | 超额 | explain as 两侧相加超出 100% 的部分就是手续费 |
| fee | 手续费 | |
| treasury | 国库 | |
| oracle | 预言机 | |
| price feed | 喂价 | the contract is 喂价合约 |
| stale | 滞后 | a stale print is 滞后的报价 |
| print (a feed observation) | 报价 | "the last print at or before the boundary" = 边界时刻之前的最后一笔报价 |
| keeper | keeper | a term of art; leave it, gloss once as（推动轮次前进的程序） |
| permissionless | 无许可 | |
| non-custodial | 非托管 | |
| allowance / approve | 授权额度 / 授权 | |
| side cap (`maxSideAmount`) | 单边上限 | |
| pause | 暂停 | |
| multisig | 多签 | |
| Timelock | 时间锁 | |
| owner / admin | 管理员 | |

## Sentences that carry the product, and must not drift

These are the claims the whole design exists to make. Translate them as *statements a sceptic could
check*, not as reassurance.

| English | 中文 |
|---|---|
| A winner is never paid less than their own principal. | 赢家拿到的钱永远不会少于自己的本金。 |
| The odds you are quoted are the odds you are paid. | 报给你的赔率，就是付给你的赔率。 |
| Ties and one-sided books are refunded in full, with no fee. | 平局和单边池全额退回，不收手续费。 |
| A round that cannot settle honestly is voided, not forced. | 无法诚实结算的轮次会作废，而不是被硬结算。 |
| Settling is permissionless — there is no privileged settler. | 结算是无许可的——不存在有特权的结算者。 |
| Calling one second late and three minutes late give identical outcomes. | 晚一秒调用和晚三分钟调用，结果一模一样。 |
| The strike belongs to the round, not to your order. | 行权价属于轮次，不属于你的订单。 |
| You never have to take this page's word for it. | 你从来不必相信这个页面的说法。 |

## Things that are easy to get wrong

- **"下单价格" does not exist in this product.** If a string implies a per-user entry price, the
  translation is wrong and so is the English. Flag it.
- **可退款 ≠ 已退款.** A round being refundable means the money is claimable, not that it has been
  sent. The product never pushes funds.
- **作废 is not 失败.** A void is a defined, correct outcome that returns everyone's money — not an
  error. Never render it as 出错 or 异常.
- **"pending" is three different states here** — betting open, locked and running, past close but
  not yet settled. Do not collapse them into 处理中; the reader needs to know which one they are in.
- Error copy must say what to do next, not apologise. 余额不足，请先领取测试 USDT — not 操作失败.
