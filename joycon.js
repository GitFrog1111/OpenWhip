// joycon.js
const EventEmitter = require('events');
const HID = require('node-hid');

class JoyConModule extends EventEmitter {
  constructor() {
    super();
    this.device = null;
    this.gravity = { x: 0, y: 0, z: 0 };
    this.filterCoeff = 0.8;
    this.lastAState = false;
    this._processData = this._processData.bind(this);
  }

  startListening() {
    try {
      // nintendo vendor id
      const devices = HID.devices().filter(d => d.vendorId === 1406); 
      if (devices.length === 0) {
        return false;
      }

      this.device = new HID.HID(devices[0].path);

      // Wake up and enable IMU (Standard Full Mode 0x30)
      this.device.write([0x01, 0x00, 0x00, 0x01, 0x40, 0x40, 0x00, 0x01, 0x40, 0x40, 0x03, 0x30]);
      this.device.write([0x01, 0x01, 0x00, 0x01, 0x40, 0x40, 0x00, 0x01, 0x40, 0x40, 0x40, 0x01]);

      this.device.on("data", (data) => this._processData(data));
      return true;
    } catch (err) {
      return false;
    }
  }

  _processData(data) {
    if (data[0] !== 0x30) return;

    // ── 1. READ BUTTONS (Byte 3 contains Y, X, B, A for Right Joy-Con) ──
    // The A button is the 4th bit (0x08)
    const currentAState = (data[3] & 0x08) !== 0;

    // Check for "Falling Edge" (Button just got pressed down)
    if (currentAState && !this.lastAState) {
      this.emit('buttonA');
    }
    this.lastAState = currentAState;

    // Loop through all 3 internal high-frequency sub-frames (spaced 5ms apart)
    const frameOffsets = [13, 25, 37];

    for (const offset of frameOffsets) {
      const rawAccX = data.readInt16LE(offset);
      const rawAccY = data.readInt16LE(offset + 2);
      const rawAccZ = data.readInt16LE(offset + 4);
      const gyroPitch = data.readInt16LE(offset + 8);

      // High-Pass Filter: Isolates gravity from true moving force
      this.gravity.x = this.filterCoeff * this.gravity.x + (1 - this.filterCoeff) * rawAccX;
      this.gravity.y = this.filterCoeff * this.gravity.y + (1 - this.filterCoeff) * rawAccY;
      this.gravity.z = this.filterCoeff * this.gravity.z + (1 - this.filterCoeff) * rawAccZ;
      
      const userAccZ = rawAccZ - this.gravity.z;

      // Threshold evaluations
      const violentForwardThrust = userAccZ < -3500; 
      const crispWristSnap = Math.abs(gyroPitch) > 5000;

      if (violentForwardThrust && crispWristSnap) {
        this.emit('whip');
        break;
      }
    }
  }
}

module.exports = new JoyConModule();
