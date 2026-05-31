import type { IncomingMessage, ServerResponse } from "node:http";

declare const handler: (req: IncomingMessage, res: ServerResponse) => unknown;

export default handler;
