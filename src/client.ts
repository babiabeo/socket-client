import { handshake } from "./_handshake.ts";
import { createMaskingKey, encode, unmask } from "./_utils.ts";
import { CloseCode, OpCode } from "./frame.ts";
import {
    BufReader,
    BufWriter,
    concat,
    LevelName,
    Logger,
    LogHandlers,
    sliceLongToBytes,
} from "../deps.ts";
import { Message, readMessage } from "./_message.ts";

export enum WSState {
    CONNECTING,
    OPEN,
    CLOSING,
    CLOSED,
}

export interface WSConfig {
    uri: string | URL;
    headers?: HeadersInit;
    logger?: Logger;
    logLevel?: LevelName;
}

export interface WSOpenEvent {
    (client: WSClient): unknown;
}

export interface WSCloseEvent {
    (client: WSClient, code: number, reason?: string): unknown;
}

export interface WSErrorEvent {
    (client: WSClient, error: Error): unknown;
}

export interface WSMessageEvent {
    (client: WSClient, message: Message): unknown;
}

export class WSClient {
    #conn: Deno.Conn = undefined!;
    #writer: BufWriter = undefined!;
    #reader: BufReader = undefined!;

    uri: URL;
    state: WSState;
    fragments: Message[];
    headers: Headers;
    lastPong: number;
    logger: Logger;

    onopen: WSOpenEvent;
    onerror: WSErrorEvent;
    onmessage: WSMessageEvent;
    onclose: WSCloseEvent;

    constructor(config: WSConfig) {
        this.uri = new URL(config.uri);
        this.headers = new Headers(config.headers);
        this.state = WSState.CLOSED;
        this.fragments = [];
        this.lastPong = 0;
        this.logger = this.#getLogger(config.logger, config.logLevel);
        this.onopen = () => undefined;
        this.onerror = () => undefined;
        this.onmessage = () => undefined;
        this.onclose = () => undefined;
    }

    #getLogger(logger?: Logger, level?: LevelName) {
        return logger ?? new Logger("ws_client", level ?? "INFO", {
            handlers: [
                new LogHandlers.ConsoleHandler(level ?? "INFO", {
                    formatter:
                        "[{loggerName}]  {datetime}  {levelName} :: {msg}",
                }),
            ],
        });
    }

    get conn() {
        return this.#conn;
    }

    get writer() {
        return this.#writer;
    }

    get reader() {
        return this.#reader;
    }

    async connect() {
        if (this.state !== WSState.CLOSED) {
            throw new Deno.errors.ConnectionRefused(
                `The client state is: ${WSState[this.state]}`,
            );
        }

        const calledAt = Date.now();
        this.logger.info(`connecting to server: ${this.uri}`);
        this.state = WSState.CONNECTING;

        switch (this.uri.protocol) {
            case "ws:":
            case "http:":
                this.#conn = await Deno.connect({
                    hostname: this.uri.hostname,
                    port: +(this.uri.port || 80),
                });
                break;
            case "wss:":
            case "https:":
                this.#conn = await Deno.connectTls({
                    hostname: this.uri.hostname,
                    port: +(this.uri.port || 443),
                });
                break;
            default:
                this.logger.error(`unsupported protocol: ${this.uri.protocol}`);
                throw new Deno.errors.ConnectionRefused(
                    `Unsupported protocol: ${this.uri.protocol}`,
                );
        }

        this.#writer = new BufWriter(this.#conn);
        this.#reader = new BufReader(this.#conn);

        try {
            await handshake(this);
        } catch (e) {
            this.logger.error("unable to do handshake");
            this.#conn.close();
            throw e;
        }

        const startedAt = Date.now();
        this.state = WSState.OPEN;
        this.logger.info(
            `successfully connected to ${this.uri} (took: ${
                startedAt - calledAt
            }ms)`,
        );
        this.onopen(this);
        this.#listen();
    }

    async #listen() {
        this.logger.info("starting to listen to server...");

        while (this.state === WSState.OPEN) {
            const msg = await readMessage(this);
            if (!msg) {
                this.logger.debug("failed to read message");
                this.onerror(this, new Error("failed to read message"));
                break;
            }

            switch (msg.opcode) {
                case OpCode.TextFrame:
                case OpCode.BinaryFrame:
                    this.logger.debug(
                        `received ${
                            msg.opcode === OpCode.TextFrame ? "text" : "binary"
                        } message`,
                    );
                    this.onmessage(this, msg);
                    break;

                case OpCode.Pong:
                    this.lastPong = Date.now();
                    this.logger.debug(`received pong`);
                    this.onmessage(this, msg);
                    break;

                case OpCode.Ping:
                    this.logger.debug(`received ping`);
                    await this.sendFrame(OpCode.Pong, msg.payload);
                    break;

                case OpCode.Close:
                    this.logger.debug(`received close opcode`);
                    await this.close();
                    break;

                case OpCode.Continuation:
                    this.logger.error("unexpected opcode continuation");
                    this.onerror(
                        this,
                        new Error("unexpected opcode continuation"),
                    );
                    await this.close({
                        code: CloseCode.ProtocolError,
                        reason: "nothing to continue",
                    });
                    break;
            }
        }

        this.logger.info("stop listening to server...");
        this.close();
    }

    async sendFrame(opcode: OpCode, data: Uint8Array) {
        if (this.state !== WSState.OPEN && this.state !== WSState.CLOSING) {
            this.logger.error("client is not connected");
            throw new Deno.errors.NotConnected("Client is not connected");
        }

        const len = data.byteLength;
        const maskingKey = createMaskingKey();
        let header: Uint8Array;

        if (len < 126) {
            header = new Uint8Array([opcode | 0x80, len | 0x80]);
        } else if (len < 0xFFFF) {
            header = new Uint8Array([
                opcode | 0x80,
                126 | 0x80,
                len >> 8,
                len & 0xFF,
            ]);
        } else if (len <= 0x7FFFFFFF) {
            header = new Uint8Array([
                opcode | 0x80,
                127 | 0x80,
                ...sliceLongToBytes(len),
            ]);
        } else {
            return this.close({
                code: CloseCode.MessageTooBig,
                reason: "Frame too large",
            });
        }

        header = concat(header, maskingKey);
        const frameBuf = new Uint8Array(data);

        unmask(frameBuf, maskingKey);
        header = concat(header, frameBuf);

        await this.writer.write(header);
        await this.writer.flush();
    }

    sendMessage(mes: string | Uint8Array) {
        if (typeof mes === "string") {
            return this.sendFrame(OpCode.TextFrame, encode(mes));
        }

        return this.sendFrame(OpCode.BinaryFrame, mes);
    }

    async close(options: CloseOptions = {}) {
        if (this.state === WSState.CLOSING || this.state === WSState.CLOSED) {
            return;
        }

        this.logger.info("closing websocket connection...");
        try {
            const closeCode = options.code ?? CloseCode.NormalClosure;
            const closeReason = encode(options.reason ?? "Closed by client");

            this.state = WSState.CLOSING;

            let closeFrame: Uint8Array;
            if (closeCode > 0) {
                closeFrame = new Uint8Array(closeReason.byteLength + 2);
                closeFrame.set([closeCode >> 8, closeCode & 0xFF]);
                closeFrame.set(closeReason, 2);
            } else {
                closeFrame = new Uint8Array();
            }

            await this.sendFrame(OpCode.Close, closeFrame);
        } catch (e) {
            this.logger.error("unable to send close frame");
            throw e;
        } finally {
            this.fragments = [];
            this.conn.close();
            this.state = WSState.CLOSED;
            this.logger.info("closed websocket connection");
        }
    }
}

export interface CloseOptions {
    code?: number;
    reason?: string;
}
