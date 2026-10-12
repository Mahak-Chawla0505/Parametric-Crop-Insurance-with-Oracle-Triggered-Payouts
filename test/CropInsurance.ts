import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.create();

async function setup() {
  const [insurer, farmer] = await ethers.getSigners();
  const oracle = await ethers.deployContract("MockWeatherOracle");
  const insurance = await ethers.deployContract("CropInsurance", [
    await oracle.getAddress(),
  ]);
  const now = (await ethers.provider.getBlock("latest"))!.timestamp;
  const day = 24 * 60 * 60;
  return { insurer, farmer, oracle, insurance, now, day };
}

describe("CropInsurance", function () {
  it("fundPool adds money and emits PoolFunded", async function () {
    const { insurer, insurance } = await setup();
    const amount = ethers.parseEther("10");

    await expect(insurance.connect(insurer).fundPool({ value: amount }))
      .to.emit(insurance, "PoolFunded")
      .withArgs(insurer.address, amount);

    expect(await ethers.provider.getBalance(await insurance.getAddress()))
      .to.equal(amount);
  });

  it("farmer can buy a policy when the pool is funded", async function () {
    const { insurer, farmer, insurance, now, day } = await setup();
    await insurance.connect(insurer).fundPool({ value: ethers.parseEther("10") });

    const coverage = ethers.parseEther("1");
    const premium = ethers.parseEther("0.05"); // 5%

    await expect(
      insurance.connect(farmer).createPolicy(
        1n, 300n, now + day, now + day + 90 * day, coverage,
        { value: premium },
      ),
    )
      .to.emit(insurance, "PolicyCreated")
      .withArgs(0n, farmer.address, 1n, coverage, premium);

    expect(await insurance.totalLiability()).to.equal(coverage);
  });

  it("rejects a policy when the pool cannot cover it", async function () {
    const { farmer, insurance, now, day } = await setup(); // pool is empty

    await expect(
      insurance.connect(farmer).createPolicy(
        1n, 300n, now + day, now + day + 90 * day, ethers.parseEther("1"),
        { value: ethers.parseEther("0.05") },
      ),
    ).to.be.revertedWith("Pool cannot cover this policy");
  });
});

async function skipPast(timestamp: number) {
  const latest = (await ethers.provider.getBlock("latest"))!.timestamp;
  await ethers.provider.send("evm_increaseTime", [timestamp - latest + 1]);
  await ethers.provider.send("evm_mine", []);
}

describe("CropInsurance settle", function () {
  async function boughtPolicy() {
    const ctx = await setup();
    const { insurer, farmer, insurance, now, day } = ctx;
    const start = now + day;
    const end = start + 90 * day;

    await insurance.connect(insurer).fundPool({ value: ethers.parseEther("10") });
    await insurance.connect(farmer).createPolicy(
      1n, 300n, start, end, ethers.parseEther("1"),
      { value: ethers.parseEther("0.05") },
    );
    return { ...ctx, start, end };
  }

  it("pays the farmer when rainfall is below the threshold (drought)", async function () {
    const { insurer, farmer, oracle, insurance, start, end } = await boughtPolicy();
    await oracle.setRainfall(1n, start, end, 100n); // 100 mm < 300 mm
    await skipPast(end);

    // The insurer settles, not the farmer: anyone can.
    await expect(insurance.connect(insurer).settle(0n))
      .to.emit(insurance, "PolicySettled")
      .withArgs(0n, farmer.address, true, 100n);

    expect((await insurance.policies(0n)).status).to.equal(1n); // Paid
    expect(await insurance.totalLiability()).to.equal(0n);
    expect(await ethers.provider.getBalance(await insurance.getAddress()))
      .to.equal(ethers.parseEther("9.05")); // 10 + 0.05 premium - 1 payout
  });

  it("pays nothing when rainfall is enough", async function () {
    const { oracle, insurance, start, end, farmer } = await boughtPolicy();
    await oracle.setRainfall(1n, start, end, 500n); // 500 mm >= 300 mm
    await skipPast(end);

    await expect(insurance.settle(0n))
      .to.emit(insurance, "PolicySettled")
      .withArgs(0n, farmer.address, false, 500n);

    expect((await insurance.policies(0n)).status).to.equal(2n); // Expired
    expect(await ethers.provider.getBalance(await insurance.getAddress()))
      .to.equal(ethers.parseEther("10.05"));
  });

  it("rejects settling before the window ends", async function () {
    const { insurance } = await boughtPolicy();
    await expect(insurance.settle(0n)).to.be.revertedWith("Window has not ended");
  });

  it("rejects settling twice", async function () {
    const { oracle, insurance, start, end } = await boughtPolicy();
    await oracle.setRainfall(1n, start, end, 100n);
    await skipPast(end);
    await insurance.settle(0n);

    await expect(insurance.settle(0n)).to.be.revertedWith("Already settled");
  });

  it("rejects settling when the oracle has no data yet", async function () {
    const { insurance, end } = await boughtPolicy();
    await skipPast(end); // no setRainfall call

    await expect(insurance.settle(0n))
      .to.be.revertedWith("Rainfall data not ready yet");
  });
});

describe("CropInsurance safety rules", function () {
  it("stops selling policies once the pool is fully promised", async function () {
    const { insurer, farmer, insurance, now, day } = await setup();
    const start = now + day;
    const end = start + 90 * day;

    // Pool holds only 1.5 ETH, so it can back one 1-ETH policy, not two.
    await insurance.connect(insurer).fundPool({ value: ethers.parseEther("1.5") });

    await insurance.connect(farmer).createPolicy(
      1n, 300n, start, end, ethers.parseEther("1"),
      { value: ethers.parseEther("0.05") },
    ); // first one is fine

    await expect(
      insurance.connect(farmer).createPolicy(
        1n, 300n, start, end, ethers.parseEther("1"),
        { value: ethers.parseEther("0.05") },
      ),
    ).to.be.revertedWith("Pool cannot cover this policy");
  });

  it("rejects the wrong premium", async function () {
    const { insurer, farmer, insurance, now, day } = await setup();
    await insurance.connect(insurer).fundPool({ value: ethers.parseEther("10") });

    await expect(
      insurance.connect(farmer).createPolicy(
        1n, 300n, now + day, now + day + 90 * day, ethers.parseEther("1"),
        { value: ethers.parseEther("0.01") }, // should be 0.05
      ),
    ).to.be.revertedWith("Send the exact premium");
  });

  it("rejects a window that is too short", async function () {
    const { insurer, farmer, insurance, now, day } = await setup();
    await insurance.connect(insurer).fundPool({ value: ethers.parseEther("10") });

    await expect(
      insurance.connect(farmer).createPolicy(
        1n, 300n, now + day, now + day + 10 * day, ethers.parseEther("1"),
        { value: ethers.parseEther("0.05") },
      ),
    ).to.be.revertedWith("Window length not allowed");
  });

  it("rejects a window that starts in the past", async function () {
    const { insurer, farmer, insurance, now, day } = await setup();
    await insurance.connect(insurer).fundPool({ value: ethers.parseEther("10") });

    await expect(
      insurance.connect(farmer).createPolicy(
        1n, 300n, now - day, now + 90 * day, ethers.parseEther("1"),
        { value: ethers.parseEther("0.05") },
      ),
    ).to.be.revertedWith("Window must start in the future");
  });
});