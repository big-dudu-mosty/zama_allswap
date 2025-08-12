import { FHESwap, FHESwap__factory, ConfidentialFungibleTokenMintableBurnable, ConfidentialFungibleTokenMintableBurnable__factory } from "../types";
import { FhevmType } from "@fhevm/hardhat-plugin";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import hre from "hardhat";
import { ethers as ethersjs } from "ethers";

/**
 * @dev Define the signer types used in tests.
 * deployer: The account that deploys contracts, usually the "owner" or "admin" in tests.
 * alice: An account that simulates regular user interactions.
 * bob: Another account that simulates regular user interactions.
 */
type Signers = {
  deployer: HardhatEthersSigner;
  alice: HardhatEthersSigner;
  bob: HardhatEthersSigner;
};

/**
 * @dev Helper function to deploy ConfidentialFungibleTokenMintableBurnable and FHESwap contracts.
 * @param deployerAddress The deployer address of the contracts, which will also be the owner of the token contracts and FHESwap contract.
 * @returns Object containing deployed token contract instances, addresses, and FHESwap contract instance and address.
 */
async function deployTokenAndSwapFixture(deployerAddress: string) {
  console.log("\n--- Deploying Contracts ---");
  // Get ConfidentialFungibleTokenMintableBurnable contract factory
  const tokenFactory = (await ethers.getContractFactory("ConfidentialFungibleTokenMintableBurnable")) as ConfidentialFungibleTokenMintableBurnable__factory;
  // Deploy TokenA with name "TokenA" and symbol "TKA"
  const tokenA = (await tokenFactory.deploy(deployerAddress, "TokenA", "TKA", "https://example.com/metadataA")) as ConfidentialFungibleTokenMintableBurnable;
  // Deploy TokenB with name "TokenB" and symbol "TKB"
  const tokenB = (await tokenFactory.deploy(deployerAddress, "TokenB", "TKB", "https://example.com/metadataB")) as ConfidentialFungibleTokenMintableBurnable;

  // Get deployed TokenA and TokenB contract addresses
  const tokenAAddress = await tokenA.getAddress();
  const tokenBAddress = await tokenB.getAddress();
  console.log(`TokenA deployed at: ${tokenAAddress}`);
  console.log(`TokenB deployed at: ${tokenBAddress}`);

  // Get FHESwap contract factory
  const swapFactory = (await ethers.getContractFactory("FHESwap")) as FHESwap__factory;
  // Deploy FHESwap contract, passing TokenA and TokenB addresses, and deployer address as owner
  const fHeSwap = (await swapFactory.deploy(tokenAAddress, tokenBAddress, deployerAddress)) as FHESwap;
  // Get deployed FHESwap contract address
  const fHeSwapAddress = await fHeSwap.getAddress();
  console.log(`FHESwap deployed at: ${fHeSwapAddress}`);
  console.log("--- Contract Deployment Complete ---\n");

  // Return all deployed contract instances and addresses
  return { tokenA, tokenB, tokenAAddress, tokenBAddress, fHeSwap, fHeSwapAddress };
}

/**
 * @dev Test suite for FHESwap contract.
 * Includes tests for deployment, liquidity provision, and token swapping.
 */
describe("FHESwap", function () {
  // Define signers and contract instance variables used in tests
  let signers: Signers;
  let tokenA: ConfidentialFungibleTokenMintableBurnable;
  let tokenB: ConfidentialFungibleTokenMintableBurnable;
  let tokenAAddress: string;
  let tokenBAddress: string;
  let fHeSwap: FHESwap;
  let fHeSwapAddress: string;
  let initialReserveAmountA: bigint;
  let initialReserveAmountB: bigint;

  // Hook function executed once before all test cases
  before(async function () {
    console.log("--- Test Initialization ---");
    // Initialize FHEVM CLI API, which is required for interacting with FHEVM
    await fhevm.initializeCLIApi();
    // Get Ethereum signers (accounts) provided by Hardhat
    const ethSigners: HardhatEthersSigner[] = await ethers.getSigners();
    // Assign signers to named variables for later use
    signers = { deployer: ethSigners[0], alice: ethSigners[1], bob: ethSigners[2] };
    console.log(`Deployer address: ${signers.deployer.address}`);
    console.log(`Alice address: ${signers.alice.address}`);
    console.log(`Bob address: ${signers.bob.address}`);

    // Call helper function to deploy all contracts and destructure assignment to corresponding variables
    ({ tokenA, tokenB, tokenAAddress, tokenBAddress, fHeSwap, fHeSwapAddress } = await deployTokenAndSwapFixture(await signers.deployer.getAddress()));

    // Assert that FHEVM coprocessor is initialized. This is crucial for ensuring FHE operations work properly.
    await hre.fhevm.assertCoprocessorInitialized(tokenA, "ConfidentialFungibleTokenMintableBurnable");
    await hre.fhevm.assertCoprocessorInitialized(tokenB, "ConfidentialFungibleTokenMintableBurnable");
    await hre.fhevm.assertCoprocessorInitialized(fHeSwap, "FHESwap");
    console.log("--- FHEVM Coprocessor Initialization Complete ---\n");
  });

  /**
   * @dev Test if FHESwap contract is successfully deployed and check its initial state (such as token0, token1, owner addresses).
   */
  it("should deploy FHESwap successfully and set correct token addresses", async function () {
    console.log("--- Test: Deploy FHESwap and Set Correct Addresses ---");

    // Verify that the token0 address recorded in FHESwap contract matches the actually deployed TokenA address
    expect(await fHeSwap.token0()).to.equal(tokenAAddress);
    console.log(`FHESwap.token0: ${await fHeSwap.token0()} (expected: ${tokenAAddress})`);

    // Verify that the token1 address recorded in FHESwap contract matches the actually deployed TokenB address
    expect(await fHeSwap.token1()).to.equal(tokenBAddress);
    console.log(`FHESwap.token1: ${await fHeSwap.token1()} (expected: ${tokenBAddress})`);
    
    // Verify that the owner of FHESwap contract is the deployer
    expect(await fHeSwap.owner()).to.equal(signers.deployer.address);
    console.log(`FHESwap.owner: ${await fHeSwap.owner()} (expected: ${signers.deployer.address})`);
    console.log("--- Deployment Test Passed ---\n");
  });

  /**
   * @dev Test if the owner (deployer) can successfully mint initial liquidity to the FHESwap contract.
   * This includes minting tokens to themselves, authorizing the FHESwap contract as an operator, and then calling the FHESwap's mint function.
   * Finally, verify that the encrypted reserves inside the FHESwap contract are correctly updated.
   */
  it("should allow owner to mint initial liquidity", async function () {
    console.log("--- Test: Owner Mints Initial Liquidity ---");
    const owner = signers.deployer; // Define owner as deployer account
    initialReserveAmountA = ethersjs.parseUnits("1000", 6); // Initial liquidity amount
    initialReserveAmountB = ethersjs.parseUnits("300", 6); // Initial liquidity amount
    console.log(`Initial reserve amounts TokenA: ${ethersjs.formatUnits(initialReserveAmountA, 6)}, TokenB: ${ethersjs.formatUnits(initialReserveAmountB, 6)}`);

    // 1. Owner first mints TokenA and TokenB to themselves (for providing liquidity)
    console.log("1. Owner mints tokens to themselves:");
    // Create encrypted input, target contract is TokenA, initiator is owner, value is initialReserveAmount (euint64 type)
    const encryptedMintA = await fhevm.createEncryptedInput(tokenAAddress, owner.address).add64(initialReserveAmountA).encrypt();
    console.log(`Created encrypted input (TokenA): Handle=${ethersjs.hexlify(encryptedMintA.handles[0])}, Proof=${ethersjs.hexlify(encryptedMintA.inputProof)}`);
    // Owner calls TokenA contract's mint function to mint encrypted TokenA to themselves
    await tokenA.connect(owner).mint(owner.address, encryptedMintA.handles[0], encryptedMintA.inputProof);
    console.log(`Owner minted ${ethersjs.formatUnits(initialReserveAmountA, 6)} TokenA to themselves.`);

    // Get owner's encrypted balance handle in TokenA
    const ownerTokenAEncryptedBalance = await tokenA.confidentialBalanceOf(owner.address);
    console.log(`Owner's encrypted balance handle in TokenA: ${ethersjs.hexlify(ownerTokenAEncryptedBalance)}`);
    // Authorize TokenA contract to operate on owner's encrypted TokenA balance
    await tokenA.connect(owner).authorizeSelf(ownerTokenAEncryptedBalance);
    console.log(`Owner authorized TokenA contract to operate their encrypted TokenA balance (handle: ${ethersjs.hexlify(ownerTokenAEncryptedBalance)}, authorized to: ${tokenAAddress}).`);

    // Decrypt owner's balance in TokenA for diagnostic printing
    const decryptedOwnerTokenA = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      ethersjs.hexlify(ownerTokenAEncryptedBalance),
      tokenAAddress,
      owner
    );
    console.log(`Diagnostic: Owner's TokenA balance (decrypted): ${ethersjs.formatUnits(decryptedOwnerTokenA, 6)}`);

    // Create encrypted input, target contract is TokenB, initiator is owner, value is initialReserveAmount (euint64 type)
    const encryptedMintB = await fhevm.createEncryptedInput(tokenBAddress, owner.address).add64(initialReserveAmountB).encrypt();
    console.log(`Created encrypted input (TokenB): Handle=${ethersjs.hexlify(encryptedMintB.handles[0])}, Proof=${ethersjs.hexlify(encryptedMintB.inputProof)}`);
    // Owner calls TokenB contract's mint function to mint encrypted TokenB to themselves
    await tokenB.connect(owner).mint(owner.address, encryptedMintB.handles[0], encryptedMintB.inputProof);
    console.log(`Owner minted ${ethersjs.formatUnits(initialReserveAmountB, 6)} TokenB to themselves.`);

    // Get owner's encrypted balance handle in TokenB
    const ownerTokenBEncryptedBalance = await tokenB.confidentialBalanceOf(owner.address);
    console.log(`Owner's encrypted balance handle in TokenB: ${ethersjs.hexlify(ownerTokenBEncryptedBalance)}`);
    // Authorize TokenB contract to operate on owner's encrypted TokenB balance
    await tokenB.connect(owner).authorizeSelf(ownerTokenBEncryptedBalance);
    console.log(`Owner authorized TokenB contract to operate their encrypted TokenB balance (handle: ${ethersjs.hexlify(ownerTokenBEncryptedBalance)}, authorized to: ${tokenBAddress}).`);

    // 2. Owner authorizes FHESwap contract as operator for TokenA and TokenB
    console.log("2. Owner approves FHESwap as operator for TokenA and TokenB:");
    // operatorExpiry defines the expiration time for operator authorization (current time + 1 hour)
    const operatorExpiry = Math.floor(Date.now() / 1000) + 3600;
    // Owner calls TokenA contract's setOperator to authorize FHESwap contract to operate owner's TokenA
    await tokenA.connect(owner).setOperator(fHeSwapAddress, operatorExpiry);
    console.log(`Owner authorized FHESwap as TokenA operator (FHESwap address: ${fHeSwapAddress}, expiry: ${operatorExpiry}).`);
    // Owner calls TokenB contract's setOperator to authorize FHESwap contract to operate owner's TokenB
    await tokenB.connect(owner).setOperator(fHeSwapAddress, operatorExpiry);
    console.log(`Owner authorized FHESwap as TokenB operator (FHESwap address: ${fHeSwapAddress}, expiry: ${operatorExpiry}).`);

    // 3. Owner provides liquidity to FHESwap contract
    console.log("3. Owner provides liquidity to FHESwap:");
    // Create encrypted inputs, target contract is FHESwap, initiator is owner, value is initialReserveAmount (euint64 type)
    // Note: The target contract here must be fHeSwapAddress, as these encrypted inputs are prepared for FHESwap's mint function
    const encryptedAmount0 = await fhevm.createEncryptedInput(fHeSwapAddress, owner.address).add64(initialReserveAmountA).encrypt();
    console.log(`Created encrypted input (FHESwap mint TokenA): Handle=${ethersjs.hexlify(encryptedAmount0.handles[0])}, Proof=${ethersjs.hexlify(encryptedAmount0.inputProof)}`);
    const encryptedAmount1 = await fhevm.createEncryptedInput(fHeSwapAddress, owner.address).add64(initialReserveAmountB).encrypt();
    console.log(`Created encrypted input (FHESwap mint TokenB): Handle=${ethersjs.hexlify(encryptedAmount1.handles[0])}, Proof=${ethersjs.hexlify(encryptedAmount1.inputProof)}`);
    console.log(`Preparing to inject into FHESwap TokenA: ${ethersjs.formatUnits(initialReserveAmountA, 6)}, TokenB: ${ethersjs.formatUnits(initialReserveAmountB, 6)} (encrypted).`);

    // Owner calls FHESwap contract's mint function to provide encrypted TokenA and TokenB as liquidity
    await fHeSwap.connect(owner).mint(
      encryptedAmount0.handles[0],
      encryptedAmount0.inputProof,
      encryptedAmount1.handles[0],
      encryptedAmount1.inputProof
    );
    console.log("FHESwap.mint call completed, liquidity injected.");

    // Verify FHESwap contract's internal reserves (in encrypted state)
    console.log("Verifying FHESwap reserves:");
    // Get FHESwap contract's encrypted reserve0
    const encryptedReserve0 = await fHeSwap.getEncryptedReserve0();
    // Decrypt reserve0 for off-chain verification. Need to provide FHE type, encrypted value, associated contract address, and decryptor.
    const decryptedReserve0 = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      ethersjs.hexlify(encryptedReserve0),
      fHeSwapAddress,
      owner // This is owner because reserve0 allows owner access
    );
    console.log(`Decrypted FHESwap reserve0: ${ethersjs.formatUnits(decryptedReserve0, 6)} (expected: ${ethersjs.formatUnits(initialReserveAmountA, 6)})`);
    // Assert that decrypted reserve0 equals the initially set liquidity amount
    expect(decryptedReserve0).to.equal(initialReserveAmountA);

    // Get FHESwap contract's encrypted reserve1
    const encryptedReserve1 = await fHeSwap.getEncryptedReserve1();
    // Decrypt reserve1
    const decryptedReserve1 = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      ethersjs.hexlify(encryptedReserve1),
      fHeSwapAddress,
      owner
    );
    console.log(`Decrypted FHESwap reserve1: ${ethersjs.formatUnits(decryptedReserve1, 6)} (expected: ${ethersjs.formatUnits(initialReserveAmountB, 6)})`);
    // Assert that decrypted reserve1 equals the initially set liquidity amount
    expect(decryptedReserve1).to.equal(initialReserveAmountB);
    console.log("--- Initial Liquidity Injection Test Passed ---\n");
  });

  /**
   * @dev Test if a user (Alice) can successfully swap TokenA for TokenB with fees.
   * This test simulates the off-chain computation and on-chain verification process in FHEVM.
   */
  it("should allow a user to swap TokenA for TokenB with fees", async function () {
    console.log("--- Test: User Swaps TokenA for TokenB ---");
    const owner = signers.deployer; // Deployer account
    const alice = signers.alice;   // User account
    const swapAmount = 10;        // Amount of TokenA to swap
    console.log(`Swap amount: ${swapAmount}, Initial reserves: TokenA: ${ethersjs.formatUnits(initialReserveAmountA, 6)}, TokenB: ${ethersjs.formatUnits(initialReserveAmountB, 6)}`);

    // Ensure Alice has enough TokenA to swap
    console.log("Alice gets TokenA:");
    // Owner mints swapAmount of TokenA to Alice
    const encryptedAliceMintA = await fhevm.createEncryptedInput(tokenAAddress, owner.address).add64(ethersjs.parseUnits(swapAmount.toString(), 6)).encrypt();
    console.log(`Created encrypted input (Alice Mint TokenA): Handle=${ethersjs.hexlify(encryptedAliceMintA.handles[0])}, Proof=${ethersjs.hexlify(encryptedAliceMintA.inputProof)}`);
    await tokenA.connect(owner).mint(alice.address, encryptedAliceMintA.handles[0], encryptedAliceMintA.inputProof);
    console.log(`Owner minted ${swapAmount} TokenA to Alice.`);

    // Get Alice's encrypted balance handle in TokenA
    const aliceTokenAEncryptedBalanceAtMint = await tokenA.confidentialBalanceOf(alice.address);
    console.log(`Alice's encrypted balance handle in TokenA: ${ethersjs.hexlify(aliceTokenAEncryptedBalanceAtMint)}`);
    // Authorize TokenA contract to operate on Alice's encrypted TokenA balance
    await tokenA.connect(alice).authorizeSelf(aliceTokenAEncryptedBalanceAtMint);
    console.log(`Alice authorized TokenA contract to operate her TokenA encrypted balance (handle: ${ethersjs.hexlify(aliceTokenAEncryptedBalanceAtMint)}, authorized to: ${tokenAAddress}).`);

    console.log(`Alice authorized TokenA contract to operate her TokenA encrypted balance.`);

    // Decrypt Alice's balance in TokenA for diagnostic printing
    const decryptedAliceTokenA = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      ethersjs.hexlify(aliceTokenAEncryptedBalanceAtMint),
      tokenAAddress,
      alice
    );
    console.log(`Diagnostic: Alice's TokenA balance (decrypted): ${ethersjs.formatUnits(decryptedAliceTokenA, 6)}`);

    // Alice authorizes FHESwap contract as an operator for TokenA
    console.log("Alice approves FHESwap as an operator for TokenA:");
    // Authorize FHESwap contract to transfer TokenA from Alice's address
    const operatorExpiry = Math.floor(Date.now() / 1000) + 3600;
    await tokenA.connect(alice).setOperator(fHeSwapAddress, operatorExpiry);
    console.log(`Alice approved FHESwap as TokenA operator (FHESwap address: ${fHeSwapAddress}, expiry: ${operatorExpiry}).`);

    // 1. Alice calls FHESwap's getAmountOut function to get the numerator and denominator (on-chain encrypted computation)
    console.log("1. Alice calls getAmountOut to get the numerator and denominator (on-chain encrypted computation):");
    // Create encrypted input, target contract is FHESwap, initiator is alice, value is swapAmount (euint64 type)
    const encryptedSwapAmountIn = await fhevm.createEncryptedInput(fHeSwapAddress, alice.address).add64(ethersjs.parseUnits(swapAmount.toString(), 6)).encrypt();
    console.log(`Created encrypted input (Swap AmountIn): Handle=${ethersjs.hexlify(encryptedSwapAmountIn.handles[0])}, Proof=${ethersjs.hexlify(encryptedSwapAmountIn.inputProof)}`);
    // Alice calls getAmountOut, passing the encrypted input amount and input token address
    await fHeSwap.connect(alice).getAmountOut(
      encryptedSwapAmountIn.handles[0],
      encryptedSwapAmountIn.inputProof,
      tokenAAddress // Specify that the input token is TokenA
    );
    console.log("getAmountOut call completed.");

    // Get the encrypted numerator and denominator computed on-chain
    const encryptedNumerator = await fHeSwap.connect(alice).getEncryptedNumerator();
    console.log(`Got encrypted numerator: ${ethersjs.hexlify(encryptedNumerator)}`);
    const encryptedDenominator = await fHeSwap.connect(alice).getEncryptedDenominator();
    console.log(`Got encrypted denominator: ${ethersjs.hexlify(encryptedDenominator)}`);

    // 2. Alice decrypts the numerator and denominator off-chain
    console.log("2. Alice decrypts the numerator and denominator off-chain:");
    // Decrypt the numerator
    const decryptedNumerator = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      ethersjs.hexlify(encryptedNumerator),
      fHeSwapAddress,
      alice
    );
    console.log(`Decrypted numerator: ${ethersjs.formatUnits(decryptedNumerator, 6)}`);
    // Decrypt the denominator
    const decryptedDenominator = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      ethersjs.hexlify(encryptedDenominator),
      fHeSwapAddress,
      alice
    );
    console.log(`Decrypted denominator: ${ethersjs.formatUnits(decryptedDenominator, 6)}`);

    // 3. Alice computes the expected output amount off-chain (plaintext division)
    console.log("3. Alice computes the expected output amount off-chain:");
    // Note: FHEVM does not support encrypted division, so this step must be done off-chain
    const expectedClearAmountOut = decryptedNumerator / decryptedDenominator;
    console.log(`Off-chain computed expected output amount (expectedClearAmountOut): ${ethersjs.formatUnits(expectedClearAmountOut, 6)}`);

    // 4. Alice computes the minimum expected output amount off-chain with slippage
    console.log("4. Alice computes the minimum expected output amount off-chain with slippage:");
    const slippageTolerance = 0.01; // 1% slippage tolerance
    const minClearAmountOut = (expectedClearAmountOut * 99n) / 100n;
    console.log(`Slippage tolerance: ${slippageTolerance * 100}%, Minimum expected output amount (minClearAmountOut): ${ethersjs.formatUnits(minClearAmountOut, 6)}`);

    // 5. Alice re-encrypts the expected output amount and minimum expected output amount for on-chain use
    console.log("5. Alice re-encrypts the expected output amount and minimum expected output amount:");
    // Emphasize again: The target contract is fHeSwapAddress
    const encryptedExpectedAmountOut = await fhevm.createEncryptedInput(fHeSwapAddress, alice.address).add64(expectedClearAmountOut).encrypt();
    console.log(`Re-encrypted expected output amount: Handle=${ethersjs.hexlify(encryptedExpectedAmountOut.handles[0])}, Proof=${ethersjs.hexlify(encryptedExpectedAmountOut.inputProof)}`);
    const encryptedMinAmountOut = await fhevm.createEncryptedInput(fHeSwapAddress, alice.address).add64(minClearAmountOut).encrypt();
    console.log(`Re-encrypted minimum expected output amount: Handle=${ethersjs.hexlify(encryptedMinAmountOut.handles[0])}, Proof=${ethersjs.hexlify(encryptedMinAmountOut.inputProof)}`);
    console.log("Re-encryption completed.");

    // 6. Alice executes the swap (on-chain transaction)
    console.log("6. Alice executes the swap (on-chain transaction):");
    console.log(`Calling fHeSwap.swap with parameters:\n  encryptedSwapAmountIn.handles[0]: ${ethersjs.hexlify(encryptedSwapAmountIn.handles[0])}\n  encryptedSwapAmountIn.inputProof: ${ethersjs.hexlify(encryptedSwapAmountIn.inputProof)}\n  encryptedExpectedAmountOut.handles[0]: ${ethersjs.hexlify(encryptedExpectedAmountOut.handles[0])}\n  encryptedExpectedAmountOut.inputProof: ${ethersjs.hexlify(encryptedExpectedAmountOut.inputProof)}\n  encryptedMinAmountOut.handles[0]: ${ethersjs.hexlify(encryptedMinAmountOut.handles[0])}\n  encryptedMinAmountOut.inputProof: ${ethersjs.hexlify(encryptedMinAmountOut.inputProof)}\n  tokenAAddress: ${tokenAAddress}\n  alice.address: ${alice.address}`);

    await fHeSwap.connect(alice).swap(
      encryptedSwapAmountIn.handles[0],    // Encrypted input amount handle
      encryptedSwapAmountIn.inputProof,    // Encrypted input amount proof
      encryptedExpectedAmountOut.handles[0], // Re-encrypted expected output amount handle
      encryptedExpectedAmountOut.inputProof, // Re-encrypted expected output amount proof
      encryptedMinAmountOut.handles[0],    // Re-encrypted minimum expected output amount handle
      encryptedMinAmountOut.inputProof,    // Re-encrypted minimum expected output amount proof
      tokenAAddress,                       // Input token is TokenA
      alice.address                        // Output token recipient is Alice
    );
    console.log("FHESwap.swap call completed.");

    // After the swap, verify Alice's balances
    console.log("Verifying Alice's balances:");

    // Get Alice's encrypted balance in TokenA
    const aliceTokenAEncryptedBalance = await tokenA.confidentialBalanceOf(alice.address);
    
    // Decrypt Alice's TokenA balance
    const aliceTokenADecryptedBalance = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      ethersjs.hexlify(aliceTokenAEncryptedBalance),
      tokenAAddress,
      alice
    );
    console.log(`Alice's TokenA balance (decrypted): ${ethersjs.formatUnits(aliceTokenADecryptedBalance, 6)}`);

    // Get Alice's encrypted balance in TokenB
    const aliceTokenBEncryptedBalance = await tokenB.confidentialBalanceOf(alice.address);
    
    // Decrypt Alice's TokenB balance
    const aliceTokenBDecryptedBalance = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      ethersjs.hexlify(aliceTokenBEncryptedBalance),
      tokenBAddress,
      alice
    );
    console.log(`Alice's TokenB balance (decrypted): ${ethersjs.formatUnits(aliceTokenBDecryptedBalance, 6)}`);

    // Calculate Alice's expected final balances
    const expectedAliceTokenA = 0n; // Alice swapped all her initial TokenA
    // Alice's TokenB balance = Expected amount of TokenB received (since Alice initially had no TokenB)
    const expectedAliceTokenB = expectedClearAmountOut;

    // Assert that Alice's TokenA balance is 0
    expect(aliceTokenADecryptedBalance).to.equal(0n);
    
    // Assert that Alice's TokenB balance matches the expected amount
    expect(aliceTokenBDecryptedBalance).to.equal(expectedAliceTokenB);
    console.log("Alice's balances verified.");

    // Verify that FHESwap's reserves are correctly updated after the swap
    console.log("Verifying FHESwap reserves update:");
    
    // Get FHESwap's encrypted reserve0
    const fHeSwapReserve0Encrypted = await fHeSwap.getEncryptedReserve0();
    
    // Decrypt FHESwap's reserve0
    const fHeSwapReserve0Decrypted = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      ethersjs.hexlify(fHeSwapReserve0Encrypted),
      fHeSwapAddress,
      owner // Owner can decrypt the reserves
    );
    console.log(`FHESwap reserve0 (decrypted): ${ethersjs.formatUnits(fHeSwapReserve0Decrypted, 6)}`);

    // Get FHESwap's encrypted reserve1
    const fHeSwapReserve1Encrypted = await fHeSwap.getEncryptedReserve1();
    
    // Decrypt FHESwap's reserve1
    const fHeSwapReserve1Decrypted = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      ethersjs.hexlify(fHeSwapReserve1Encrypted),
      fHeSwapAddress,
      owner
    );
    console.log(`FHESwap reserve1 (decrypted): ${ethersjs.formatUnits(fHeSwapReserve1Decrypted, 6)}`);

    // Calculate the expected final reserves for FHESwap
    // FHESwap's reserve0 = Initial reserve + Swapped-in TokenA amount
    const expectedFHeSwapReserve0 = initialReserveAmountA + ethersjs.parseUnits(swapAmount.toString(), 6);
   
    // FHESwap's reserve1 = Initial reserve - Swapped-out TokenB amount
    const expectedFHeSwapReserve1 = initialReserveAmountB - expectedClearAmountOut;

    // Assert that FHESwap's reserve0 matches the expected amount
    expect(fHeSwapReserve0Decrypted).to.equal(expectedFHeSwapReserve0);
   
    // Assert that FHESwap's reserve1 matches the expected amount
    expect(fHeSwapReserve1Decrypted).to.equal(expectedFHeSwapReserve1);
    console.log("FHESwap reserves verified.");
    console.log("--- Swap Test Passed ---\n");
  });
});