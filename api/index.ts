import type { IncomingMessage, ServerResponse } from "node:http";
import rawHandler from "./handler.mjs";

const handler = rawHandler as (req: IncomingMessage, res: ServerResponse) => unknown;

export default handler;
