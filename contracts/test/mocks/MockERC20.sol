// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    /// @notice basis points burned on every transfer, to exercise fee-on-transfer handling
    uint256 public transferFeeBps;
    /// @notice extra basis points taken from the SENDER only: the recipient still receives the full
    ///         `amount` while the sender is debited more. Exercises the surcharge-token case.
    uint256 public senderSurchargeBps;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory n, string memory s, uint8 d) {
        name = n;
        symbol = s;
        decimals = d;
    }

    function setTransferFeeBps(uint256 bps) external {
        transferFeeBps = bps;
    }

    function setSenderSurchargeBps(uint256 bps) external {
        senderSurchargeBps = bps;
    }

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) {
            require(a >= amount, "allowance");
            allowance[from][msg.sender] = a - amount;
        }
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        uint256 surcharge = (amount * senderSurchargeBps) / 10_000;
        uint256 debit = amount + surcharge;
        require(balanceOf[from] >= debit, "balance");
        balanceOf[from] -= debit;
        uint256 fee = (amount * transferFeeBps) / 10_000;
        uint256 net = amount - fee;
        balanceOf[to] += net;
        uint256 burned = fee + surcharge;
        if (burned > 0) totalSupply -= burned;
        emit Transfer(from, to, net);
    }
}
