const fs = require('fs').promises;
const { inspect } = require('util');
const path = require('path');
const struct = require('python-struct');

const TEST_FILENAME = "test-files/GO2 M4 GT3 SIL E Q02 MOTEC.ld";

async function readLdFile(filePath) {
    const buf = await fs.readFile(filePath);

    const header = readHeader(buf);
    
    let event;
    if (header.event_ptr !== 0) {
        event = readEvent(buf, header.event_ptr);

        if (event.venue_ptr !== 0) {
            event.venue = readVenue(buf, event.venue_ptr);

            if (event.venue.vehicle_ptr !== 0) {
                event.venue.vehicle = readVehicle(buf, event.venue.vehicle_ptr);
            }
        }
    }

    let channels = [];
    if (header.chann_meta_ptr !== 0) {
        let ptr = header.chann_meta_ptr;
        while (true) {
            const ch = readChannel(buf, ptr);

            if (ch.data_ptr !== 0) {
                ch.data = readChannelData(ch, buf);

                await fs.writeFile(`parsed/data-${ch.name}.txt`, ch.data.join("\r\n"));
            }

            channels.push(ch);
            if (ch.next_ptr === 0) {
                break;
            }
            ptr = ch.next_ptr;
        }
    }

    return { header, event, channels };
}

function readHeader(buf) {
    const fmt = '<' + 
    "I4x" +     // ldmarker
    "II" +      // chann_meta_ptr chann_data_ptr
    "20x" +     // ?
    "I" +       // event_ptr
    "24x" +     // ?
    "HHH" +     // unknown static (?) numbers
    "I" +       // device serial
    "8s" +      // device type
    "H" +       // device version
    "H" +       // unknown static (?) number
    "I" +       // num_channs
    "4x" +      // ?
    "16s" +     // date
    "16x" +     // ?
    "16s" +     // time
    "16x" +     // ?
    "64s" +     // driver
    "64s" +     // vehicleid
    "64x" +     // ?
    "64s" +     // venue
    "64x" +     // ?
    "1024x" +   // ?
    "I" +       // enable "pro logging" (some magic number?)
    "2x" +     // ?
    "64s" +     // session
    "64s" +     // short comment
    "126x";    // ?


    const head = struct.unpack(fmt, buf);    

    return {
        ldmarker: head[0],
        chann_meta_ptr: head[1],
        chann_data_ptr: head[2],
        event_ptr: head[3],
        device_serial: head[6],
        device_type: head[7],
        device_version: head[8],
        num_channs: head[11],
        date: head[12],
        time: head[14],
        driver: head[16],
        vehicleid: head[17],
        venue: head[18],
        pro_logging: head[27],
        session: head[28],
        short_comment: head[29]
    };
}

function readChannel(buf, offset) {
    fmt = '<' +
        "IIII" +    // prev_addr next_addr data_ptr n_data
        "H" +       // some counter?
        "HHH" +     // datatype datatype rec_freq
        "hhhh" +    // shift mul scale dec_places
        "32s" +     // name
        "8s" +      // short name
        "12s" +     // unit
        "40x";     // ? (40 bytes for ACC, 32 bytes for acti)
        
    const p = struct.unpack(fmt, buf.slice(offset, offset + struct.sizeOf(fmt)));

    return {
        ptr: offset,
        prev_ptr: p[0],
        next_ptr: p[1],
        data_ptr: p[2],
        n_data: p[3],
        counter: p[4],

        datatypeA: p[5],
        datatype: p[6],
        rec_freq: p[7],

        shift: p[8],
        mul: p[9],
        scale: p[10],
        dec_places: p[11],

        name: p[12],
        unit: p[13],
        short_name: p[14]
    };
}

function getByteSize(dtype) {
    switch (dtype) {
        case 'float16': return 2;
        case 'float32': return 4;
        case 'int16': return 2;
        case 'int32': return 4;
        default: throw new Error(`Unknown data type: ${dtype}`);
    }
}

function readChannelData(ch, buf) {
    let dtypeNode;
    if (ch.datatypeA === 0x07) {
        dtypeNode = [null, 'float16', null, 'float32'][ch.datatype - 1];
    } else if ([0, 0x03, 0x05].includes(ch.datatypeA)) {
        dtypeNode = [null, 'int16', null, 'int32'][ch.datatype - 1];
    } else {
        dtypeNode = null;
    }
    ch.dtypeNode = dtypeNode;

    const dataBuffer = buf.slice(ch.data_ptr, ch.data_ptr + ch.n_data * getByteSize(dtypeNode));
    return parseData(dataBuffer, dtypeNode, ch);
}

function  parseData(buffer, dtype, ch) {
    let data;
    switch (dtype) {
        case 'float32':
            data = struct.unpack('<' + 'f'.repeat(ch.n_data), buffer);
            break;
        case 'int16':
            data = struct.unpack('<' + 'h'.repeat(ch.n_data), buffer);
            break;
        case 'int32':
            data = struct.unpack('<' + 'i'.repeat(ch.n_data), buffer);
            break;
        case 'float16':
            // Node.js doesn't natively support Float16. You might need a custom implementation or library.
            throw new Error('Float16 not supported in this implementation');
        default:
            throw new Error(`Unsupported data type: ${dtype}`);
    }

    return Array.from(data).map(val => 
        (val / ch.scale * Math.pow(10, -ch.dec_places) + ch.shift) * ch.mul
    );
}

function readEvent(buf, offset) {
    const fmt = '<64s64s1024sH';

    const p = struct.unpack(fmt, buf.slice(offset, offset + struct.sizeOf(fmt)));
    return {
        name: p[0],
        session: p[1],
        comment: p[2],
        venue_ptr: p[3]
    };
}

function readVenue(buf, offset) {
    const fmt = '<64s1034xH';

    const p = struct.unpack(fmt, buf.slice(offset, offset + struct.sizeOf(fmt)));
    return {
        name: p[0],
        vehicle_ptr: p[1],
    };
}

function readVehicle(buf, offset) {
    const fmt = '<64s128xI32s32s';

    const p = struct.unpack(fmt, buf.slice(offset, offset + struct.sizeOf(fmt)));
    return {
        id: p[0], 
        weight: p[1], 
        type: p[2], 
        comment: p[3]
    };
}

async function start() {

    console.log("Reading file...", TEST_FILENAME);

    const parsed = await readLdFile(TEST_FILENAME);

    console.log(inspect(parsed, { depth: null, colors: true }));
    fs.writeFile("parsed/data.json", JSON.stringify(parsed, null, 2));
}


start();