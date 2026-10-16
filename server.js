const net = require("net");
const fs = require("fs");
const path = require("path");

const PORT = 5500;
const DATA_DIR = path.join(__dirname, "Data");
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function toIST(timestampMs) {
    return new Date(timestampMs + IST_OFFSET_MS)
        .toISOString()
        .replace("Z", "+05:30");
}

function getDailyFile(timestampMs) {
    const d = new Date(timestampMs + IST_OFFSET_MS);
    const monthDir = path.join(
        DATA_DIR,
        `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`
    );

    fs.mkdirSync(monthDir, { recursive: true });
    return path.join(monthDir, `${String(d.getUTCDate()).padStart(2, "0")}.json`);
}

function saveRecords(recordsToSave) {
    if (!recordsToSave || recordsToSave.length === 0) return;
    const recordsByFile = new Map();

    for (const record of recordsToSave) {
        const filePath = getDailyFile(record.timestampMs);
        if (!recordsByFile.has(filePath)) {
            recordsByFile.set(filePath, []);
        }
        const { timestampMs, ...jsonRecord } = record;
        recordsByFile.get(filePath).push(jsonRecord);
    }

    for (const [filePath, batch] of recordsByFile.entries()) {
        let existingRecords = [];
        if (fs.existsSync(filePath)) {
            const existing = fs.readFileSync(filePath, "utf8").trim();
            if (existing) {
                existingRecords = JSON.parse(existing);
                if (!Array.isArray(existingRecords)) {
                    throw new Error(`Expected a JSON array in ${filePath}`);
                }
            }
        }
        existingRecords.push(...batch);
        const tempPath = `${filePath}.tmp`;
        fs.writeFileSync(tempPath, JSON.stringify(existingRecords, null, 2) + "\n");
        fs.renameSync(tempPath, filePath);
        console.log(`Saved ${batch.length} record(s): ${filePath}`);
    }
}

function saveRecord(record) {
    saveRecords([record]);
}

function need(buffer, offset, length, context) {
    if (offset < 0 || length < 0 || offset + length > buffer.length) {
        throw new Error(`Incomplete packet while reading ${context}`);
    }
}

function parseEightByteValue(buffer) {
    const value = buffer.readBigUInt64BE(0);
    return {
        value: value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString(),
        hex: buffer.toString("hex")
    };
}

function decodeIoElements(buffer, offset) {
    let pos = offset;
    const io = {};

    need(buffer, pos, 4, "IO event ID and total IO count");
    const eventId = buffer.readUInt16BE(pos);
    pos += 2;
    const totalIo = buffer.readUInt16BE(pos);
    pos += 2;

    function readFixedGroup(valueLength, label) {
        need(buffer, pos, 2, `${label} IO count`);
        const count = buffer.readUInt16BE(pos);
        pos += 2;

        for (let i = 0; i < count; i++) {
            need(buffer, pos, 2 + valueLength, `${label} IO element`);
            const id = buffer.readUInt16BE(pos);
            pos += 2;
            const valueBuffer = buffer.subarray(pos, pos + valueLength);
            pos += valueLength;

            if (valueLength === 8) {
                io[id] = parseEightByteValue(valueBuffer);
            } else {
                io[id] = valueBuffer.readUIntBE(0, valueLength);
            }
        }
    }

    readFixedGroup(1, "1-byte");
    readFixedGroup(2, "2-byte");
    readFixedGroup(4, "4-byte");
    readFixedGroup(8, "8-byte");

    need(buffer, pos, 2, "variable-length IO count");
    const countX = buffer.readUInt16BE(pos);
    pos += 2;

    for (let i = 0; i < countX; i++) {
        need(buffer, pos, 4, "variable-length IO header");
        const id = buffer.readUInt16BE(pos);
        pos += 2;
        const length = buffer.readUInt16BE(pos);
        pos += 2;

        need(buffer, pos, length, `variable-length IO value for ID ${id}`);
        const valueBuffer = buffer.subarray(pos, pos + length);
        pos += length;

        io[id] = {
            length,
            hex: valueBuffer.toString("hex"),
            utf8: valueBuffer.toString("utf8")
        };
    }

    return { eventId, totalIo, io, offset: pos };
}

function decodeRecord(buffer, offset) {
    let pos = offset;
    need(buffer, pos, 24, "timestamp, priority and GPS");

    const timestampMs = Number(buffer.readBigUInt64BE(pos));
    pos += 8;

    const priority = buffer.readUInt8(pos);
    pos += 1;

    const longitude = buffer.readInt32BE(pos) / 10000000;
    pos += 4;
    const latitude = buffer.readInt32BE(pos) / 10000000;
    pos += 4;
    const altitude = buffer.readInt16BE(pos);
    pos += 2;
    const angle = buffer.readUInt16BE(pos);
    pos += 2;
    const satellites = buffer.readUInt8(pos);
    pos += 1;
    const speed = buffer.readUInt16BE(pos);
    pos += 2;

    const parsedIo = decodeIoElements(buffer, pos);
    pos = parsedIo.offset;
    const io = parsedIo.io;

    // Helper to extract raw numeric value from primitive or 8-byte object
    const rawVal = (v) => {
        if (v === undefined || v === null) return undefined;
        if (typeof v === "object") {
            if ("value" in v) return Number(v.value);
            if ("utf8" in v) return v.utf8.trim();
            return v;
        }
        return Number(v);
    };

    // Helpers for signed integer conversion (two's complement)
    const toInt8 = (v) => { const n = rawVal(v); return n === undefined ? undefined : (n >= 0x80 ? n - 0x100 : n); };
    const toInt16 = (v) => { const n = rawVal(v); return n === undefined ? undefined : (n >= 0x8000 ? n - 0x10000 : n); };

    const known = {};

    // -------------------------------------------------------------
    // 1. PERMANENT I/O & HARDWARE SENSORS
    // -------------------------------------------------------------
    if (io[1] !== undefined) known.digitalInput1 = rawVal(io[1]);
    if (io[2] !== undefined) known.digitalInput2 = rawVal(io[2]);
    if (io[3] !== undefined) known.digitalInput3 = rawVal(io[3]);
    if (io[9] !== undefined) known.analogInput1 = rawVal(io[9]) * 0.001; // Volts
    if (io[6] !== undefined) known.analogInput2 = rawVal(io[6]) * 0.001; // Volts
    if (io[10] !== undefined) known.sdStatus = rawVal(io[10]);
    if (io[11] !== undefined) known.iccid1 = io[11].hex || String(io[11]);
    if (io[14] !== undefined) known.iccid2 = io[14].hex || String(io[14]);
    if (io[16] !== undefined) known.totalOdometer = rawVal(io[16]); // meters
    if (io[199] !== undefined) known.tripOdometer = rawVal(io[199]); // meters
    if (io[21] !== undefined) known.gsmSignal = rawVal(io[21]); // 1-5 scale
    if (io[24] !== undefined) known.gnssSpeed = rawVal(io[24]); // km/h
    if (io[66] !== undefined) known.externalVoltage = rawVal(io[66]) * 0.001; // Volts
    if (io[67] !== undefined) known.batteryVoltage = rawVal(io[67]) * 0.001; // Volts
    if (io[68] !== undefined) known.batteryCurrent = rawVal(io[68]) * 0.001; // Amperes
    if (io[69] !== undefined) known.gnssStatus = rawVal(io[69]); // 0=Off, 1=Fix, 2=No Fix, 3=Sleep
    if (io[80] !== undefined) known.dataMode = rawVal(io[80]); // 0=Home Stop, 1=Home Moving, etc.
    if (io[113] !== undefined) known.batteryLevel = rawVal(io[113]); // %
    if (io[179] !== undefined) known.digitalOutput1 = rawVal(io[179]);
    if (io[180] !== undefined) known.digitalOutput2 = rawVal(io[180]);
    if (io[181] !== undefined) known.pdop = rawVal(io[181]) * 0.1;
    if (io[182] !== undefined) known.hdop = rawVal(io[182]) * 0.1;
    if (io[200] !== undefined) known.sleepMode = rawVal(io[200]); // 0=None, 1=GPS, 2=Deep, 3=Online Deep, 4=Ultra
    if (io[205] !== undefined) known.gsmCellId = rawVal(io[205]);
    if (io[206] !== undefined) known.gsmAreaCode = rawVal(io[206]);
    if (io[237] !== undefined) known.networkType = rawVal(io[237]); // 1=GSM, 2=4G, 3=LTE-M, 4=NB-IoT
    if (io[239] !== undefined) known.ignition = rawVal(io[239]) === 1;
    if (io[240] !== undefined) known.movement = rawVal(io[240]) === 1;
    if (io[241] !== undefined) known.activeGsmOperator = rawVal(io[241]); // MCC+MNC code
    if (io[636] !== undefined) known.lteCellId = rawVal(io[636]);
    if (io[13201] !== undefined) known.pcbTemperature = toInt16(io[13201]) * 0.1; // °C

    // -------------------------------------------------------------
    // 2. EVENTUAL I/O & SECURITY ALERTS
    // -------------------------------------------------------------
    if (io[175] !== undefined) known.autoGeofence = rawVal(io[175]);
    if (io[236] !== undefined) known.alarm = rawVal(io[236]) === 1;
    if (io[243] !== undefined) known.greenDrivingDuration = rawVal(io[243]); // ms
    if (io[246] !== undefined) known.towing = rawVal(io[246]) === 1;
    if (io[247] !== undefined) known.crashDetection = rawVal(io[247]); // 1-6 crash states
    if (io[249] !== undefined) known.jamming = rawVal(io[249]) === 1;
    if (io[250] !== undefined) known.tripState = rawVal(io[250]) === 1 ? "start" : "stop";
    if (io[251] !== undefined) known.idling = rawVal(io[251]) === 1;
    if (io[252] !== undefined) known.unplugAlert = rawVal(io[252]) === 1; // 1 = UNPLUGGED FROM OBD!
    if (io[253] !== undefined) known.greenDrivingType = rawVal(io[253]); // 1=harsh accel, 2=harsh brake, 3=harsh cornering
    if (io[254] !== undefined) known.greenDrivingValue = rawVal(io[254]) * 0.01; // G
    if (io[255] !== undefined) known.overSpeeding = rawVal(io[255]); // km/h
    if (io[317] !== undefined) known.crashEventCounter = rawVal(io[317]);
    if (io[318] !== undefined) known.gnssJamming = rawVal(io[318]); // 0=healthy, 1=warning, 2=critical
    if (io[449] !== undefined) known.ignitionOnCounter = rawVal(io[449]); // seconds

    // -------------------------------------------------------------
    // 3. STANDARD OBD-II PARAMETERS
    // -------------------------------------------------------------
    // VIN (Vehicle Identification Number)
    if (io[256] !== undefined) {
        known.vin = io[256].utf8 ? io[256].utf8.trim() : String(io[256]);
    }
    // DTCs (Diagnostic Trouble Codes / Fault Codes)
    if (io[30] !== undefined) known.dtcCount = rawVal(io[30]);
    if (io[281] !== undefined) {
        known.faultCodes = io[281].utf8 ? io[281].utf8.trim() : String(io[281]);
    }

    if (io[31] !== undefined) known.engineLoad = rawVal(io[31]); // %
    if (io[32] !== undefined) known.coolantTemperature = toInt8(io[32]); // °C (signed)
    if (io[33] !== undefined) known.shortFuelTrim = toInt8(io[33]); // %
    if (io[34] !== undefined) known.fuelPressure = rawVal(io[34]); // kPa
    if (io[35] !== undefined) known.intakeMap = rawVal(io[35]); // kPa
    if (io[36] !== undefined) known.engineRpm = rawVal(io[36]); // RPM
    if (io[37] !== undefined) known.vehicleSpeed = rawVal(io[37]); // km/h (OBD speed)
    if (io[38] !== undefined) known.timingAdvance = toInt8(io[38]); // degrees
    if (io[39] !== undefined) known.intakeAirTemperature = toInt8(io[39]); // °C (signed)
    if (io[40] !== undefined) known.maf = rawVal(io[40]) * 0.01; // g/sec
    if (io[41] !== undefined) known.throttlePosition = rawVal(io[41]); // %
    if (io[42] !== undefined) known.engineRuntime = rawVal(io[42]); // seconds
    if (io[43] !== undefined) known.distanceMilOn = rawVal(io[43]); // km
    if (io[44] !== undefined) known.relFuelRailPressure = rawVal(io[44]) * 0.1; // kPa
    if (io[45] !== undefined) known.directFuelRailPressure = rawVal(io[45]) * 10; // kPa
    if (io[46] !== undefined) known.commandedEgr = rawVal(io[46]); // %
    if (io[47] !== undefined) known.egrError = toInt8(io[47]); // %
    if (io[48] !== undefined) known.fuelLevel = rawVal(io[48]); // %
    if (io[49] !== undefined) known.distanceSinceCodesCleared = rawVal(io[49]); // km
    if (io[50] !== undefined) known.barometricPressure = rawVal(io[50]); // kPa
    if (io[51] !== undefined) known.controlModuleVoltage = rawVal(io[51]) * 0.001; // Volts
    if (io[52] !== undefined) known.absoluteLoadValue = rawVal(io[52]); // %
    if (io[53] !== undefined) known.ambientAirTemperature = toInt8(io[53]); // °C (signed)
    if (io[54] !== undefined) known.timeRunWithMilOn = rawVal(io[54]); // min
    if (io[55] !== undefined) known.timeSinceCodesCleared = rawVal(io[55]); // min
    if (io[56] !== undefined) known.absFuelRailPressure = rawVal(io[56]) * 10; // kPa
    if (io[57] !== undefined) known.hybridBatteryPackLife = rawVal(io[57]); // %
    if (io[58] !== undefined) known.engineOilTemperature = rawVal(io[58]); // °C
    if (io[59] !== undefined) known.fuelInjectionTiming = toInt16(io[59]) * 0.01; // degrees
    if (io[60] !== undefined) known.fuelRate = rawVal(io[60]) * 0.01; // L/h
    if (io[759] !== undefined) known.fuelType = rawVal(io[759]); // 1=Gasoline, 4=Diesel, etc.
    if (io[1593] !== undefined) known.remainingDistance = rawVal(io[1593]); // km

    // -------------------------------------------------------------
    // 4. OBD OEM PARAMETERS (Cluster & Extended Vehicle Data)
    // -------------------------------------------------------------
    if (io[389] !== undefined) known.oemTotalMileage = rawVal(io[389]); // km (true vehicle dashboard odometer)
    if (io[390] !== undefined) known.oemFuelLevel = rawVal(io[390]) * 0.1; // Litres
    if (io[402] !== undefined) known.oemDistanceUntilService = rawVal(io[402]); // km
    if (io[410] !== undefined) known.oemBatteryChargeState = rawVal(io[410]); // 0=Not charging, 1=Charging
    if (io[411] !== undefined) known.oemBatteryChargeLevel = rawVal(io[411]); // %
    if (io[412] !== undefined) known.oemBatteryPowerConsumption = rawVal(io[412]); // kWh/100km
    if (io[755] !== undefined) known.oemRemainingDistance = rawVal(io[755]); // km
    if (io[1151] !== undefined) known.oemBatteryStateOfHealth = rawVal(io[1151]); // %
    if (io[1152] !== undefined) known.oemBatteryTemperature = toInt16(io[1152]); // °C
    if (io[1443] !== undefined) known.oemDistanceSinceRefuel = rawVal(io[1443]); // km
    if (io[1476] !== undefined) known.oemRemainingOilLife = rawVal(io[1476]); // %

    // -------------------------------------------------------------
    // 5. ELECTRIC VEHICLE (OEM EV) ELEMENTS
    // -------------------------------------------------------------
    if (io[1378] !== undefined) known.evHvBatteryMinCellVoltage = rawVal(io[1378]) * 0.01; // V
    if (io[1379] !== undefined) known.evHvBatteryMaxCellVoltage = rawVal(io[1379]) * 0.01; // V
    if (io[1380] !== undefined) known.evHvBatteryCurrent = rawVal(io[1380]) * 0.1; // A
    if (io[1381] !== undefined) known.evHvBatteryVoltage = rawVal(io[1381]) * 0.1; // V
    if (io[1382] !== undefined) known.evHvBatteryMaxEnergy = rawVal(io[1382]) * 0.01; // kWh
    if (io[1383] !== undefined) known.evHvBatteryMeasuredEnergy = rawVal(io[1383]) * 0.01; // kWh
    if (io[1386] !== undefined) known.evHvBatteryMinCellTemp = toInt16(io[1386]) * 0.1; // °C
    if (io[1387] !== undefined) known.evHvBatteryMaxCellTemp = toInt16(io[1387]) * 0.1; // °C
    if (io[1388] !== undefined) known.evHvBatteryLifetimePowerUse = rawVal(io[1388]); // kWh
    if (io[1389] !== undefined) known.evHvBatteryLifetimeChargePower = rawVal(io[1389]); // kWh
    if (io[1390] !== undefined) known.evFastChargeCount = rawVal(io[1390]) * 0.1;
    if (io[1391] !== undefined) known.evSlowChargeCount = rawVal(io[1391]) * 0.1;

    // -------------------------------------------------------------
    // 6. ELD (COMMERCIAL / HEAVY VEHICLE) ELEMENTS
    // -------------------------------------------------------------
    if (io[1176] !== undefined) known.eldMileage = rawVal(io[1176]); // km
    if (io[1177] !== undefined) known.eldEngineHours = rawVal(io[1177]); // hours
    if (io[1178] !== undefined) known.eldIgnition = rawVal(io[1178]);
    if (io[1179] !== undefined) known.eldParkingBrake = rawVal(io[1179]); // 0=Not set, 1=Set
    if (io[1180] !== undefined) known.eldTotalFuelUsed = rawVal(io[1180]); // Litres
    if (io[1181] !== undefined) known.eldIdleHours = rawVal(io[1181]); // hours
    if (io[1182] !== undefined) known.eldDtcCount = rawVal(io[1182]);
    if (io[1183] !== undefined) known.eldFuelLevel2 = rawVal(io[1183]); // %
    if (io[1184] !== undefined) known.eldBatteryVoltage = rawVal(io[1184]); // V
    if (io[1186] !== undefined) known.eldTripDistance = rawVal(io[1186]); // km
    if (io[1187] !== undefined) known.eldFuelEconomy = rawVal(io[1187]); // km/l
    if (io[1188] !== undefined) known.eldAmbientAirTemp = toInt16(io[1188]); // °C
    if (io[1189] !== undefined) known.eldEngineLoad = rawVal(io[1189]); // %
    if (io[1190] !== undefined) known.eldEngineThrottle = rawVal(io[1190]); // %
    if (io[1191] !== undefined) known.eldOilTemperature = toInt16(io[1191]); // °C
    if (io[1193] !== undefined) known.eldOilPressure = rawVal(io[1193]); // kPa
    if (io[1194] !== undefined) known.seatBeltStatus = rawVal(io[1194]) === 1 ? "buckled" : (rawVal(io[1194]) === 0 ? "unbuckled" : rawVal(io[1194]));
    if (io[1196] !== undefined) known.eldThrottlePedal = rawVal(io[1196]);
    if (io[1197] !== undefined) known.eldEngineCoolantLevel = rawVal(io[1197]); // %
    if (io[1198] !== undefined) known.eldEngineCoolantPressure = rawVal(io[1198]); // kPa
    if (io[1199] !== undefined) known.eldTransmissionOilTemp = toInt16(io[1199]); // °C
    if (io[1200] !== undefined) known.eldBrakePressure = rawVal(io[1200]); // kPa
    if (io[1201] !== undefined) known.eldBrakePedal = rawVal(io[1201]); // %
    if (io[1202] !== undefined) known.eldIgnitionSwitch = rawVal(io[1202]);
    if (io[1491] !== undefined) known.eldEngineMinutes = rawVal(io[1491]); // min

    return {
        timestampMs,
        timestamp: toIST(timestampMs),
        priority,
        gps: { latitude, longitude, altitude, angle, satellites, speed },
        ...known,
        eventId: parsedIo.eventId,
        totalIo: parsedIo.totalIo,
        rawIo: io,
        nextOffset: pos
    };
}

function decodePacket(packet, imei) {
    need(packet, 0, 10, "AVL packet header");

    const dataLength = packet.readUInt32BE(4);
    const codecId = packet.readUInt8(8);
    const recordCount = packet.readUInt8(9);

    if (codecId !== 0x8e) {
        throw new Error(`Unsupported codec: 0x${codecId.toString(16)}`);
    }

    if (packet.length !== 8 + dataLength + 4) {
        throw new Error("Packet length does not match declared data length");
    }

    let offset = 10;
    const records = [];

    for (let i = 0; i < recordCount; i++) {
        const decoded = decodeRecord(packet, offset);

        const record = {
            imei,
            codec: "Codec 8 Extended",
            codecId,
            timestamp: decoded.timestamp,
            timestampMs: decoded.timestampMs,
            priority: decoded.priority,
            gps: decoded.gps,
            eventId: decoded.eventId,
            totalIo: decoded.totalIo,
            rawIo: decoded.rawIo,
            rawData: {
                packetHex: packet.toString("hex"),
                packetLengthBytes: packet.length
            }
        };

        // Automatically copy all decoded telemetry fields into the record
        const internalFields = new Set([
            "timestampMs", "timestamp", "priority", "gps",
            "eventId", "totalIo", "rawIo", "rawData", "nextOffset"
        ]);
        for (const [key, value] of Object.entries(decoded)) {
            if (!internalFields.has(key) && value !== undefined) {
                record[key] = value;
            }
        }

        records.push(record);
        offset = decoded.nextOffset;
    }

    need(packet, offset, 1, "second record count");
    const secondRecordCount = packet.readUInt8(offset);

    if (secondRecordCount !== recordCount) {
        throw new Error(`Record count mismatch: ${recordCount} != ${secondRecordCount}`);
    }

    return { codec: "Codec 8 Extended", codecId, recordCount, records };
}

const server = net.createServer((socket) => {
    console.log(`Device connected: ${socket.remoteAddress}:${socket.remotePort}`);

    let imei = null;
    let buffer = Buffer.alloc(0);

    socket.on("data", (data) => {
        buffer = Buffer.concat([buffer, data]);

        if (!imei && buffer.length >= 2) {
            const imeiLength = buffer.readUInt16BE(0);

            if (imeiLength > 0 && imeiLength <= 32 && buffer.length >= 2 + imeiLength) {
                imei = buffer.subarray(2, 2 + imeiLength).toString("ascii");
                socket.write(Buffer.from([0x01]));
                buffer = buffer.subarray(2 + imeiLength);
                console.log(`Device accepted: ${imei}`);
            }
        }

        while (imei && buffer.length >= 12) {
            if (buffer.readUInt32BE(0) !== 0) {
                buffer = buffer.subarray(1);
                continue;
            }

            const dataLength = buffer.readUInt32BE(4);
            const packetLength = 8 + dataLength + 4;
            if (buffer.length < packetLength) break;

            const packet = buffer.subarray(0, packetLength);

            try {
                const decoded = decodePacket(packet, imei);

                for (const record of decoded.records) {
                    console.log(JSON.stringify(record, null, 2));
                }

                try {
                    saveRecords(decoded.records);
                } catch (error) {
                    console.error("File save error:", error.message);
                }

                const ack = Buffer.alloc(4);
                ack.writeUInt32BE(decoded.recordCount);
                socket.write(ack);
            } catch (error) {
                console.error("Decode error:", error.message);
                console.error("RAW PACKET HEX:", packet.toString("hex"));
            }

            buffer = buffer.subarray(packetLength);
        }
    });

    socket.on("close", () => {
        console.log(`Device disconnected: ${imei || "unknown"}`);
    });

    socket.on("error", (error) => {
        console.error("Socket error:", error.message);
    });
});

server.on("error", (error) => {
    console.error("Server error:", error);
});

server.listen(PORT, "0.0.0.0", () => {
    console.log(`FMC003 TCP server listening on port ${PORT}`);
    console.log(`Daily JSON files will be saved under ${DATA_DIR}/YYYY-MM/DD.json`);
});
