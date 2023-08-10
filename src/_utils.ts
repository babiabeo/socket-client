import { base64 } from "../deps.ts";

export function encode(input?: string) {
    return new TextEncoder().encode(input);
}

export function decode(input?: BufferSource) {
    return new TextDecoder().decode(input);
}

export async function getAcceptKey(seckey: string) {
    const guid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    const key = await crypto.subtle.digest(
        "SHA-1",
        encode(seckey + guid),
    );

    return base64.encode(key);
}

export function createSecKey() {
    const key = new Uint8Array(16);
    crypto.getRandomValues(key);

    return base64.encode(key);
}

export function createMaskingKey() {
    const key = new Uint8Array(4);
    crypto.getRandomValues(key);

    return key;
}

export function unmask(data: Uint8Array, maskingKey: Uint8Array) {
    for (let i = 0; i < data.length; i++) {
        data[i] ^= maskingKey[i % 4];
    }
}
