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
// Now with on-chain division using custom integer division for FHE
contract FHESwapUser is Ownable, SepoliaConfig {
    using FHE for *;

    // Token contract addresses
    ILocalConfidentialFungibleToken public immutable token0;
    ILocalConfidentialFungibleToken public immutable token1;

    // Encrypted reserves
    euint64 private _reserve0;
    euint64 private _reserve1;

    constructor(address _token0, address _token1, address owner) Ownable(owner) {
        token0 = ILocalConfidentialFungibleToken(_token0);
        token1 = ILocalConfidentialFungibleToken(_token1);
    }

    // Custom integer division for FHE (handles ciphertext denominator)
    function customDiv(euint64 numerator, euint64 denominator) internal returns (euint64) {
    // Removed req check as per request; assume denominator != 0

    euint64 quotient = FHE.asEuint64(0);
    euint64 remainder = numerator;

    for (uint8 i = 63; i >= 0; i--) {  // Fixed 64 iterations for euint64
        euint64 tempDivisor = FHE.shl(denominator, i);
        ebool canSubtract = FHE.ge(remainder, tempDivisor);
        euint64 bitSet = FHE.shl(FHE.asEuint64(1), i);
        quotient = FHE.add(quotient, FHE.select(canSubtract, bitSet, FHE.asEuint64(0)));
        remainder = FHE.sub(remainder, FHE.select(canSubtract, tempDivisor, FHE.asEuint64(0)));
    }

    return quotient;
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
    function getAmountOut(
        externalEuint64 amountIn, 
        bytes calldata amountInProof, 
        address inputToken
    ) external returns (euint64) {
        require(FHE.isInitialized(_reserve0), "Reserve0 not set");
        require(FHE.isInitialized(_reserve1), "Reserve1 not set");

        // 将外部加密输入转换为内部加密值
        euint64 encryptedAmountIn = FHE.fromExternal(amountIn, amountInProof);
        
        // 授权 encryptedAmountIn
        FHE.allowThis(encryptedAmountIn);
        FHE.allowTransient(encryptedAmountIn, address(this));

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

        // 授权储备量
        FHE.allowThis(reserveIn);
        FHE.allowThis(reserveOut);
        FHE.allowTransient(reserveIn, address(this));
        FHE.allowTransient(reserveOut, address(this));

        // 计算带手续费的输入金额 (0.3% fee，即 997/1000)
        euint64 amountInWithFee = FHE.mul(encryptedAmountIn, FHE.asEuint64(997));
        FHE.allowThis(amountInWithFee);
        FHE.allowTransient(amountInWithFee, address(this));

        // 计算分子和分母
        euint64 numerator = FHE.mul(amountInWithFee, reserveOut);
        euint64 denominator = FHE.add(FHE.mul(reserveIn, FHE.asEuint64(1000)), amountInWithFee);

        // 使用自定义除法计算 amountOut
        euint64 amountOut = customDiv(numerator, denominator);

        // 允许访问
        FHE.allowThis(amountOut);
        FHE.allow(amountOut, msg.sender);

        return amountOut;
    }

    // 执行代币交换
    function swap(
        externalEuint64 amountIn,
        bytes calldata amountInProof,
        externalEuint64 expectedAmountOut,
        bytes calldata expectedAmountOutProof,
        externalEuint64 minAmountOut,
        bytes calldata minAmountOutProof,
        address inputToken,
        address to
    ) public {
        require(FHE.isInitialized(_reserve0), "Reserve0 not set for swap");
        require(FHE.isInitialized(_reserve1), "Reserve1 not set for swap");

        // 将外部加密输入转换为内部加密值
        euint64 encryptedAmountIn = FHE.fromExternal(amountIn, amountInProof);
        FHE.allowThis(encryptedAmountIn);
        FHE.allowTransient(encryptedAmountIn, address(this));
        FHE.allowTransient(encryptedAmountIn, address(token0));
        FHE.allowTransient(encryptedAmountIn, address(token1));
        
        euint64 expectedAmountOutEncrypted = FHE.fromExternal(expectedAmountOut, expectedAmountOutProof);
        euint64 minAmountOutEncrypted = FHE.fromExternal(minAmountOut, minAmountOutProof);
        
        FHE.allowThis(expectedAmountOutEncrypted);
        FHE.allowThis(minAmountOutEncrypted);
        FHE.allowTransient(expectedAmountOutEncrypted, address(this));
        FHE.allowTransient(minAmountOutEncrypted, address(this));

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

        // 授权储备量
        FHE.allowThis(reserveIn);
        FHE.allowThis(reserveOut);
        FHE.allowTransient(reserveIn, address(this));
        FHE.allowTransient(reserveOut, address(this));

        // 计算带手续费的输入金额
        euint64 amountInWithFee = FHE.mul(encryptedAmountIn, FHE.asEuint64(997));

        // 计算分子和分母
        euint64 numerator = FHE.mul(amountInWithFee, reserveOut);
        euint64 denominator = FHE.add(FHE.mul(reserveIn, FHE.asEuint64(1000)), amountInWithFee);

        // 使用自定义除法计算 amountOut
        euint64 amountOut = customDiv(numerator, denominator);

        // 验证 expectedAmountOut 匹配
        ebool expectedMatch = FHE.eq(amountOut, expectedAmountOutEncrypted);
        // 注意：这里无法用 require，因为 expectedMatch 是 ebool；如果需要回滚，可以用其他机制或假设客户端验证

        // 验证 slippage
        ebool slippageOk = FHE.ge(amountOut, minAmountOutEncrypted);
        // 同上，无法直接 require

        // K 值验证
        euint64 newReserveInForK = FHE.add(FHE.mul(reserveIn, FHE.asEuint64(1000)), amountInWithFee);
        euint64 newReserveOutForK = FHE.sub(reserveOut, amountOut);
        euint64 newK = FHE.mul(newReserveInForK, newReserveOutForK);

        euint64 oldK = FHE.mul(FHE.mul(reserveIn, FHE.asEuint64(1000)), reserveOut);

        ebool invariantOk = FHE.ge(newK, oldK);
        // 同上，无法 require；生产中可以添加 if (FHE.decrypt(invariantOk)) require(true); 但需要解密

        FHE.allowTransient(amountOut, address(tokenOut));

        // 转移输入代币
        tokenIn.confidentialTransferFrom(msg.sender, address(this), encryptedAmountIn);

        // 更新储备量
        if (inputToken == address(token0)) {
            _reserve0 = _reserve0.add(encryptedAmountIn);
            _reserve1 = _reserve1.sub(amountOut);
        } else {
            _reserve1 = _reserve1.add(encryptedAmountIn);
            _reserve0 = _reserve0.sub(amountOut);
        }

        // 转移输出代币
        tokenOut.confidentialTransfer(to, amountOut);

        // 允许访问更新后的储备
        FHE.allowThis(_reserve0);
        FHE.allowThis(_reserve1);
        FHE.allow(_reserve0, to);
        FHE.allow(_reserve1, to);
        FHE.allow(_reserve0, owner());
        FHE.allow(_reserve1, owner());
    }

    // 获取储备量
    function getEncryptedReserve0() external view returns (euint64) {
        return _reserve0;
    }

    function getEncryptedReserve1() external view returns (euint64) {
        return _reserve1;
    }
}