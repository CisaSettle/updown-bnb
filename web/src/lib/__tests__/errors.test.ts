import { BaseError, ContractFunctionRevertedError, encodeErrorResult } from 'viem'
import { describe, expect, it } from 'vitest'
import { allErrorsAbi } from '../../abi'
import { ERROR_COPY, ERROR_TEXT, errorCopy, faucetCooldownCopy, humanizeError } from '../errors'
import type { Lang } from '../i18n'

/** A revert the app would actually receive: the custom error, encoded, wrapped the way viem wraps it. */
function revertWith(errorName: string, args?: readonly unknown[]): BaseError {
  const data = encodeErrorResult({
    abi: allErrorsAbi,
    errorName,
    ...(args ? { args } : {}),
  } as Parameters<typeof encodeErrorResult>[0])
  const reverted = new ContractFunctionRevertedError({ abi: allErrorsAbi, data, functionName: 'betUp' })
  return new BaseError('reverted', { cause: reverted })
}

const CJK = /[一-鿿]/

describe('the error table is fully translated', () => {
  it('gives every custom error both languages, and neither is the other', () => {
    for (const [name, text] of Object.entries(ERROR_COPY)) {
      expect(text.en.length, name).toBeGreaterThan(0)
      expect(text.zh.length, name).toBeGreaterThan(0)
      expect(text.zh, name).not.toBe(text.en)
      expect(CJK.test(text.zh), name).toBe(true)
    }
    for (const [key, text] of Object.entries(ERROR_TEXT)) {
      expect(CJK.test(text.zh), key).toBe(true)
    }
  })

  it('never apologises instead of saying what to do next', () => {
    // 操作失败，请重试 is the register this whole file exists to avoid: it names no cause and no
    // next step, and it is what a machine-translated table would produce for most of these.
    for (const [name, text] of Object.entries(ERROR_COPY)) {
      expect(text.zh, name).not.toContain('操作失败')
      expect(text.zh, name).not.toContain('尊敬的用户')
      expect(text.zh, name).not.toContain('系统')
      expect(text.zh, name).not.toContain('您')
    }
  })
})

describe('the four errors that are easy to render as something the contract does not mean', () => {
  it('NotBettable is a closed window, not a rejected bet', () => {
    // The round stopped taking bets. Nothing failed, and the next round is where the money goes.
    expect(errorCopy('NotBettable').zh).toBe('这一轮已经停止下注。到下一轮再下。')
    expect(errorCopy('NotBettable').zh).not.toContain('失败')
    expect(errorCopy('NotBettable').zh).toContain('下一轮')
  })

  it('WrongEpoch is the round moving on mid-signature, not a wrong input', () => {
    const zh = errorCopy('WrongEpoch').zh
    expect(zh).toContain('签名')
    expect(zh).toContain('当前这一轮')
    // Not "you picked the wrong round" — the user picked the right one and it aged out.
    expect(zh).not.toContain('错误')
    expect(zh).not.toContain('无效')
  })

  it('NotResolved names both ways a round becomes collectable', () => {
    const zh = errorCopy('NotResolved').zh
    expect(zh).toContain('还没有结算')
    // Settlement is one route; the settlement window elapsing into a refund is the other, and it
    // is the one that matters when a keeper has stalled.
    expect(zh).toContain('结算时限')
    expect(zh).toContain('可退款')
    expect(zh).not.toContain('处理中')
    // English says the same two things — the claim was fixed in both languages, not just one.
    expect(errorCopy('NotResolved').en).toContain('settlement window has elapsed')
  })

  it('NotWinner does not assert the user bet and lost', () => {
    const zh = errorCopy('NotWinner').zh
    // `claim` reverts with this for any wallet the round does not owe, including one that never
    // bet in it, so 押错 / 你输了 would state something the contract does not know.
    expect(zh).not.toContain('押错')
    expect(zh).not.toContain('你输')
    expect(zh).toContain('不是赢家')
  })
})

describe('a void is an outcome, not a failure', () => {
  it('says a paused market makes stakes refundable, with no fee and no error language', () => {
    const zh = errorCopy('EnforcedPause').zh
    expect(zh).toContain('全额可退')
    expect(zh).toContain('不收手续费')
    // 可退 is not 已退: the contract never pushes the money, the user pulls it.
    expect(zh).not.toContain('已退款')
    expect(zh).not.toContain('失败')
  })

  it('tells the reader they can settle the round themselves', () => {
    const zh = errorCopy('InvalidBoundaryProof').zh
    expect(zh).toContain('任何人')
    expect(zh).toContain('包括你')
    expect(zh).toContain('边界时刻')
  })
})

describe('FaucetCooldown counts the wait', () => {
  const now = 1_700_000_000

  it('pluralises the English minute and leaves the 中文 uninflected', () => {
    const one = faucetCooldownCopy([BigInt(now + 1)], now)
    expect(one.en).toBe('The faucet is cooling down. Try again in about 1 minute.')
    expect(one.zh).toBe('水龙头在冷却中，大约 1 分钟后再来。')

    const many = faucetCooldownCopy([BigInt(now + 301)], now)
    expect(many.en).toBe('The faucet is cooling down. Try again in about 6 minutes.')
    expect(many.zh).toBe('水龙头在冷却中，大约 6 分钟后再来。')
  })

  it('quotes the same number of minutes in both languages', () => {
    for (const secs of [1, 59, 60, 61, 600, 3_601]) {
      const copy = faucetCooldownCopy([BigInt(now + secs)], now)
      const mins = Math.ceil(secs / 60)
      expect(copy.en).toContain(`${mins} minute`)
      expect(copy.zh).toContain(`${mins} 分钟`)
    }
  })

  it('falls back to \"a little later\" when the contract gave no deadline', () => {
    expect(faucetCooldownCopy(undefined, now)).toEqual(ERROR_TEXT.faucetCooldown)
    expect(faucetCooldownCopy([], now)).toEqual(ERROR_TEXT.faucetCooldown)
  })
})

describe('humanizeError', () => {
  it('decodes a real revert into the reader’s language', () => {
    expect(humanizeError(revertWith('NotBettable'), 'en')).toBe(ERROR_COPY.NotBettable?.en)
    expect(humanizeError(revertWith('NotBettable'), 'zh')).toBe(ERROR_COPY.NotBettable?.zh)
    expect(humanizeError(revertWith('AlreadyClaimed'), 'zh')).toBe('那一轮你已经领过了。')
  })

  it('never shows a selector or a hex blob, in either language', () => {
    const hexy = new Error('execution reverted: 0xdeadbeefcafebabe')
    for (const lang of ['en', 'zh'] as const) {
      expect(humanizeError(hexy, lang)).not.toMatch(/0x[0-9a-fA-F]{8,}/)
      expect(humanizeError(revertWith('NotBettable'), lang)).not.toMatch(/0x[0-9a-fA-F]{8,}/)
    }
    expect(humanizeError(hexy, 'zh')).toBe(ERROR_TEXT.fallback.zh)
  })

  it('names a wallet rejection as the user’s own choice', () => {
    const rejected = { code: 4001, message: 'User rejected the request.' }
    expect(humanizeError(rejected, 'en')).toBe('You rejected the request in your wallet.')
    expect(humanizeError(rejected, 'zh')).toBe('你在钱包里拒绝了这个请求。')
  })

  it('translates the wallet and network failures viem only describes in prose', () => {
    const cases: Array<[string, Lang, string]> = [
      ['insufficient funds for gas', 'zh', ERROR_TEXT.noGas.zh],
      ['chain mismatch', 'zh', ERROR_TEXT.wrongChain.zh],
      ['The request timed out.', 'zh', ERROR_TEXT.timeout.zh],
      ['connector not connected', 'zh', ERROR_TEXT.disconnected.zh],
      ['insufficient funds for gas', 'en', ERROR_TEXT.noGas.en],
    ]
    for (const [short, lang, expected] of cases) {
      expect(humanizeError(new BaseError(short), lang)).toBe(expected)
    }
  })

  // The symptom the owner hit: clicking connect produced only "出了点问题，重试一次" and there was
  // no way, from the screen, to tell whether the app was broken or the wallet was simply waiting.
  it('names the pending-request case instead of sending the reader round the same loop', () => {
    const pending = new BaseError('Request of type wallet_requestPermissions already pending.')
    expect(humanizeError(pending, 'zh')).toBe(ERROR_TEXT.requestPending.zh)
    expect(humanizeError(pending, 'en')).toBe(ERROR_TEXT.requestPending.en)
  })

  // A wallet does not always hand you a viem error. It throws a plain object, or an Error with the
  // provider error tucked into `cause`. Classifying only the wrapped shape is why this reached the
  // owner as "something went wrong" in the first place.
  it('recognises the same failure however the wallet chose to throw it', () => {
    const bare = { code: -32002, message: 'Already processing eth_requestAccounts.' }
    expect(humanizeError(bare, 'zh')).toBe(ERROR_TEXT.requestPending.zh)

    const wrapped = new Error('Connector failed')
    ;(wrapped as { cause?: unknown }).cause = { code: -32002, message: 'request pending' }
    expect(humanizeError(wrapped, 'zh')).toBe(ERROR_TEXT.requestPending.zh)

    const plainText = new Error('MetaMask: Already processing eth_requestAccounts.')
    expect(humanizeError(plainText, 'en')).toBe(ERROR_TEXT.requestPending.en)

    const nestedProvider = new Error('outer')
    ;(nestedProvider as { cause?: unknown }).cause = new Error('No injected provider found')
    expect(humanizeError(nestedProvider, 'zh')).toBe(ERROR_TEXT.noProvider.zh)
  })

  it('carries the error code through, because a number is prose in no language', () => {
    // -32603 deliberately: an internal JSON-RPC error we do NOT have copy for, which is the case
    // this rule exists to serve. A code we already name would prove nothing here.
    const coded = Object.assign(new Error('Something viem phrases only in English.'), { code: -32603 })
    const zh = humanizeError(coded, 'zh')
    // the rule holds: no English sentence reaches a 中文 reader …
    expect(zh).not.toMatch(/[A-Za-z]{4,}/)
    // … but the one fact worth having is not thrown away with it
    expect(zh).toContain('-32603')
    // English keeps the sentence itself, which says more than a code — the code is what stands in
    // for it when the sentence cannot be shown.
    expect(humanizeError(coded, 'en')).toBe('Something viem phrases only in English.')
  })

  it('finds a code nested in a cause chain, where wallet errors usually put it', () => {
    const wrapped = new Error('outer')
    ;(wrapped as { cause?: unknown }).cause = Object.assign(new Error('inner'), { code: 4900 })
    expect(humanizeError(wrapped, 'zh')).toContain('4900')
  })

  it('stays exactly as it was when there is no code to add', () => {
    expect(humanizeError(new Error('no code here'), 'zh')).toBe(ERROR_TEXT.fallback.zh)
  })

  it('never hands a 中文 reader an English sentence a library wrote', () => {
    // The line between the two passthroughs. A revert `reason` really was written on chain, so it
    // is shown verbatim in both languages — inventing a 中文 rendering would put words in the
    // contract's mouth. A viem `shortMessage` or a bare `Error` message is a library's own English
    // UI copy, and showing it to a 中文 reader at the moment their money did not move is exactly
    // the leak this whole change exists to close.
    const spoken = new Error('the node said something specific and true')
    expect(humanizeError(spoken, 'en')).toBe('the node said something specific and true')
    expect(humanizeError(spoken, 'zh')).toBe(ERROR_TEXT.fallback.zh)

    const viemProse = new BaseError('Something viem phrases only in English.')
    expect(humanizeError(viemProse, 'en')).toBe('Something viem phrases only in English.')
    expect(humanizeError(viemProse, 'zh')).toBe(ERROR_TEXT.fallback.zh)
  })

  it('maps the RPC and network failures viem leaves as English prose', () => {
    const cases: Array<[string, keyof typeof ERROR_TEXT]> = [
      ['execution reverted', 'reverted'],
      ['Nonce provided for the transaction is lower than the current nonce.', 'nonce'],
      ['HTTP request failed.', 'network'],
      ['An internal RPC error occurred.', 'rpc'],
    ]
    for (const [short, key] of cases) {
      const zh = humanizeError(new BaseError(short), 'zh')
      expect(zh, short).toBe(ERROR_TEXT[key].zh)
      expect(/[a-z]{3,}\s+[a-z]{2,}/.test(zh), short).toBe(false)
      expect(humanizeError(new BaseError(short), 'en'), short).toBe(ERROR_TEXT[key].en)
    }
  })

  it('falls back in the reader’s language when there is nothing usable at all', () => {
    expect(humanizeError(undefined, 'en')).toBe(ERROR_TEXT.fallback.en)
    expect(humanizeError(undefined, 'zh')).toBe(ERROR_TEXT.fallback.zh)
    expect(humanizeError({}, 'zh')).toBe(ERROR_TEXT.fallback.zh)
  })

  it('gives an unknown custom error a plain sentence, not a selector', () => {
    expect(errorCopy('SomeErrorNobodyMapped').zh).toBe('合约拒绝了这笔交易。')
    expect(errorCopy('SomeErrorNobodyMapped').en).toBe('The contract rejected this transaction.')
  })
})
