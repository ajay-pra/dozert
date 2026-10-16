const express = require("express");
const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");

const app = express();
const PORT = Number(process.env.PORT || 1234);
const HOST = "0.0.0.0";
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.resolve(__dirname, "..", "Data");
const PUBLIC_DIR = path.join(__dirname, "public");

app.disable("x-powered-by");
app.use(express.static(PUBLIC_DIR, { extensions: ["html"] }));

function validMonth(value) {
    return typeof value === "string" && /^\d{4}-\d{2}$/.test(value);
}
function validDate(value) {
    return typeof value === "string" && /^\d{2}$/.test(value);
}
function monthDir(month) {
    if (!validMonth(month)) throw new Error("Invalid month. Expected YYYY-MM.");
    return path.join(DATA_DIR, month);
}
function dateFile(month, day) {
    if (!validDate(day)) throw new Error("Invalid day. Expected DD.");
    const file = path.resolve(monthDir(month), `${day}.json`);
    const expectedParent = path.resolve(monthDir(month));
    if (path.dirname(file) !== expectedParent) throw new Error("Invalid path.");
    return file;
}
function readJsonFile(file) {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
    const content = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed)) throw new Error("Daily JSON file must contain an array.");
    return parsed;
}
function listMonths() {
    if (!fs.existsSync(DATA_DIR)) return [];
    return fs.readdirSync(DATA_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory() && /^\d{4}-\d{2}$/.test(d.name))
        .map(d => d.name).sort().reverse();
}
function listDates(month) {
    const dir = monthDir(month);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true })
        .filter(d => d.isFile() && /^\d{2}\.json$/.test(d.name))
        .map(d => d.name.slice(0, 2)).sort().reverse();
}
function safeError(res, err) {
    console.error(err);
    res.status(500).json({ error: "Could not process the requested data file." });
}
function flattenRecord(r) {
    const gps = r.gps || {};
    const rawIo = r.rawIo || {};
    const vin = r.vin ?? (rawIo[256]?.utf8?.trim() || "");

    const row = {
        imei: r.imei ?? "",
        vin: vin,
        timestamp: r.timestamp ?? "",
        latitude: gps.latitude ?? r.latitude ?? "",
        longitude: gps.longitude ?? r.longitude ?? "",
        speed: gps.speed ?? r.speed ?? "",
        altitude: gps.altitude ?? r.altitude ?? "",
        angle: gps.angle ?? r.angle ?? "",
        satellites: gps.satellites ?? r.satellites ?? "",
        ignition: r.ignition ?? (rawIo[239] !== undefined ? rawIo[239] === 1 : ""),
        movement: r.movement ?? (rawIo[240] !== undefined ? rawIo[240] === 1 : ""),
        unplugAlert: r.unplugAlert ?? (rawIo[252] !== undefined ? rawIo[252] === 1 : ""),
        vehicleSpeed: r.vehicleSpeed ?? (rawIo[37] ?? ""),
        engineRpm: r.engineRpm ?? (rawIo[36] ?? ""),
        coolantTemperature: r.coolantTemperature ?? (rawIo[32] !== undefined ? (rawIo[32] >= 128 ? rawIo[32] - 256 : rawIo[32]) : ""),
        fuelLevel: r.fuelLevel ?? (rawIo[48] ?? ""),
        engineLoad: r.engineLoad ?? (rawIo[31] ?? ""),
        throttlePosition: r.throttlePosition ?? (rawIo[41] ?? ""),
        dtcCount: r.dtcCount ?? (rawIo[30] ?? ""),
        faultCodes: r.faultCodes ?? (rawIo[281]?.utf8?.trim() || ""),
        externalVoltage: r.externalVoltage ?? (rawIo[66] ? Number(rawIo[66]) / 1000 : ""),
        batteryVoltage: r.batteryVoltage ?? (rawIo[67] ? Number(rawIo[67]) / 1000 : ""),
        batteryCurrent: r.batteryCurrent ?? (rawIo[68] ? Number(rawIo[68]) / 1000 : ""),
        totalOdometer: r.totalOdometer ?? (rawIo[16] ?? ""),
        oemTotalMileage: r.oemTotalMileage ?? (rawIo[389] ?? ""),
        gsmSignal: r.gsmSignal ?? (rawIo[21] ?? ""),
        activeGsmOperator: r.activeGsmOperator ?? (rawIo[241] ?? ""),
        gnssStatus: r.gnssStatus ?? (rawIo[69] ?? ""),
        pdop: r.pdop ?? (rawIo[181] ? Number(rawIo[181]) / 10 : ""),
        hdop: r.hdop ?? (rawIo[182] ? Number(rawIo[182]) / 10 : ""),
        sleepMode: r.sleepMode ?? (rawIo[200] ?? ""),
        priority: r.priority ?? "",
        codec: r.codec ?? "",
        eventId: r.eventId ?? "",
        totalIo: r.totalIo ?? ""
    };

    // Add any other top-level fields without overwriting standard columns.
    for (const [key, value] of Object.entries(r)) {
        if (!(key in row) && !["gps", "rawIo", "rawData", "timestampMs", "codecId"].includes(key)) {
            row[key] = value && typeof value === "object" ? JSON.stringify(value) : value;
        }
    }

    // Place heavy diagnostic hex and raw IO at the very end
    row.rawIo = JSON.stringify(rawIo);
    row.rawDataPacketHex = r.rawData?.packetHex ?? "";

    return row;
}
function workbookFromRecords(records, sheetName) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "FMC003 Dashboard";
    workbook.created = new Date();
    const rows = records.map(flattenRecord);
    const keys = [...new Set(rows.flatMap(r => Object.keys(r)))];
    const sheet = workbook.addWorksheet(sheetName.slice(0, 31) || "Records");
    sheet.columns = keys.map(key => ({
        header: key,
        key,
        width: Math.min(45, Math.max(14, key.length + 2))
    }));
    for (const row of rows) sheet.addRow(row);
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).eachCell(cell => {
        cell.alignment = { vertical: "middle", wrapText: true };
    });
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    sheet.autoFilter = { from: "A1", to: `${sheet.getColumn(keys.length).letter}1` };
    return workbook;
}

app.get("/api/months", (req, res) => {
    res.json({ months: listMonths() });
});

app.get("/api/dates", (req, res) => {
    try {
        const month = String(req.query.month || "");
        res.json({ month, dates: listDates(month) });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.get("/api/data", (req, res) => {
    try {
        const month = String(req.query.month || "");
        const day = String(req.query.day || "");
        const file = dateFile(month, day);
        const records = readJsonFile(file);
        if (records === null) return res.status(404).json({ error: "No JSON file exists for that date." });
        res.json({ month, day, count: records.length, records });
    } catch (err) {
        if (err instanceof SyntaxError) return res.status(500).json({ error: "The daily JSON file contains invalid JSON." });
        safeError(res, err);
    }
});

app.get("/download/json", (req, res) => {
    try {
        const file = dateFile(String(req.query.month || ""), String(req.query.day || ""));
        if (!fs.existsSync(file)) return res.status(404).send("No JSON file exists for that date.");
        // Validate JSON before serving it.
        readJsonFile(file);
        res.download(file, `${req.query.month}-${req.query.day}.json`);
    } catch (err) {
        res.status(400).send("Invalid month or date.");
    }
});

app.get("/download/excel", async (req, res) => {
    try {
        const scope = String(req.query.scope || "date");
        const month = String(req.query.month || "");
        let records = [];
        let filename = "";
        if (!validMonth(month)) return res.status(400).send("Invalid month.");

        if (scope === "date") {
            const day = String(req.query.day || "");
            const file = dateFile(month, day);
            const dailyRecords = readJsonFile(file);
            if (dailyRecords === null) return res.status(404).send("No JSON file exists for that date.");
            records = dailyRecords;
            filename = `FMC003-${month}-${day}.xlsx`;
        } else if (scope === "month") {
            for (const day of listDates(month).sort()) {
                const dailyRecords = readJsonFile(dateFile(month, day));
                if (dailyRecords) records.push(...dailyRecords);
            }
            filename = `FMC003-${month}.xlsx`;
        } else {
            return res.status(400).send("Scope must be date or month.");
        }

        const workbook = workbookFromRecords(records, scope === "month" ? month : `${month}-${req.query.day || ""}`);
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        await workbook.xlsx.write(res);
        res.end();
    } catch (err) {
        safeError(res, err);
    }
});

app.get("/health", (req, res) => res.json({ status: "ok", port: PORT, dataDirectory: DATA_DIR }));

app.listen(PORT, HOST, () => {
    console.log(`FMC003 dashboard listening at http://127.0.0.1:${PORT}`);
    console.log(`Reading daily JSON files from: ${DATA_DIR}`);
    console.log("Keep the tracker TCP server on its separate port 5500.");
});
