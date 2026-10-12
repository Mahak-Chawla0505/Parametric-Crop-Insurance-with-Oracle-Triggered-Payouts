// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.34;

interface IWeatherOracle {
    // Returns total rainfall (in mm) for a region during a period,
    // and whether the data is ready yet.
    function getRainfall(
        uint256 regionId,
        uint256 windowStart,
        uint256 windowEnd
    ) external view returns (uint256 rainfallMm, bool isReady);
}