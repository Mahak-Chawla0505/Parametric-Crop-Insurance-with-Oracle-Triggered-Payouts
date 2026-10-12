// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.34;

import "./IWeatherOracle.sol";

// FOR TESTING ONLY: anyone can set the rainfall.
contract MockWeatherOracle is IWeatherOracle {
    struct Report {
        uint256 rainfallMm;
        bool isReady;
    }

    mapping(bytes32 => Report) private reports;

    function setRainfall(
        uint256 regionId,
        uint256 windowStart,
        uint256 windowEnd,
        uint256 rainfallMm
    ) external {
        bytes32 key = keccak256(abi.encode(regionId, windowStart, windowEnd));
        reports[key] = Report(rainfallMm, true);
    }

    function getRainfall(
        uint256 regionId,
        uint256 windowStart,
        uint256 windowEnd
    ) external view override returns (uint256 rainfallMm, bool isReady) {
        bytes32 key = keccak256(abi.encode(regionId, windowStart, windowEnd));
        Report memory r = reports[key];
        return (r.rainfallMm, r.isReady);
    }
}