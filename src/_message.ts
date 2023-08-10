import { WSClient } from "./client.ts";
import { Frame, isCtrl, isNonCtrl, OpCode } from "./frame.ts";

export interface Message {
    opcode: OpCode;
    payload: Uint8Array;
}

function getTotalLen(fragments: Message[]) {
    return fragments.reduce((len, mes) => len + mes.payload.length, 0);
}

export async function readMessage(ws: WSClient) {
    try {
        for (;;) {
            const frame = await Frame.parse(ws.reader);
            frame.validate();

            const framePayload = await frame.readPayload(ws.reader);
            if (isCtrl(frame.opcode)) {
                const msg: Message = {
                    opcode: frame.opcode,
                    payload: framePayload,
                };
                return msg;
            }

            if (!frame.fin) {
                ws.fragments.push({
                    opcode: frame.opcode,
                    payload: framePayload,
                });
                continue;
            }

            if (ws.fragments.length === 0) {
                const msg: Message = {
                    opcode: frame.opcode,
                    payload: framePayload,
                };
                return msg;
            }

            if (isNonCtrl(frame.opcode)) {
                ws.close({ code: 0, reason: "" });
                return null;
            }

            let offset = 0;
            const data = new Uint8Array(
                getTotalLen(ws.fragments) + framePayload.length,
            );
            for (const mes of ws.fragments) {
                data.set(mes.payload, offset);
                offset += mes.payload.length;
            }
            data.set(framePayload, offset);

            const msg: Message = {
                opcode: ws.fragments[0].opcode,
                payload: data,
            };

            ws.fragments = [];
            return msg;
        }
    } catch (_) {
        return null;
    }
}
