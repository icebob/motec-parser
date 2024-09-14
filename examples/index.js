const fs = require('fs').promises;
const { inspect } = require('util');
const path = require('path');

const { rimraf } = require('rimraf');
const Parser = require('..');


//const TEST_FILENAME = "test-files/GO2 M4 GT3 SIL E Q02 MOTEC.ldx";
const TEST_FILENAME = "test-files/Spa-bmw_m4_gt3-5-2024.09.10-18.59.58.ldx";

async function start() {

    console.log("Loading file...", TEST_FILENAME);

    await rimraf("parsed");
    await fs.mkdir("parsed");

    const parser = new Parser();
    await parser.load(TEST_FILENAME);

    //console.log(inspect(parsed, { depth: null, colors: true }));
    fs.writeFile("parsed/data.json", JSON.stringify(parser.data, null, 2));
    console.log("Parsed and saved to parsed/data.json");

    fs.mkdir("parsed/channels");
    for (let channel of parser.data.channels) {
        fs.writeFile(`parsed/channels/${channel.name}.txt`, channel.data.join("\r\n"));
    }

    const CHANNELS = ["SPEED", "BRAKE", "STEERANGLE", "THROTTLE", "GEAR"];

    for (let lap = 1; lap <= parser.data.totalLaps; lap++) {
        console.log(`Lap ${lap} data saving...`);

        for (let channel of CHANNELS) {
            let lapData = parser.getChannelData(lap, channel);
            if (channel === "SPEED") {
                lapData = lapData.map(speed => speed * 3.6);
            }
            fs.writeFile(`parsed/lap-${lap}-${channel}.txt`, lapData.join("\r\n"));
        }
    }
}


start();