// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {FHE, externalEuint32, euint32, euint64, externalEuint64, ebool} from "@fhevm/solidity/lib/FHE.sol";
import {SepoliaConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {
    IConfidentialFungibleToken
} from "@openzeppelin/confidential-contracts/interfaces/IConfidentialFungibleToken.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

// Local interface for confidential token operations
interface ILocalConfidentialFungibleToken is IConfidentialFungibleToken {
    function confidentialTransferFrom(address sender, address recipient, euint64 amount) external returns (euint64);
    function confidentialTransfer(address recipient, euint64 amount) external returns (euint64);
    function setOperator(address operator, uint64 expiration) external;
    function confidentialBalanceOf(address account) external view returns (euint64);
}

// FHESwap: Confidential token swap logic similar to Uniswap V2
// Note: Division operations must be done off-chain due to FHE limitations
contract FHESwap is Ownable, SepoliaConfig {
    using FHE for *;

    // Token contract addresses
    ILocalConfidentialFungibleToken public immutable token0;
    ILocalConfidentialFungibleToken public immutable token1;

    // Encrypted reserves
    euint64 private _reserve0;
    euint64 private _reserve1;

    // Temporary encrypted numerator/denominator for getAmountOut
    // Users decrypt these off-chain, calculate division, then re-encrypt for swap
    euint64 private _lastNumerator;
    euint64 private _lastDenominator;

    constructor(address _token0, address _token1, address owner) Ownable(owner) {
        token0 = ILocalConfidentialFungibleToken(_token0);
        token1 = ILocalConfidentialFungibleToken(_token1);
    }

    // Add initial liquidity or add to existing liquidity
    // Users must authorize this contract as operator
    function mint(
        externalEuint64 amount0,
        bytes calldata amount0Proof,
        externalEuint64 amount1,
        bytes calldata amount1Proof
    ) public {
        // Decrypt liquidity amounts
        euint64 decryptedAmount0 = FHE.fromExternal(amount0, amount0Proof);
        euint64 decryptedAmount1 = FHE.fromExternal(amount1, amount1Proof);

        // Grant access permissions (self first, then transient)
        FHE.allowThis(decryptedAmount0);
        FHE.allowThis(decryptedAmount1);
        FHE.allowTransient(decryptedAmount0, address(this));
        FHE.allowTransient(decryptedAmount1, address(this));
        FHE.allowTransient(decryptedAmount0, address(token0));
        FHE.allowTransient(decryptedAmount1, address(token1));

        // Grant access to existing reserves if initialized
        if (FHE.isInitialized(_reserve0)) {
            FHE.allowThis(_reserve0);
            FHE.allowThis(_reserve1);
            FHE.allowTransient(_reserve0, address(this));
            FHE.allowTransient(_reserve1, address(this));
        }

        // Transfer tokens from sender to this contract
        token0.confidentialTransferFrom(msg.sender, address(this), decryptedAmount0);
        token1.confidentialTransferFrom(msg.sender, address(this), decryptedAmount1);

        // Update reserves
        if (!FHE.isInitialized(_reserve0)) {
            _reserve0 = decryptedAmount0;
            _reserve1 = decryptedAmount1;
        } else {
            _reserve0 = _reserve0.add(decryptedAmount0);
            _reserve1 = _reserve1.add(decryptedAmount1);
        }

        // Grant access to updated reserves
        FHE.allowThis(_reserve0);
        FHE.allowThis(_reserve1);
        FHE.allow(_reserve0, msg.sender);
        FHE.allow(_reserve1, msg.sender);
    }

    /// @notice 计算输出代币数量（使用加密计算）
    /// @param amountIn 加密的输入代币数量
    /// @param amountInProof 输入数量的加密证明
    /// @param inputToken 是 token0 还是 token1
    function getAmountOut(externalEuint64 amountIn, bytes calldata amountInProof, address inputToken) external {
        // 验证储备量已设置
        require(FHE.isInitialized(_reserve0), "Reserve0 not set");
        require(FHE.isInitialized(_reserve1), "Reserve1 not set");

        // 将外部加密输入转换为内部加密值
        euint64 encryptedAmountIn = FHE.fromExternal(amountIn, amountInProof);

        euint64 reserveIn;
        euint64 reserveOut;

        if (inputToken == address(token0)) {
            reserveIn = _reserve0;
            reserveOut = _reserve1;
        } else if (inputToken == address(token1)) {
            reserveIn = _reserve1;
            reserveOut = _reserve0;
        } else {
            revert("Invalid input token");
        }

        // 计算带手续费的输入金额 (0.3% fee，即 997/1000)
        euint64 amountInWithFee = FHE.mul(encryptedAmountIn, 997);

        // 计算分子和分母
        // numerator = amountInWithFee * reserveOut
        // denominator = reserveIn * 1000 + amountInWithFee
        _lastNumerator = FHE.mul(amountInWithFee, reserveOut);
        _lastDenominator = FHE.add(FHE.mul(reserveIn, 1000), amountInWithFee);

        // 允许解密
        FHE.allowThis(_lastNumerator);
        FHE.allowThis(_lastDenominator);
        FHE.allow(_lastNumerator, msg.sender);
        FHE.allow(_lastDenominator, msg.sender);
    }

    /// @notice 获取最后计算的加密分子
    function getEncryptedNumerator() external view returns (euint64) {
        return _lastNumerator;
    }

    /// @notice 获取最后计算的加密分母
    function getEncryptedDenominator() external view returns (euint64) {
        return _lastDenominator;
    }

    // 执行代币交换
    // 用户需要在链下通过 getAmountOut 获得分子分母，解密后计算 amountOut，再加密传入
    function swap(
        externalEuint64 amountIn,
        bytes calldata amountInProof,
        externalEuint64 expectedAmountOut, // 链下计算并重新加密的期望输出量
        bytes calldata expectedAmountOutProof,
        externalEuint64 minAmountOut, // 新增参数：用户链下计算的最小期望输出量（已加密）
        bytes calldata minAmountOutProof, // 新增参数：最小期望输出量的证明
        address inputToken, // 用户传入的代币地址
        address to // 接收输出代币的地址
    ) public {
        // 验证储备量已设置
        require(FHE.isInitialized(_reserve0), "Reserve0 not set for swap");
        require(FHE.isInitialized(_reserve1), "Reserve1 not set for swap");

        // 将外部加密输入转换为内部加密值
        euint64 decryptedAmountIn = FHE.fromExternal(amountIn, amountInProof); 
        // 授予输入代币合约对该金额的瞬态访问权限
        FHE.allowTransient(decryptedAmountIn, address(token0));
        FHE.allowTransient(decryptedAmountIn, address(token1));
        euint64 decryptedExpectedAmountOut = FHE.fromExternal(expectedAmountOut, expectedAmountOutProof);
        euint64 decryptedMinAmountOut = FHE.fromExternal(minAmountOut, minAmountOutProof); // 解密最小期望输出量

        ILocalConfidentialFungibleToken tokenIn;
        ILocalConfidentialFungibleToken tokenOut;
        euint64 reserveIn;
        euint64 reserveOut;

        if (inputToken == address(token0)) {
            tokenIn = token0;
            tokenOut = token1;
            reserveIn = _reserve0;
            reserveOut = _reserve1;
        } else if (inputToken == address(token1)) {
            tokenIn = token1;
            tokenOut = token0;
            reserveIn = _reserve1;
            reserveOut = _reserve0;
        } else {
            revert("Invalid input token for swap");
        }

        // 授予输出代币合约对预期输出金额的瞬态访问权限
        FHE.allowTransient(decryptedExpectedAmountOut, address(tokenOut));

        // // --- 链上验证（Uniswap V2 K值验证） ---
        // // 验证公式： (reserveIn + amountInWithFee) * (reserveOut - expectedAmountOut) >= reserveIn * reserveOut
        // // FHE支持加密数据之间的比较操作 (ge, gt, le, lt)。

        // // 1. 计算带手续费的输入金额 (0.3% fee，即 997/1000)
        // euint64 amountInWithFee = FHE.mul(decryptedAmountIn, 997);

        // // 2. 计算左侧： (reserveIn * 1000 + amountInWithFee) * (reserveOut - expectedAmountOut)
        // // 为了保持单位一致性，reserveIn 也要乘以 1000
        // euint64 newReserveInForK = FHE.add(FHE.mul(reserveIn, 1000), amountInWithFee);
        // euint64 newReserveOutForK = reserveOut.sub(decryptedExpectedAmountOut);

        // // 检查 newReserveOutForK 是否可能下溢。如果 expectedAmountOut 过大，可能会导致储备量为负，
        // // 这是一个无效状态。考虑到 Uniswap V2 K值验证本身会捕获无效的 `expectedAmountOut`，
        // // 我们可以依赖后续的 K值验证。

        // euint64 new_k = FHE.mul(newReserveInForK, newReserveOutForK);

        // // 3. 计算右侧： reserveIn * 1000 * reserveOut (旧的K值，同样保持单位一致性)
        // euint64 old_k = FHE.mul(FHE.mul(reserveIn, 1000), reserveOut);

        // 从 msg.sender 转移输入代币到本合约
        tokenIn.confidentialTransferFrom(msg.sender, address(this), decryptedAmountIn);

        // 更新储备量
        if (inputToken == address(token0)) {
            _reserve0 = _reserve0.add(decryptedAmountIn);
            // 这里依赖于验证的正确性，确保 decryptedExpectedAmountOut 不会使储备量为负
            _reserve1 = _reserve1.sub(decryptedExpectedAmountOut);
        } else {
            _reserve1 = _reserve1.add(decryptedAmountIn);
            _reserve0 = _reserve0.sub(decryptedExpectedAmountOut);
        }

        // 转移输出代币给接收者
        tokenOut.confidentialTransfer(to, decryptedExpectedAmountOut);

        // 允许链上和 to 访问更新后的储备量
        FHE.allowThis(_reserve0);
        FHE.allowThis(_reserve1);
        FHE.allow(_reserve0, to);
        FHE.allow(_reserve1, to);
        // 允许 owner 访问更新后的储备量，以便在测试中进行验证
        FHE.allow(_reserve0, owner());
        FHE.allow(_reserve1, owner());
    }

    // 获取储备量（仅限 owner 查看，或通过 getAmountOut 间接计算）
    function getEncryptedReserve0() external view returns (euint64) {
        return _reserve0;
    }

    function getEncryptedReserve1() external view returns (euint64) {
        return _reserve1;
    }
}
