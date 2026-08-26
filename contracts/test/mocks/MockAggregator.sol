// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IAggregatorV3} from "../../src/IAggregatorV3.sol";

/// @notice Controllable Chainlink-shaped feed with real round history, for tests.
/// @dev Test-only. The testnet deployment uses `src/testnet/RelayAggregator.sol`, which gates its
///      writes behind an owner/updater.
contract MockAggregator is IAggregatorV3 {
    struct RoundData {
        int256 answer;
        uint256 updatedAt;
    }

    uint8 public immutable override decimals;
    string public override description;
    address public owner;

    uint80 public latestId;
    uint80 public phase = 1;
    uint80 public aggRound;
    mapping(uint80 => RoundData) private _history;
    bool public shouldRevert;

    /// @dev Chainlink proxy round ids are `phaseId << 64 | aggregatorRoundId`.
    uint80 private constant PHASE_SHIFT = 64;

    error NotOwner();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(uint8 decimals_, string memory description_, int256 initialAnswer) {
        decimals = decimals_;
        description = description_;
        owner = msg.sender;
        aggRound = 1;
        latestId = _compose(1, 1);
        _history[latestId] = RoundData(initialAnswer, block.timestamp);
    }

    function _compose(uint80 phase_, uint80 aggRound_) internal pure returns (uint80) {
        return uint80((uint256(phase_) << PHASE_SHIFT) | uint256(aggRound_));
    }

    /// @dev Simulates an aggregator upgrade: ids jump to the next phase and restart at 1, which is
    ///      exactly where a naive `roundId + 1` successor check breaks.
    function startNewPhase() external onlyOwner {
        phase += 1;
        aggRound = 0;
    }

    function setOwner(address o) external onlyOwner {
        owner = o;
    }

    function setAnswer(int256 answer) external onlyOwner returns (uint80) {
        return _push(answer, block.timestamp);
    }

    function setAnswerAt(int256 answer, uint256 updatedAt) external onlyOwner returns (uint80) {
        return _push(answer, updatedAt);
    }

    /// @dev Overwrites the newest round in place, to exercise callers that assume monotonic ids.
    function setAnswerSameRound(int256 answer) external onlyOwner {
        _history[latestId] = RoundData(answer, block.timestamp);
    }

    function setShouldRevert(bool v) external onlyOwner {
        shouldRevert = v;
    }

    function _push(int256 answer, uint256 updatedAt) internal returns (uint80) {
        aggRound += 1;
        latestId = _compose(phase, aggRound);
        _history[latestId] = RoundData(answer, updatedAt);
        return latestId;
    }

    function getRoundData(uint80 roundId)
        public
        view
        override
        returns (uint80, int256, uint256, uint256, uint80)
    {
        require(!shouldRevert, "MockAggregator: forced revert");
        RoundData memory d = _history[roundId];
        require(d.updatedAt != 0, "MockAggregator: no data present");
        return (roundId, d.answer, d.updatedAt, d.updatedAt, roundId);
    }

    function latestRoundData() external view override returns (uint80, int256, uint256, uint256, uint80) {
        return getRoundData(latestId);
    }
}
