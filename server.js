// --- CALIBRATED RANGE MULTIPLIERS ---
        // 1. Moderate speed penalty starting at 58 mph (max +18% at 75mph)
        let speedPenalty = 0.0;
        if (speedMph > 58) {
            speedPenalty = Math.min(0.18, ((speedMph - 58) / 17) * 0.18); 
        }
        let hwyPenalty = (hwyPercent / 100) * 0.10; 
        let styleMultiplier = 1.0 + speedPenalty + hwyPenalty;

        // 2. Calibrated global multiplier (1.05x instead of 1.15x)
        let baseWeightedMiles = (milesOnCurrentCharge * styleMultiplier) * 1.05;

        if (speedMph > 2) {
            if (lastKnownAltitudeMeters !== null) {
                let deltaMeters = rawAltitudeMeters - lastKnownAltitudeMeters;
                let deltaFeet = deltaMeters * 3.28084;
                if (deltaFeet > 2.0) { 
                    // Calibrated hill weight (0.006 instead of 0.010)
                    let climbWeight = deltaFeet * 0.006; 
                    accumulatedTerrainAdjustmentMiles += climbWeight;
                }
            }
            lastKnownAltitudeMeters = rawAltitudeMeters;

            if (motorTorque <= 0) {
                let regenCreditPerSecond = (speedMph / 3600) * 0.25; 
                accumulatedTerrainAdjustmentMiles -= regenCreditPerSecond;
            }
        } else {
            lastKnownAltitudeMeters = rawAltitudeMeters;
        }
