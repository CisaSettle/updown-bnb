import { BaseError, ChainMismatchError, ContractFunctionRevertedError, InvalidInputRpcError, RpcRequestError, TimeoutError, encodeErrorResult } from 'viem'
import { ConnectorNotConnectedError } from '@wagmi/core'
import { getContractError, getEstimateGasError, getTransactionError } from 'viem/utils'
import { describe, expect, it } from 'vitest'
import { allErrorsAbi } from '../../abi'
import { ERROR_COPY, ERROR_TEXT, errorCopy, faucetCooldownCopy, humanizeError, isRequestAlreadyPending } from '../errors'
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

/**
 * The error the app ACTUALLY receives when the node refuses a write, assembled through viem's own
 * wrappers rather than hand-written.
 *
 * A `new BaseError('insufficient funds for gas')` proves nothing: viem never produces that
 * sentence. Its real `shortMessage` for the same node reply is "The total cost (gas * gas fee +
 * value) … exceeds the balance of the account.", which contains none of the words a classifier
 * would look for — which is exactly how a wallet with no gas came to be told "出了点问题".
 */
function nodeRefusal(message: string, code = -32000): BaseError {
  return nodeRefusalWithData(message, code)
}

/**
 * The demo wallet's chain, which is one wrapper deeper.
 *
 * A local account signs in the page, so viem estimates gas itself and the node's refusal arrives
 * through `getEstimateGasError` BEFORE the two wrappers an injected wallet produces. That is the
 * path the owner was actually on, and no test built it.
 */
function demoRefusal(message: string, code = -32000): BaseError {
  const account = { address: '0x2222222222222222222222222222222222222222', type: 'local' } as never
  const rpc = new RpcRequestError({
    body: { method: 'eth_estimateGas', params: [] },
    error: { code, message },
    url: 'https://data-seed-prebsc-1-s1.bnbchain.org:8545',
  })
  const estimate = getEstimateGasError(new InvalidInputRpcError(rpc) as never, { account, chain: undefined, docsPath: undefined } as never)
  const tx = getTransactionError(estimate as never, { account, chain: undefined, docsPath: undefined })
  return getContractError(tx, {
    abi: allErrorsAbi,
    address: '0x1111111111111111111111111111111111111111',
    args: [true],
    docsPath: undefined,
    functionName: 'setAutoClaimOptIn',
    sender: '0x2222222222222222222222222222222222222222',
  })
}

/** The same, for a wallet that nests the node's real reply under `data` instead of passing it on. */
function nodeRefusalWithData(message: string, code: number, data?: { code: number; message: string }): BaseError {
  const rpc = new RpcRequestError({
    body: { method: 'eth_sendRawTransaction', params: [] },
    error: { code, message, ...(data ? { data } : {}) },
    url: 'https://data-seed-prebsc-1-s1.bnbchain.org:8545',
  })
  const tx = getTransactionError(new InvalidInputRpcError(rpc), {
    account: { address: '0x2222222222222222222222222222222222222222', type: 'json-rpc' } as never,
    chain: undefined,
    docsPath: undefined,
  })
  return getContractError(tx, {
    abi: allErrorsAbi,
    address: '0x1111111111111111111111111111111111111111',
    args: [true],
    docsPath: undefined,
    functionName: 'setAutoClaimOptIn',
    sender: '0x2222222222222222222222222222222222222222',
  })
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

  // The connect button branches on this predicate to start watching the wallet instead of showing
  // the generic "go deal with it" line, so it has to see the failure in every shape wallets throw.
  it('exposes the pending-request check itself, in every shape wallets throw it', () => {
    expect(isRequestAlreadyPending({ code: -32002 })).toBe(true)
    const wrapped = new Error('Connector failed')
    ;(wrapped as { cause?: unknown }).cause = { code: -32002 }
    expect(isRequestAlreadyPending(wrapped)).toBe(true)
    expect(isRequestAlreadyPending(new Error('Request of type eth_requestAccounts already pending'))).toBe(true)
    expect(isRequestAlreadyPending(new BaseError('Already processing eth_requestAccounts.'))).toBe(true)
    // A rejection, another code, or nothing at all is not "pending".
    expect(isRequestAlreadyPending({ code: 4001, message: 'User rejected the request.' })).toBe(false)
    expect(isRequestAlreadyPending(undefined)).toBe(false)
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

  // The owner's report, exactly: "自动领取设置 · 失败 / 出了点问题，重试一次（错误码 -32000）" after
  // clicking the auto-collect toggle on a freshly generated demo wallet with no tBNB. Every one of
  // these is a real BSC reply, and every one of them used to land in the generic fallback because
  // the classifier read viem's summary instead of the node's own sentence.
  describe('the -32000 family a node refuses a write with', () => {
    it('tells a wallet with no gas that it has no gas, in both languages', () => {
      for (const message of [
        'insufficient funds for gas * price + value: balance 0, tx cost 180000000000000, overshot 180000000000000',
        'insufficient funds for transfer',
      ]) {
        expect(humanizeError(nodeRefusal(message), 'zh'), message).toBe(ERROR_TEXT.noGas.zh)
        expect(humanizeError(nodeRefusal(message), 'en'), message).toBe(ERROR_TEXT.noGas.en)
      }
    })

    it('never falls back to the bare code for a failure the node named', () => {
      for (const [message, key] of [
        ['insufficient funds for gas * price + value: balance 0', 'noGas'],
        ['already known', 'alreadyKnown'],
        ['replacement transaction underpriced', 'replacementUnderpriced'],
        ['transaction underpriced', 'underpriced'],
      ] as Array<[string, keyof typeof ERROR_TEXT]>) {
        const zh = humanizeError(nodeRefusal(message), 'zh')
        expect(zh, message).toBe(ERROR_TEXT[key].zh)
        expect(zh, message).not.toContain('-32000')
        expect(zh, message).not.toBe(ERROR_TEXT.fallback.zh)
      }
    })

    // A wallet extension throws the provider error straight through, unwrapped by viem. The node
    // wrote the same sentence, so the reader gets the same answer.
    it('reads the same node sentence out of a bare provider error', () => {
      const bare = { code: -32000, message: 'insufficient funds for gas * price + value: balance 0' }
      expect(humanizeError(bare, 'zh')).toBe(ERROR_TEXT.noGas.zh)
      expect(humanizeError(bare, 'en')).toBe(ERROR_TEXT.noGas.en)
    })

    // The demo wallet signs in the page, so viem estimates gas itself and the refusal arrives one
    // wrapper deeper than an injected wallet's. It is the path the owner was on.
    it('says the same thing through the demo wallet’s deeper chain', () => {
      expect(humanizeError(demoRefusal('insufficient funds for transfer'), 'zh')).toBe(ERROR_TEXT.noGas.zh)
      expect(humanizeError(demoRefusal('insufficient funds for transfer'), 'en')).toBe(ERROR_TEXT.noGas.en)
    })

    // The guard that keeps a contract's own words out of the wallet's mouth. Deliberately at the
    // DEFAULT -32000: a revert sent under code 3 takes viem's decoding branch and never reaches
    // the prose tests where the two could be confused, so testing that code proves nothing here.
    it('does not blame the wallet for a revert that happens to mention funds', () => {
      for (const build of [nodeRefusal, demoRefusal]) {
        const reverted = build('execution reverted: ERC20: insufficient funds')
        expect(reverted.shortMessage.toLowerCase()).toContain('insufficient funds')
        expect(humanizeError(reverted, 'zh')).toBe(ERROR_TEXT.reverted.zh)
        expect(humanizeError(reverted, 'en')).toBe(ERROR_TEXT.reverted.en)
      }
    })

    // Nothing above weakens the rule the fallback exists for: a code we cannot name still shows
    // its number rather than pretending to know more than it does.
    it('still carries the code for a -32000 nobody has named', () => {
      const zh = humanizeError(nodeRefusal('some future node message'), 'zh')
      expect(zh).toContain('-32000')
    })

    // An injected wallet does not pass the node's reply through. MetaMask wraps it as -32603 with
    // the real sentence on `data`, and viem — which reads only the OUTER message into `details` —
    // then classifies the whole thing as a REVERT whose reason is the wallet's English envelope.
    // Without this the same empty wallet is diagnosable through the app's own demo connector and
    // undiagnosable through the wallet most people actually use.
    it('reaches the node’s sentence through an injected wallet’s -32603 envelope', () => {
      const wrapped = nodeRefusalWithData('Internal JSON-RPC error.', -32603, {
        code: -32000,
        message: 'err: insufficient funds for gas * price + value: address 0x… have 0 want 180000000000000',
      })
      expect(humanizeError(wrapped, 'zh')).toBe(ERROR_TEXT.noGas.zh)
      expect(humanizeError(wrapped, 'en')).toBe(ERROR_TEXT.noGas.en)
      // …and the wallet's own English envelope never reaches a reader as if the contract wrote it.
      for (const lang of ['en', 'zh'] as const) {
        expect(humanizeError(wrapped, lang)).not.toContain('Internal JSON-RPC error')
      }
    })

    it('does not report a wallet envelope as something the contract said', () => {
      const opaque = nodeRefusalWithData('Internal JSON-RPC error.', -32603, { code: -32000, message: 'nothing recognisable' })
      expect(humanizeError(opaque, 'zh')).toBe(ERROR_TEXT.unnamedRevert.zh)
      expect(humanizeError(opaque, 'en')).toBe(ERROR_TEXT.unnamedRevert.en)
    })
  })

  // Each of these used to be matched against a sentence the library does not write, so each was
  // dead: the copy existed, and the reader got the generic fallback anyway. They are asserted
  // against the real objects here, because a hand-written message proves only that the test and
  // the code agree with each other.
  describe('failures named by the library that threw them', () => {
    it('classifies viem’s own errors by what viem actually throws', () => {
      const mismatch = new ChainMismatchError({ chain: { id: 56, name: 'BNB Smart Chain' } as never, currentChainId: 97 })
      expect(mismatch.shortMessage).not.toContain('mismatch')
      expect(humanizeError(mismatch, 'zh')).toBe(ERROR_TEXT.wrongChain.zh)
      expect(humanizeError(mismatch, 'en')).toBe(ERROR_TEXT.wrongChain.en)

      const timeout = new TimeoutError({ body: {}, url: 'https://data-seed-prebsc-1-s1.bnbchain.org:8545' })
      expect(timeout.shortMessage.toLowerCase()).not.toContain('timed out')
      expect(humanizeError(timeout, 'zh')).toBe(ERROR_TEXT.timeout.zh)
      expect(humanizeError(timeout, 'en')).toBe(ERROR_TEXT.timeout.en)
    })

    // wagmi's errors do not extend viem's BaseError, so they skipped the whole classifying branch.
    it('classifies wagmi’s errors too, and leaks no library version to the reader', () => {
      const disconnected = new ConnectorNotConnectedError()
      expect(disconnected).not.toBeInstanceOf(BaseError)
      expect(humanizeError(disconnected, 'zh')).toBe(ERROR_TEXT.disconnected.zh)
      expect(humanizeError(disconnected, 'en')).toBe(ERROR_TEXT.disconnected.en)
      expect(humanizeError(disconnected, 'en')).not.toContain('@wagmi/core')
    })
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
