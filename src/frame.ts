import { unmask } from "./_utils.ts";
import { assert, BufReader, readLong, readShort } from "../deps.ts";

export enum OpCode {
    Continuation = 0x0,
    TextFrame = 0x1,
    BinaryFrame = 0x2,
    Close = 0x8,
    Ping = 0x9,
    Pong = 0xA,
}

export enum CloseCode {
    NormalClosure = 1000,
    GoingAway,
    ProtocolError,
    CannotAccept,
    NoStatusCode = 1005,
    AbnormalClose,
    InconsistentType,
    PolicyViolation,
    MessageTooBig,
    DenyExtension,
    InternalError,
    BadTLSHandshake = 1015,
}

/** Whether the given opcode is control. */
export function isCtrl(opcode: OpCode) {
    const ctrl = [OpCode.Close, OpCode.Ping, OpCode.Pong];
    return ctrl.includes(opcode);
}

/** Whether the given opcode is non-control. */
export function isNonCtrl(opcode: OpCode) {
    const nonCtrl = [OpCode.TextFrame, OpCode.BinaryFrame];
    return nonCtrl.includes(opcode);
}

export interface FrameData {
    /** Indicates that this is the final fragment in a message */
    fin: boolean;
    /** Reversed for future use. */
    rsv1: boolean;
    /** Reversed for future use. */
    rsv2: boolean;
    /** Reversed for future use. */
    rsv3: boolean;
    /** The interpretation of the payload data. */
    opcode: OpCode;
    /** Whether the payload data is masked. */
    masked: boolean;
    /** The length of the payload data. */
    payloadLen: number;
    /** The key used to mask all frames sent from the client to the websocket. */
    maskingKey?: Uint8Array;
}

export class Frame {
    /** Indicates that this is the final fragment in a message */
    fin: boolean;
    /** Reversed for future use. */
    rsv1: boolean;
    /** Reversed for future use. */
    rsv2: boolean;
    /** Reversed for future use. */
    rsv3: boolean;
    /** The interpretation of the payload data. */
    opcode: OpCode;
    /** Whether the payload data is masked. */
    masked: boolean;
    /** The length of the payload data. */
    payloadLen: number;
    /** The key used to mask all frames sent from the client to the websocket. */
    maskingKey?: Uint8Array;

    constructor(data: FrameData) {
        this.fin = data.fin;
        this.rsv1 = data.rsv1;
        this.rsv2 = data.rsv2;
        this.rsv3 = data.rsv3;
        this.opcode = data.opcode;
        this.masked = data.masked;
        this.payloadLen = data.payloadLen;
        this.maskingKey = data.maskingKey;
    }

    /** Check if the frame data is valid. */
    validate() {
        if (this.rsv1 || this.rsv2 || this.rsv3) {
            throw new Error(`"rsv" must be 0, not negotiated`);
        }

        if (
            0x3 <= this.opcode && this.opcode <= 0x7 ||
            0xB <= this.opcode && this.opcode <= 0xF
        ) {
            throw new Error(`Found reversed frame: ${this.opcode}`);
        }

        if (isCtrl(this.opcode)) {
            if (this.payloadLen > 125) {
                throw new RangeError(
                    `Frame data length must be 125 or less (actual: ${this.payloadLen})`,
                );
            }

            if (!this.fin) {
                throw new Error("Control frame must not be fragmented");
            }
        }
    }

    /** Read the payload data from the websocket. */
    async readPayload(reader: BufReader) {
        if (this.payloadLen === 0) {
            return new Uint8Array();
        }

        const data = new Uint8Array(this.payloadLen);
        assert(
            await reader.readFull(data) !== null,
            "Failed to read frame payload",
        );

        if (this.masked && this.maskingKey) {
            unmask(data, this.maskingKey);
        }

        return data;
    }

    /** Parse a frame from the websocket. */
    static async parse(reader: BufReader) {
        let byte = await reader.readByte();
        assert(byte !== null, "Cannot read the first byte");

        const fin = (byte & 0x80) === 0x80;
        const rsv1 = (byte & 0x40) === 0x40;
        const rsv2 = (byte & 0x20) === 0x20;
        const rsv3 = (byte & 0x10) === 0x10;
        const opcode = byte & 0x7F;

        byte = await reader.readByte();
        assert(byte !== null, "Cannot read the second byte");

        const hasMask = (byte & 0x80) === 0x80;
        let payloadLen = byte & 0x7F;

        if (payloadLen === 126) {
            const len = await readShort(reader);
            assert(len !== null);

            payloadLen = len;
        } else if (payloadLen === 127) {
            const len = await readLong(reader);
            assert(len !== null);

            payloadLen = len;
        }

        let maskingKey: Uint8Array | undefined;
        if (hasMask) {
            const data = new Uint8Array(4);
            assert(
                await reader.readFull(data) !== null,
                "Cannot read masking key",
            );

            maskingKey = data;
        }

        // deno-fmt-ignore
        return new Frame({
            fin, rsv1, rsv2, rsv3,
            opcode, masked: hasMask,
            maskingKey, payloadLen
        });
    }
}
