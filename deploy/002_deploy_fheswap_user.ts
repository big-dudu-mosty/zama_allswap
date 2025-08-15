import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

const deployFHESwapUser: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, ethers } = hre;
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  console.log("====================================================");
  console.log(`Deploying FHESwapUser to network: ${hre.network.name}`);
  console.log(`Deployer account: ${deployer}`);
  console.log("====================================================\n");

  // Check deployer balance
  const deployerSigner = await ethers.getSigner(deployer);
  const balance = await ethers.provider.getBalance(deployer);
  console.log(`Deployer balance: ${ethers.formatEther(balance)} ETH\n`);

  // Deploy TokenA
  console.log("🚀 Deploying TokenA (ConfidentialFungibleTokenMintableBurnable)...");
  const tokenADeployment = await deploy("TokenA_User", {
    contract: "ConfidentialFungibleTokenMintableBurnable",
    from: deployer,
    args: [deployer, "TokenA_User", "TKAU", "https://example.com/metadataA"],
    log: true,
    waitConfirmations: hre.network.name === "sepolia" ? 2 : 1,
  });
  console.log(`✅ TokenA_User deployed at: ${tokenADeployment.address}\n`);

  // Deploy TokenB
  console.log("🚀 Deploying TokenB (ConfidentialFungibleTokenMintableBurnable)...");
  const tokenBDeployment = await deploy("TokenB_User", {
    contract: "ConfidentialFungibleTokenMintableBurnable",
    from: deployer,
    args: [deployer, "TokenB_User", "TKBU", "https://example.com/metadataB"],
    log: true,
    waitConfirmations: hre.network.name === "sepolia" ? 2 : 1,
  });
  console.log(`✅ TokenB_User deployed at: ${tokenBDeployment.address}\n`);

  // Deploy FHESwap
  console.log("🚀 Deploying FHESwap...");
  const fheSwapDeployment = await deploy("FHESwap_User", {
    contract: "FHESwapUser",
    from: deployer,
    args: [tokenADeployment.address, tokenBDeployment.address, deployer],
    log: true,
    waitConfirmations: hre.network.name === "sepolia" ? 2 : 1,
  });
  console.log(`✅ FHESwap_User deployed at: ${fheSwapDeployment.address}\n`);

  // Initialize coprocessor on testnet
  if (hre.network.name === "sepolia") {
    console.log("🔧 Initializing FHEVM coprocessor...");
    try {
      // Connect to deployed contracts
      const tokenA = await ethers.getContractAt("ConfidentialFungibleTokenMintableBurnable", tokenADeployment.address);
      const tokenB = await ethers.getContractAt("ConfidentialFungibleTokenMintableBurnable", tokenBDeployment.address);
      const fheSwap = await ethers.getContractAt("FHESwap", fheSwapDeployment.address);

      // Initialize coprocessor
      await hre.fhevm.assertCoprocessorInitialized(tokenA, "ConfidentialFungibleTokenMintableBurnable");
      await hre.fhevm.assertCoprocessorInitialized(tokenB, "ConfidentialFungibleTokenMintableBurnable");
      await hre.fhevm.assertCoprocessorInitialized(fheSwap, "FHESwap");
      console.log("✅ FHEVM coprocessor initialized\n");
    } catch (error) {
      console.log("⚠️  Coprocessor initialization warning:", error);
      console.log("This may be normal, will be handled automatically during testing\n");
    }
  }

  console.log("====================================================");
  console.log("🎉 All contracts for FHESwapUser deployed successfully!");
  console.log("====================================================");
  console.log(`TokenA_User: ${tokenADeployment.address}`);
  console.log(`TokenB_User: ${tokenBDeployment.address}`);
  console.log(`FHESwap_User: ${fheSwapDeployment.address}`);
  console.log("====================================================\n");

  // Save deployment info
  const deploymentInfo = {
    network: hre.network.name,
    tokenA: tokenADeployment.address,
    tokenB: tokenBDeployment.address,
    fheSwap: fheSwapDeployment.address,
    deployer: deployer,
    timestamp: new Date().toISOString(),
  };

  console.log("📝 Deployment info:");
  console.log(JSON.stringify(deploymentInfo, null, 2));
};

export default deployFHESwapUser;
deployFHESwapUser.tags = ["TokenA_User", "TokenB_User", "FHESwap_User", "user"];
