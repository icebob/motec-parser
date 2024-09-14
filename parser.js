const { inspect } = require('util');
const fs = require("fs").promises;
const struct = require("python-struct");
const { convertXML } = require("simple-xml-to-json");

class LDXParser {
  constructor() {
    this.clear();
  }

  clear() {
    this.buf = null;
    this.data = {};
  }

  async load(filename) {
    this.clear();

    await this.readLdxFile(filename);
    Object.assign(this.data, await this.readLdFile(filename.substring(0, filename.length - 1)));
  }

  async readLdxFile(filename) {
    const xml = await fs.readFile(filename, "utf8");

    const json = convertXML(xml);

    // console.log(inspect(json, { depth: null, colors: true }));

    this.data.beacons =
      json.LDXFile.children[0].Layers.children[0].Layer.children[0].MarkerBlock.children[0].MarkerGroup.children.map(
        (child) => {
          return Number(child.Marker.Time) / 1e6;
        }
      );

    json.LDXFile.children[0].Layers.children[1].Details.children.forEach(child => {
        if (child.String.Id == "Total Laps") {
            this.data.totalLaps = Number(child.String.Value);
        } else if (child.String.Id == "Fastest Time") {
            this.data.fastestTime = child.String.Value;
        } else if (child.String.Id == "Fastest Lap") {
            this.data.fastestLap = Number(child.String.Value);
        }
    });
  }

  async readLdFile(filePath) {
    this.buf = await fs.readFile(filePath);

    const header = this.readHeader();

    let event;
    if (header.event_ptr !== 0) {
      event = this.readEvent(header.event_ptr);

      if (event.venue_ptr !== 0) {
        event.venue = this.readVenue(event.venue_ptr);

        if (event.venue.vehicle_ptr !== 0) {
          event.venue.vehicle = this.readVehicle(event.venue.vehicle_ptr);
        }
      }
    }

    let channels = [];
    if (header.chann_meta_ptr !== 0) {
      let ptr = header.chann_meta_ptr;
      while (true) {
        const ch = this.readChannel(ptr);

        if (ch.data_ptr !== 0) {
          ch.data = this.readChannelData(ch);

        //   await fs.writeFile(
        //     `parsed/data-${ch.name}.txt`,
        //     ch.data.join("\r\n")
        //   );
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

  readHeader() {
    const fmt =
      "<" +
      "I4x" + // ldmarker
      "II" + // chann_meta_ptr chann_data_ptr
      "20x" + // ?
      "I" + // event_ptr
      "24x" + // ?
      "HHH" + // unknown static (?) numbers
      "I" + // device serial
      "8s" + // device type
      "H" + // device version
      "H" + // unknown static (?) number
      "I" + // num_channs
      "4x" + // ?
      "16s" + // date
      "16x" + // ?
      "16s" + // time
      "16x" + // ?
      "64s" + // driver
      "64s" + // vehicleid
      "64x" + // ?
      "64s" + // venue
      "64x" + // ?
      "1024x" + // ?
      "I" + // enable "pro logging" (some magic number?)
      "2x" + // ?
      "64s" + // session
      "64s" + // short comment
      "126x"; // ?

    const head = struct.unpack(fmt, this.buf);

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
      time: head[13],
      driver: head[14],
      vehicleid: head[15],
      venue: head[16],
      pro_logging: head[17],
      session: head[8],
      short_comment: head[19],
    };
  }

  readChannel(offset) {
    const fmt =
      "<" +
      "IIII" + // prev_addr next_addr data_ptr n_data
      "H" + // some counter?
      "HHH" + // datatype datatype rec_freq
      "hhhh" + // shift mul scale dec_places
      "32s" + // name
      "8s" + // short name
      "12s" + // unit
      "40x"; // ? (40 bytes for ACC, 32 bytes for acti)

    const p = struct.unpack(
      fmt,
      this.buf.subarray(offset, offset + struct.sizeOf(fmt))
    );

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
      short_name: p[13],
      unit: p[14],
    };
  }

  getByteSize(dtype) {
    switch (dtype) {
      case "float16":
        return 2;
      case "float32":
        return 4;
      case "int16":
        return 2;
      case "int32":
        return 4;
      default:
        throw new Error(`Unknown data type: ${dtype}`);
    }
  }

  readChannelData(ch) {
    let dtypeNode;
    if (ch.datatypeA === 0x07) {
      dtypeNode = [null, "float16", null, "float32"][ch.datatype - 1];
    } else if ([0, 0x03, 0x05].includes(ch.datatypeA)) {
      dtypeNode = [null, "int16", null, "int32"][ch.datatype - 1];
    } else {
      dtypeNode = null;
    }
    ch.dtypeNode = dtypeNode;

    const dataBuffer = this.buf.subarray(
      ch.data_ptr,
      ch.data_ptr + ch.n_data * this.getByteSize(dtypeNode)
    );
    return this.parseData(dataBuffer, dtypeNode, ch);
  }

  parseData(buffer, dtype, ch) {
    let data;
    switch (dtype) {
      case "float32":
        data = struct.unpack("<" + "f".repeat(ch.n_data), buffer);
        break;
      case "int16":
        data = struct.unpack("<" + "h".repeat(ch.n_data), buffer);
        break;
      case "int32":
        data = struct.unpack("<" + "i".repeat(ch.n_data), buffer);
        break;
      case "float16":
        // Node.js doesn't natively support Float16. You might need a custom implementation or library.
        throw new Error("Float16 not supported in this implementation");
      default:
        throw new Error(`Unsupported data type: ${dtype}`);
    }

    return Array.from(data).map(
      (val) =>
        ((val / ch.scale) * Math.pow(10, -ch.dec_places) + ch.shift) * ch.mul
    );
  }

  readEvent(offset) {
    const fmt = "<64s64s1024sH";

    const p = struct.unpack(
      fmt,
      this.buf.subarray(offset, offset + struct.sizeOf(fmt))
    );
    return {
      name: p[0],
      session: p[1],
      comment: p[2],
      venue_ptr: p[3],
    };
  }

  readVenue(offset) {
    const fmt = "<64s1034xH";

    const p = struct.unpack(
      fmt,
      this.buf.subarray(offset, offset + struct.sizeOf(fmt))
    );
    return {
      name: p[0],
      vehicle_ptr: p[1],
    };
  }

  readVehicle(offset) {
    const fmt = "<64s128xI32s32s";

    const p = struct.unpack(
      fmt,
      this.buf.subarray(offset, offset + struct.sizeOf(fmt))
    );
    return {
      id: p[0],
      weight: p[1],
      type: p[2],
      comment: p[3],
    };
  }
}

module.exports = LDXParser;
