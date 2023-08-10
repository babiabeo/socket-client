# WS Client

A simple WebSocket client for [Deno](https://deno.com/runtime),
inspired by [pogsocket](https://github.com/dimensional-fun/pogsocket) and [v-websocket](https://github.com/vlang/v/tree/master/vlib/net/websocket).

## Usage

```ts
import { ... } from "https://deno.land/x/socket_client@VERSION/mod.ts";
```

**Note**
> Require `--allow-read` and `--allow-net` flags.

## Example

```ts
import { WSClient, OpCode } from "https://deno.land/x/socket_client@VERSION/mod.ts";

const client = new WSClient({
  uri: "ws://localhost:80/"
});

client.onmessage = (_, message) => {
  if (message.opcode === OpCode.TextFrame) {
    console.log(new TextDecoder().decode(message.payload));
  }
};

await client.connect();
client.sendMessage("ping");
```

## Links

- [API Documentation](https://deno.land/x/socket_client/mod.ts)
- [WebSocket Protocol](https://www.rfc-editor.org/rfc/rfc6455.html)

## License

MIT License. See [LICENSE](./LICENSE)
