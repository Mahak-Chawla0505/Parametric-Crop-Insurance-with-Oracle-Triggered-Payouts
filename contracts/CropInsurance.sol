// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.34;

import "./IWeatherOracle.sol";

contract CropInsurance {
    // ---------- Data ----------
    enum Status { Active, Paid, Expired }

    struct Policy {
        address farmer;
        uint256 regionId;
        uint256 thresholdMm;   // pay out if rainfall is below this
        uint256 windowStart;   // unix time, fixed forever
        uint256 windowEnd;     // unix time, fixed forever
        uint256 coverage;      // payout amount in wei
        uint256 premium;       // what the farmer paid in wei
        Status status;
    }

    IWeatherOracle public immutable oracle;

    uint256 public constant PREMIUM_RATE_PERCENT = 5;
    uint256 public constant MIN_WINDOW = 30 days;
    uint256 public constant MAX_WINDOW = 180 days;

    Policy[] public policies;
    uint256 public totalLiability; // sum of all payouts we have promised

    // ---------- Events ----------
    event PolicyCreated(
        uint256 indexed policyId,
        address indexed farmer,
        uint256 regionId,
        uint256 coverage,
        uint256 premium
    );
    event PoolFunded(address indexed funder, uint256 amount);
    
    event PolicySettled(
      uint256 indexed policyId,
      address indexed farmer,
      bool paidOut,
      uint256 rainfallMm
    );

    // ---------- Setup ----------
    constructor(address oracleAddress) {
        oracle = IWeatherOracle(oracleAddress);
    }

    // ---------- Fund the pool ----------
    function fundPool() external payable {
      require(msg.value > 0, "Send some ETH");
      emit PoolFunded(msg.sender, msg.value);
    }

    // ---------- Buy a policy ----------
    function createPolicy(
        uint256 regionId,
        uint256 thresholdMm,
        uint256 windowStart,
        uint256 windowEnd,
        uint256 coverage
    ) external payable returns (uint256 policyId) {
        require(coverage > 0, "Coverage must be positive");
        require(thresholdMm > 0, "Threshold must be positive");
        require(windowStart > block.timestamp, "Window must start in the future");
        require(windowEnd > windowStart, "Window end must be after start");
        uint256 duration = windowEnd - windowStart;
        require(duration >= MIN_WINDOW && duration <= MAX_WINDOW, "Window length not allowed");

        uint256 premium = (coverage * PREMIUM_RATE_PERCENT) / 100;
        require(msg.value == premium, "Send the exact premium");

        // Can the pool cover this promise on top of the existing ones?
        require(
            address(this).balance >= totalLiability + coverage,
            "Pool cannot cover this policy"
        );

        totalLiability += coverage;

        policies.push(Policy({
            farmer: msg.sender,
            regionId: regionId,
            thresholdMm: thresholdMm,
            windowStart: windowStart,
            windowEnd: windowEnd,
            coverage: coverage,
            premium: premium,
            status: Status.Active
        }));

        policyId = policies.length - 1;
        emit PolicyCreated(policyId, msg.sender, regionId, coverage, premium);
    }

    // ---------- Settle a policy (anyone can call this) ----------
    function settle(uint256 policyId) external {
        require(policyId < policies.length, "Policy does not exist");
        Policy storage p = policies[policyId];

        require(p.status == Status.Active, "Already settled");
        require(block.timestamp > p.windowEnd, "Window has not ended");

        (uint256 rainfallMm, bool isReady) =
            oracle.getRainfall(p.regionId, p.windowStart, p.windowEnd);
        require(isReady, "Rainfall data not ready yet");

        // The promise is finished either way, so release it first.
        totalLiability -= p.coverage;

        if (rainfallMm < p.thresholdMm) {
            p.status = Status.Paid;
            (bool ok, ) = p.farmer.call{value: p.coverage}("");
            require(ok, "Payout failed");
            emit PolicySettled(policyId, p.farmer, true, rainfallMm);
        } else {
            p.status = Status.Expired;
            emit PolicySettled(policyId, p.farmer, false, rainfallMm);
        }
    }
}