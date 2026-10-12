import { network } from "hardhat";

const { ethers } = await network.create();

const day = 24 * 60 * 60;
const eth = (n: bigint) => ethers.formatEther(n) + " ETH";

async function skipTo(timestamp: number) {
  const latest = (await ethers.provider.getBlock("latest"))!.timestamp;
  await ethers.provider.send("evm_increaseTime", [timestamp - latest + 1]);
  await ethers.provider.send("evm_mine", []);
}

async function main() {
  const [insurer, farmer] = await ethers.getSigners();

  console.log("1. Deploying the mock oracle and the insurance contract...");
  const oracle = await ethers.deployContract("MockWeatherOracle");
  const insurance = await ethers.deployContract("CropInsurance", [
    await oracle.getAddress(),
  ]);
  const poolAddress = await insurance.getAddress();

  console.log("2. Insurer funds the pool with 10 ETH");
  await insurance.connect(insurer).fundPool({ value: ethers.parseEther("10") });

  const now = (await ethers.provider.getBlock("latest"))!.timestamp;
  const start = now + day;
  const end = start + 90 * day;
  const coverage = ethers.parseEther("1");
  const premium = ethers.parseEther("0.05");

  console.log("3. Farmer buys a 90-day policy: pays 0.05 ETH, covered for 1 ETH");
  console.log("   Pays out if rainfall in the window is below 300 mm");
  const farmerBefore = await ethers.provider.getBalance(farmer.address);
  await insurance.connect(farmer).createPolicy(
    1n, 300n, start, end, coverage, { value: premium },
  );
  console.log("   Pool balance:", eth(await ethers.provider.getBalance(poolAddress)));
  console.log("   Total promised (liability):", eth(await insurance.totalLiability()));

  console.log("4. 90 days pass... the oracle reports only 120 mm of rain (drought)");
  await oracle.setRainfall(1n, start, end, 120n);
  await skipTo(end);

  console.log("5. Anyone (here, the insurer) calls settle(): no claim form, no adjuster");
  await insurance.connect(insurer).settle(0n);

  const policy = await insurance.policies(0n);
  const farmerAfter = await ethers.provider.getBalance(farmer.address);
  console.log("6. Result:");
  console.log("   Policy status:", ["Active", "Paid", "Expired"][Number(policy.status)]);
  console.log("   Farmer net gain:", eth(farmerAfter - farmerBefore), "(1 ETH payout minus 0.05 premium and gas)");
  console.log("   Pool balance:", eth(await ethers.provider.getBalance(poolAddress)));
  console.log("   Total promised (liability):", eth(await insurance.totalLiability()));
}

await main();