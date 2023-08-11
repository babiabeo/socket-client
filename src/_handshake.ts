import { BufReader, concat } from "../deps.ts";
import { createSecKey, encode, getAcceptKey } from "./_utils.ts";
import { WSClient } from "./client.ts";

export async function handshake(ws: WSClient) {
    const { hostname, search, pathname } = ws.uri;
    const seckey = createSecKey();

    if (!ws.headers.has("Host")) {
        ws.headers.set("Host", hostname);
    }

    ws.headers.set("Upgrade", "websocket");
    ws.headers.set("Connection", "Upgrade");
    ws.headers.set("Sec-WebSocket-Key", seckey);
    ws.headers.set("Sec-WebSocket-Version", "13");

    let request = `GET ${pathname}${search} HTTP/1.1\r\n`;
    for (const [key, value] of ws.headers) {
        request += `${key}: ${value}\r\n`;
    }
    request += "\r\n";

    await ws.writer.write(encode(request));
    await ws.writer.flush();

    let firstLine = true;
    let flags = 0;
    for await (const line of readLines(ws.reader)) {
        if (firstLine) {
            if (!line.startsWith("HTTP/1.1 101")) {
                ws.logger.error(`server does not accept handshake: ${line}`);
                throw new Error(`Server does not accept handshake: ${line}`);
            }

            firstLine = false;
            continue;
        }

        if (line === "\r\n" || line.length === 0) break;

        const header = line.split(":").map((s) => s.trim());
        switch (header[0].toLowerCase()) {
            case "upgrade":
            case "connection":
                flags++;
                break;
            case "sec-websocket-accept": {
                const expect = await getAcceptKey(seckey);
                const actual = header[1];
                if (actual !== expect) {
                    ws.logger.error(`unexpected "Sec-WebSocket-Accept" value`);
                    ws.onerror(
                        ws,
                        new Error(`unexpected "Sec-WebSocket-Accept" value`),
                    );
                    throw new Error(
                        `Unexpected "Sec-WebSocket-Accept" value\n- Expect: ${expect}\n- Actual: ${actual}`,
                    );
                }

                flags++;
            }
        }
    }

    if (flags < 3) {
        ws.logger.error("unacceptable handshake");
        ws.onerror(ws, new Error("unacceptable handshake"));
        throw new Error("Unacceptable handshake");
    }
}

// Based on: https://github.com/denoland/deno_std/blob/cf14c9b21234f8d99ac1ae819d912e98de47be9c/io/read_lines.ts
async function* readLines(
    reader: BufReader,
): AsyncIterableIterator<string> {
    let chunks: Uint8Array[] = [];
    const decoder = new TextDecoder("utf-8");

    while (true) {
        const res = await reader.readLine();
        if (!res) {
            if (chunks.length > 0) {
                yield decoder.decode(concat(...chunks));
            }
            break;
        }

        chunks.push(res.line);

        if (!res.more) {
            yield decoder.decode(concat(...chunks));
            chunks = [];
        }
    }
}
