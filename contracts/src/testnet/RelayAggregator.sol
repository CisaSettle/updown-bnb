// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IAggregatorV3} from "../IAggregatorV3.sol";

/**
 * @title RelayAggregator
 * @notice Chainlink-shaped feed with round history for **BSC testnet only**, fed by the project
 *         keeper from a real spot price.
 * @dev BSC testnet's own Chainlink feeds update far too infrequently to drive 5-minute rounds
 *      (BNB/USD was 1480 s stale when this was written), which would void every short round. This
 *      relay keeps testnet behaviour representative of mainnet. `Deploy.s.sol` refuses to deploy it
 *      on mainnet. Writes are restricted to the owner and a single updater so nobody can front-run
 *      a testnet settlement with an arbitrary price.
 */
contract RelayAggregator is IAggregatorV3, Ownable {
    struct RoundData {
        int256 answer;
        uint256 updatedAt;
    }

    uint8 public immutable override decimals;
    string public override description;

    address public updater;
    uint80 public latestId;
    mapping(uint80 => RoundData) private _history;

    event AnswerRelayed(uint80 indexed roundId, int256 answer, uint256 updatedAt);
    event UpdaterChanged(address indexed updater);

    error NotUpdater();
    error BadAnswer();
    error NoData();
    error OwnershipCannotBeRenounced();

    constructor(
        address initialOwner,
        address updater_,
        uint8 decimals_,
        string memory description_,
        int256 initial
    ) Ownable(initialOwner) {
        decimals = decimals_;
        description = description_;
        updater = updater_;
        latestId = 1;
        _history[1] = RoundData(initial, block.timestamp);
    }

    /// @notice Disabled: an ownerless relay could never rotate an unavailable or compromised
    ///         updater, which would strand the feed every testnet round settles on.
    function renounceOwnership() public pure override {
        revert OwnershipCannotBeRenounced();
    }

    function setUpdater(address updater_) external onlyOwner {
        updater = updater_;
        emit UpdaterChanged(updater_);
    }

    function relay(int256 answer) external returns (uint80 roundId) {
        if (msg.sender != updater && msg.sender != owner()) revert NotUpdater();
        if (answer <= 0) revert BadAnswer();
        unchecked {
            latestId += 1;
        }
        roundId = latestId;
        _history[roundId] = RoundData(answer, block.timestamp);
        emit AnswerRelayed(roundId, answer, block.timestamp);
    }

    function getRoundData(uint80 roundId)
        public
        view
        override
        returns (uint80, int256, uint256, uint256, uint80)
    {
        RoundData memory d = _history[roundId];
        if (d.updatedAt == 0) revert NoData();
        return (roundId, d.answer, d.updatedAt, d.updatedAt, roundId);
    }

    function latestRoundData() external view override returns (uint80, int256, uint256, uint256, uint80) {
        return getRoundData(latestId);
    }
}
